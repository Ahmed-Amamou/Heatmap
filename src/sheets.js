const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { app } = require('electron');
const { upsertMany } = require('./db');

// Sheet header text (normalized) → DB field. Column A is always job_title
// (it has no header in the sheet), so it's handled by position separately.
const HEADER_MAP = {
  description: 'description',
  company: 'company',
  location: 'location',
  jobtype: 'job_type',
  applyingdate: 'applying_date',
  resumeversion: 'resume_version',
  status: 'status',
  contact: 'contact',
  notes: 'notes',
  id: 'id',
};

function normalizeHeader(text) {
  return String(text || '').toLowerCase().replace(/[^a-z]/g, '');
}

function columnToLetter(index) {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

function getCredentialsPath() {
  const userDataPath = path.join(app.getPath('userData'), 'credentials.json');
  if (fs.existsSync(userDataPath)) return userDataPath;

  const rootPath = path.join(__dirname, '..', 'credentials.json');
  if (fs.existsSync(rootPath)) return rootPath;

  return null;
}

async function getSheetsClient() {
  const credentialsPath = getCredentialsPath();
  if (!credentialsPath) {
    throw new Error('No credentials.json found. Open Settings to import your Google Service Account key.');
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    // Read-write scope: needed to seed the ID column for sync matching.
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const authClient = await auth.getClient();
  return google.sheets({ version: 'v4', auth: authClient });
}

function createImporter(config) {
  return async function importFromSheet() {
    if (!config.spreadsheetId) {
      throw new Error('No Spreadsheet ID configured. Open Settings to set it up.');
    }

    const sheets = await getSheetsClient();
    const sheetName = config.sheetName || 'Sheet1';

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: `${sheetName}!A:Z`,
    });

    const rows = response.data.values;
    if (!rows || rows.length < 2) {
      return { imported: 0, seeded: 0 };
    }

    const header = rows[0];

    // Build column index → DB field map.
    // Column A (index 0) is always job_title regardless of its header.
    const colToField = { 0: 'job_title' };
    let idColIndex = -1;

    for (let c = 1; c < header.length; c++) {
      const field = HEADER_MAP[normalizeHeader(header[c])];
      if (field === 'id') {
        idColIndex = c;
      } else if (field) {
        colToField[c] = field;
      }
    }

    // No ID column yet → it will be appended after the last existing column.
    const appendingIdColumn = idColIndex === -1;
    if (appendingIdColumn) idColIndex = header.length;

    const apps = [];
    const idWriteback = []; // { rowNumber, id } for rows missing an ID

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];

      const appData = {};
      for (const [colIndex, field] of Object.entries(colToField)) {
        const raw = row[colIndex];
        if (field === 'applying_date') {
          const d = parseDate(raw);
          appData[field] = d ? formatDateKey(d) : null;
        } else {
          appData[field] = raw != null ? String(raw).trim() : null;
        }
      }

      // Skip fully empty rows.
      if (!appData.job_title && !appData.company && !appData.applying_date) continue;

      let id = row[idColIndex] ? String(row[idColIndex]).trim() : '';
      if (!id) {
        id = randomUUID();
        idWriteback.push({ rowNumber: r + 1, id }); // sheet rows are 1-based
      }
      appData.id = id;

      apps.push(appData);
    }

    upsertMany(apps);

    // Seed generated IDs back into the sheet for future sync matching.
    let seeded = 0;
    if (idWriteback.length > 0) {
      const idColLetter = columnToLetter(idColIndex);
      const data = idWriteback.map(({ rowNumber, id }) => ({
        range: `${sheetName}!${idColLetter}${rowNumber}`,
        values: [[id]],
      }));

      // Add the header label if we created a new ID column.
      if (appendingIdColumn) {
        data.push({ range: `${sheetName}!${idColLetter}1`, values: [['ID']] });
      }

      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: config.spreadsheetId,
        requestBody: { valueInputOption: 'RAW', data },
      });
      seeded = idWriteback.length;
    }

    return { imported: apps.length, seeded };
  };
}

function parseDate(raw) {
  const str = String(raw || '').trim();
  if (!str) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d = new Date(str + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }

  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str)) {
    const parts = str.split('/');
    const d = new Date(parts[2], parts[0] - 1, parts[1]);
    return isNaN(d.getTime()) ? null : d;
  }

  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(str)) {
    const parts = str.split('-');
    const d = new Date(parts[2], parts[1] - 1, parts[0]);
    return isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = { createImporter };
