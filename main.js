const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// ── Throwaway test profiles (dev only) ──
// Simulate a fresh install without touching your real data. This redirects ALL
// user data (config.json, heatmap.db, credentials.json, window position) to an
// isolated temp folder, so the app behaves like a brand-new install.
//   npm run start:fresh          brand-new user — temp profile wiped each launch
//   electron . --profile=demo    named temp profile that PERSISTS between runs
//                                 (stage a scenario once, e.g. a configured but
//                                  unreachable sheet, then relaunch into it)
const useFresh = process.argv.includes('--fresh');
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
const isTestProfile = useFresh || !!profileArg;

if (isTestProfile) {
  const os = require('os');
  const name = profileArg ? profileArg.split('=')[1] : 'fresh';
  const profileDir = path.join(os.tmpdir(), `heatmap-test-${name}`);
  if (useFresh) fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  app.setPath('userData', profileDir);
  console.log(`[test profile "${name}"] userData → ${profileDir}`);
}

// ── Config persistence (replaces .env) ──
const configFile = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(configFile)) {
      return JSON.parse(fs.readFileSync(configFile, 'utf8'));
    }
  } catch {}
  return { spreadsheetId: '', sheetName: 'Sheet1', dateColumn: 'F' };
}

function saveConfig(config) {
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

// ── Sheets importer + syncer + local DB ──
let importFromSheet;
let sheetSyncer;
function initSheets() {
  const config = loadConfig();
  const { createImporter, createSyncer } = require('./src/sheets');
  importFromSheet = createImporter(config);
  sheetSyncer = createSyncer(config);
}

// Pull latest from the sheet into SQLite, then read counts from the DB.
// Heatmap stays functional offline by falling back to cached local data.
async function refreshData() {
  const db = require('./src/db');

  // The Google Sheet is optional. Only attempt an import when one is actually
  // configured, so a sheet-less user never sees a connection "error".
  let importError = null;
  if (loadConfig().spreadsheetId) {
    try {
      await importFromSheet();
    } catch (err) {
      importError = err.message;
      console.error('Sheet import failed:', err.message);
    }
  }

  const counts = db.getDateCounts();
  // Surface an error only when a configured sheet failed AND we have no local
  // data to fall back on. No sheet + no data is a normal empty state, not an error.
  if (importError && Object.keys(counts).length === 0) {
    return { error: importError };
  }
  return counts;
}

// Auto-launch on Windows startup (skipped for throwaway test profiles)
if (!isTestProfile) {
  app.setLoginItemSettings({
    openAtLogin: true,
    path: app.getPath('exe'),
  });
}

// Single instance lock. Test profiles bypass it so a throwaway instance can run
// alongside your real (already-running) Heatmap instead of just focusing it.
if (!isTestProfile) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
  }
}

let mainWindow;
let settingsWindow;
let managerWindow;
let tray;
let refreshInterval;

// ── Position memory ──
const positionFile = path.join(app.getPath('userData'), 'window-position.json');

function loadPosition() {
  try {
    if (fs.existsSync(positionFile)) {
      const data = JSON.parse(fs.readFileSync(positionFile, 'utf8'));
      const displays = screen.getAllDisplays();
      const onScreen = displays.some(d => {
        const b = d.bounds;
        return data.x >= b.x - 100 && data.x < b.x + b.width &&
               data.y >= b.y - 100 && data.y < b.y + b.height;
      });
      if (onScreen) return data;
    }
  } catch {}
  return null;
}

function savePosition() {
  if (!mainWindow) return;
  const [x, y] = mainWindow.getPosition();
  fs.writeFileSync(positionFile, JSON.stringify({ x, y }));
}

// ── Tray icon ──
function getTrayIcon() {
  const icoPath = path.join(__dirname, 'assets', 'icon.ico');
  if (fs.existsSync(icoPath)) {
    return nativeImage.createFromPath(icoPath).resize({ width: 16, height: 16 });
  }
  return nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVQ4T2NkYPj/n4EBFTAiqjMy' +
      'MDDCVWHL4zQA2Rl0A0ZdMOoCkl0AAJFhCAkR0pWoAAAAAElFTkSuQmCC',
      'base64'
    )
  );
}

