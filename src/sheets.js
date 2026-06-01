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

const MONTHS_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function normalizeHeader(text) {
  return String(text || '').toLowerCase().replace(/[^a-z]/g, '');
}

// Write dates to the sheet as e.g. "1-Jun-2026" to match the sheet's format,
// rather than the ISO form used internally. Non-ISO values pass through.
function formatSheetDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
  if (!m) return iso != null ? String(iso) : '';
  return `${parseInt(m[3], 10)}-${MONTHS_ABBR[parseInt(m[2], 10) - 1]}-${m[1]}`;
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

// Map DB fields to sheet column indices from the header row.
// Column A (index 0) is always job_title regardless of its header text.
function buildColumnMap(header) {
  const fieldToCol = { job_title: 0 };
  let idColIndex = -1;
  let maxCol = 0;

  for (let c = 1; c < header.length; c++) {
    const field = HEADER_MAP[normalizeHeader(header[c])];
    if (field === 'id') {
      idColIndex = c;
    } else if (field) {
      fieldToCol[field] = c;
    }
    maxCol = c;
  }

  if (idColIndex === -1) idColIndex = maxCol + 1;
  return { fieldToCol, idColIndex, lastCol: Math.max(maxCol, idColIndex) };
}

// Two-way sync: push local edits/deletes back to the sheet, matched by the ID
// column the importer seeds. Rows are located by ID, never by position.
function createSyncer(config) {
  async function getSheetId(sheets, sheetName) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
      fields: 'sheets.properties',
    });
    const sheet = (meta.data.sheets || []).find(
      (s) => s.properties.title === sheetName
    );
    return sheet ? sheet.properties.sheetId : null;
  }

  function buildRowArray(appData, fieldToCol, idColIndex, lastCol) {
    const arr = new Array(lastCol + 1).fill('');
    for (const [field, col] of Object.entries(fieldToCol)) {
      if (field === 'applying_date') {
        arr[col] = formatSheetDate(appData[field]);
      } else {
        arr[col] = appData[field] != null ? String(appData[field]) : '';
      }
    }
    arr[idColIndex] = appData.id;
    return arr;
  }

  async function readRows(sheets, sheetName) {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: `${sheetName}!A:Z`,
    });
    return resp.data.values || [];
  }

  function findRowNumber(rows, idColIndex, id) {
    for (let r = 1; r < rows.length; r++) {
      const cell = rows[r][idColIndex];
      if (cell && String(cell).trim() === id) return r + 1; // 1-based
    }
    return -1;
  }

  return {
    async upsertRow(appData) {
      if (!config.spreadsheetId) return;
      const sheets = await getSheetsClient();
      const sheetName = config.sheetName || 'Sheet1';

      const rows = await readRows(sheets, sheetName);
      const header = rows[0] || [];
      const { fieldToCol, idColIndex, lastCol } = buildColumnMap(header);

      // Label a freshly created ID column.
      if (!header[idColIndex]) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: config.spreadsheetId,
          range: `${sheetName}!${columnToLetter(idColIndex)}1`,
          valueInputOption: 'RAW',
          requestBody: { values: [['ID']] },
        });
      }

      const rowArr = buildRowArray(appData, fieldToCol, idColIndex, lastCol);
      const rowNumber = findRowNumber(rows, idColIndex, appData.id);

      if (rowNumber > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: config.spreadsheetId,
          range: `${sheetName}!A${rowNumber}:${columnToLetter(lastCol)}${rowNumber}`,
          valueInputOption: 'RAW',
          requestBody: { values: [rowArr] },
        });
      } else {
        await sheets.spreadsheets.values.append({
          spreadsheetId: config.spreadsheetId,
          range: `${sheetName}!A:${columnToLetter(lastCol)}`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          requestBody: { values: [rowArr] },
        });
      }
    },

    async deleteRow(id) {
      if (!config.spreadsheetId) return;
      const sheets = await getSheetsClient();
      const sheetName = config.sheetName || 'Sheet1';

      const rows = await readRows(sheets, sheetName);
      const header = rows[0] || [];
      const { idColIndex } = buildColumnMap(header);

      const rowNumber = findRowNumber(rows, idColIndex, id);
      if (rowNumber < 0) return;

      const sheetId = await getSheetId(sheets, sheetName);
      if (sheetId == null) return;

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.spreadsheetId,
        requestBody: {
          requests: [
            {
              deleteDimension: {
                range: {
                  sheetId,
                  dimension: 'ROWS',
                  startIndex: rowNumber - 1, // 0-based, inclusive
                  endIndex: rowNumber, // exclusive
                },
              },
            },
          ],
        },
      });
    },
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

  // "1-Jun-2026" (the sheet's display format).
  const mon = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(str);
  if (mon) {
    const mi = MONTHS_ABBR.findIndex((m) => m.toLowerCase() === mon[2].toLowerCase());
    if (mi >= 0) {
      const d = new Date(Number(mon[3]), mi, Number(mon[1]));
      return isNaN(d.getTime()) ? null : d;
    }
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

module.exports = { createImporter, createSyncer };
