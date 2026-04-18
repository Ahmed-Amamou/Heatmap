const spreadsheetIdInput = document.getElementById('spreadsheetId');
const sheetNameInput = document.getElementById('sheetName');
const dateColumnInput = document.getElementById('dateColumn');
const credsStatus = document.getElementById('creds-status');

// Load existing config
(async () => {
  const config = await window.heatmapAPI.getConfig();
  spreadsheetIdInput.value = config.spreadsheetId || '';
  sheetNameInput.value = config.sheetName || 'Sheet1';
  dateColumnInput.value = config.dateColumn || 'F';
})();

// Import credentials
document.getElementById('btn-import-creds').addEventListener('click', async () => {
  const result = await window.heatmapAPI.pickCredentialsFile();
  if (result) {
    credsStatus.textContent = 'Imported successfully';
    credsStatus.className = 'field-hint success';
  }
});

// Save config
document.getElementById('btn-save').addEventListener('click', async () => {
  const config = {
    spreadsheetId: spreadsheetIdInput.value.trim(),
    sheetName: sheetNameInput.value.trim() || 'Sheet1',
    dateColumn: dateColumnInput.value.trim() || 'F',
  };

  await window.heatmapAPI.saveConfig(config);
  window.heatmapAPI.closeSettings();
});

// Close
document.getElementById('btn-close-settings').addEventListener('click', () => {
  window.heatmapAPI.closeSettings();
});
