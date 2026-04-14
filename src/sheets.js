const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// Configuration — update these with your values
const CONFIG = {
  SPREADSHEET_ID: 'process.env.SPREADSHEET_ID', // The ID from your Google Sheet URL
  SHEET_NAME: 'Sheet1',                        // The tab name
  DATE_COLUMN: 'F',                            // Column containing application dates
  CREDENTIALS_PATH: path.join(__dirname, '..', 'credentials.json'),
};

async function getAuthClient() {
  const credentialsPath = CONFIG.CREDENTIALS_PATH;

  if (!fs.existsSync(credentialsPath)) {
    throw new Error(
      'credentials.json not found. Please download your Google Service Account key and place it in the project root.'
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  return auth.getClient();
}

async function fetchApplicationDates() {
  const authClient = await getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth: authClient });

  const range = `${CONFIG.SHEET_NAME}!${CONFIG.DATE_COLUMN}:${CONFIG.DATE_COLUMN}`;

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: CONFIG.SPREADSHEET_ID,
    range,
  });

  const rows = response.data.values;
  if (!rows || rows.length === 0) {
    return {};
  }

  // Skip header row, count applications per date
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
}

function parseDate(raw) {
  // Handle various date formats
  const str = String(raw).trim();

  // Try ISO format (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    const d = new Date(str + 'T00:00:00');
    return isNaN(d.getTime()) ? null : d;
  }

  // Try MM/DD/YYYY or M/D/YYYY
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(str)) {
    const parts = str.split('/');
    const d = new Date(parts[2], parts[0] - 1, parts[1]);
    return isNaN(d.getTime()) ? null : d;
  }

  // Try DD/MM/YYYY
  if (/^\d{1,2}-\d{1,2}-\d{4}$/.test(str)) {
    const parts = str.split('-');
    const d = new Date(parts[2], parts[1] - 1, parts[0]);
    return isNaN(d.getTime()) ? null : d;
  }

  // Fallback: let JS parse it
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function formatDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = { fetchApplicationDates, CONFIG };