function createWindow() {
  const pos = loadPosition();

  mainWindow = new BrowserWindow({
    width: 420,
    height: 280,
    x: pos?.x,
    y: pos?.y,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: false,
    show: false,
    paintWhenInitiallyHidden: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('moved', savePosition);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  refreshInterval = setInterval(async () => {
    const data = await refreshData();
    mainWindow.webContents.send('data-refreshed', data);
  }, 30 * 60 * 1000);
}

function createSettingsWindow() {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 400,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    parent: mainWindow,
    modal: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(__dirname, 'renderer', 'settings.html'));

  settingsWindow.once('ready-to-show', () => {
    settingsWindow.show();
  });

  settingsWindow.on('closed', () => {
    settingsWindow = null;
  });
}

function createManagerWindow(origin) {
  if (managerWindow) {
    managerWindow.show();
    managerWindow.focus();
    return;
  }

  managerWindow = new BrowserWindow({
    width: 860,
    height: 620,
    minWidth: 640,
    minHeight: 480,
    frame: false,
    transparent: true,
    show: false,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Translate the gadget-relative click point into a percentage position inside
  // the manager window, used as the CSS transform-origin so the window scales
  // open from the icon the user clicked.
  const query = {};
  if (origin && mainWindow) {
    const gb = mainWindow.getContentBounds();
    const mb = managerWindow.getContentBounds();
    query.ox = (((gb.x + origin.x - mb.x) / mb.width) * 100).toFixed(2);
    query.oy = (((gb.y + origin.y - mb.y) / mb.height) * 100).toFixed(2);
  }

  managerWindow.loadFile(path.join(__dirname, 'renderer', 'manager.html'), { query });

  managerWindow.once('ready-to-show', () => {
    managerWindow.show();
  });

  managerWindow.on('closed', () => {
    managerWindow = null;
  });
}

function createTray() {
  tray = new Tray(getTrayIcon());
  tray.setToolTip('Heatmap');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    {
      label: 'Manage Applications',
      click: () => createManagerWindow(),
    },
    {
      label: 'Refresh Data',
      click: async () => {
        const data = await refreshData();
        mainWindow.webContents.send('data-refreshed', data);
      },
    },
    {
      label: 'Settings',
      click: () => createSettingsWindow(),
    },
    { type: 'separator' },
    {
      label: 'Check for Updates',
      click: () => autoUpdater.checkForUpdatesAndNotify(),
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── Auto-updater ──
function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', () => {
    mainWindow.webContents.send('update-status', 'Downloading update...');
  });

  autoUpdater.on('update-downloaded', () => {
    mainWindow.webContents.send('update-status', 'Update ready — restart to apply');
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Restart & Update',
        click: () => autoUpdater.quitAndInstall(),
      },
      {
        label: 'Later',
        click: () => {},
      },
    ]);
    tray.setContextMenu(contextMenu);
  });

  autoUpdater.on('error', (err) => {
    console.error('Auto-update error:', err.message);
  });

  // Check on launch, then every 4 hours
  autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 60 * 60 * 1000);
}

// ── IPC handlers ──
ipcMain.handle('fetch-application-data', async () => {
  return refreshData();
});

ipcMain.handle('toggle-always-on-top', () => {
  const current = mainWindow.isAlwaysOnTop();
  mainWindow.setAlwaysOnTop(!current);
  return !current;
});

ipcMain.handle('get-config', () => {
  return loadConfig();
});

ipcMain.handle('save-config', (_event, config) => {
  saveConfig(config);
  initSheets();
  return { success: true };
});

ipcMain.handle('pick-credentials-file', async () => {
  const result = await dialog.showOpenDialog(settingsWindow || mainWindow, {
    title: 'Select Google Service Account credentials.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const src = result.filePaths[0];
  const dest = path.join(app.getPath('userData'), 'credentials.json');
  fs.copyFileSync(src, dest);
  return dest;
});

ipcMain.handle('list-applications', () => {
  return require('./src/db').listApplications();
});

// Save (add/edit) locally, then best-effort push to the sheet. The sheet sync
// failing (offline, no creds) must not lose the local write.
ipcMain.handle('save-application', async (_event, appData) => {
  const db = require('./src/db');
  const id = db.upsertApplication(appData);
  const saved = db.getApplication(id);

  let syncError = null;
  try {
    await sheetSyncer.upsertRow(saved);
  } catch (err) {
    syncError = err.message;
    console.error('Sheet sync (upsert) failed:', err.message);
  }

  notifyDataChanged();
  return { id, syncError };
});

ipcMain.handle('delete-application', async (_event, id) => {
  const db = require('./src/db');
  db.deleteApplication(id);

  let syncError = null;
  try {
    await sheetSyncer.deleteRow(id);
  } catch (err) {
    syncError = err.message;
    console.error('Sheet sync (delete) failed:', err.message);
  }

  notifyDataChanged();
  return { syncError };
});

// Refresh the heatmap counts in any open windows after a local mutation.
function notifyDataChanged() {
  const counts = require('./src/db').getDateCounts();
  if (mainWindow) mainWindow.webContents.send('data-refreshed', counts);
}

ipcMain.on('open-manager', (_event, origin) => {
  createManagerWindow(origin);
});

ipcMain.on('close-manager', () => {
  if (managerWindow) managerWindow.close();
});

ipcMain.on('open-settings', () => {
  createSettingsWindow();
});

ipcMain.on('close-settings', () => {
  if (settingsWindow) settingsWindow.close();
});

ipcMain.on('minimize-to-tray', () => {
  mainWindow.hide();
});

ipcMain.on('close-app', () => {
  app.isQuitting = true;
  app.quit();
});

app.on('second-instance', () => {
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
  initSheets();
  await require('./src/db').initDb();
  createWindow();
  createTray();
  setupAutoUpdater();
});

app.on('window-all-closed', () => {
  clearInterval(refreshInterval);
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
