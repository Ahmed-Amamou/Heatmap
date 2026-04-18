const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function getCredentialsPath() {
  // Check userData first (set via settings UI), then project root
  const userDataPath = path.join(app.getPath('userData'), 'credentials.json');
  if (fs.existsSync(userDataPath)) return userDataPath;

  const rootPath = path.join(__dirname, '..', 'credentials.json');
  if (fs.existsSync(rootPath)) return rootPath;

  return null;
}

async function getAuthClient() {
  const credentialsPath = getCredentialsPath();

  if (!credentialsPath) {
    throw new Error('No credentials.json found. Open Settings to import your Google Service Account key.');
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  return auth.getClient();
}

function createFetcher(config) {
  return async function fetchApplicationDates() {
    if (!config.spreadsheetId) {
      throw new Error('No Spreadsheet ID configured. Open Settings to set it up.');
    }

    const authClient = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth: authClient });

    const sheetName = config.sheetName || 'Sheet1';
    const dateColumn = config.dateColumn || 'F';
    const range = `${sheetName}!${dateColumn}:${dateColumn}`;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0) {
      return {};
    }

    const dateCounts = {};

    for (let i = 1; i < rows.length; i++) {
      const raw = rows[i][0];
      if (!raw) continue;

      const date = parseDate(raw);
      if (!date) continue;

      const key = formatDateKey(date);
      dateCounts[key] = (dateCounts[key] || 0) + 1;
    }

    return dateCounts;
  };
}

function parseDate(raw) {
  const str = String(raw).trim();

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

module.exports = { createFetcher };
