const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, dialog, Notification } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// Set as early as possible (before any window) so Windows treats us as a
// distinct app for taskbar grouping + icon, instead of grouping under
// "Electron". Must match the build appId.
if (process.platform === 'win32') app.setAppUserModelId('com.heatmap.widget');

// Shared window/taskbar icon path. A plain path string is used (not
// nativeImage.createFromPath) because createFromPath does NOT read from inside
// the asar in packaged builds and would yield an empty icon.
const appIconPath = path.join(__dirname, 'assets', 'icon.ico');

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
  return { spreadsheetId: '', sheetName: 'Sheet1', dateColumn: 'F', autoLaunch: true };
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

// Auto-launch on Windows startup. User-controllable from Settings (configs
// saved before the toggle existed default to on). Skipped for test profiles.
// Never register from a dev run: there the exe is node_modules' electron.exe,
// and a startup entry pointing at it makes Windows open the bare Electron
// welcome window at login. Dev runs instead clear any such stale entry.
function applyAutoLaunch(config) {
  if (isTestProfile) return;
  app.setLoginItemSettings({
    openAtLogin: app.isPackaged && config.autoLaunch !== false,
    path: app.getPath('exe'),
  });
}

applyAutoLaunch(loadConfig());

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
    icon: appIconPath,
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
    height: 380,
    frame: false,
    transparent: true,
    resizable: false,
    parent: mainWindow,
    modal: true,
    show: false,
    icon: appIconPath,
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
    width: 980,
    height: 700,
    minWidth: 640,
    minHeight: 480,
    frame: false,
    transparent: true,
    show: false,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
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

  // Show only once the renderer has loaded its data and painted
  // ('manager-ready'), so the zoom-open animation runs over a fully-built DOM
  // instead of competing with the initial render. Fallback shows it anyway if
  // the signal never arrives.
  let shown = false;
  const showAndZoom = () => {
    if (shown || !managerWindow) return;
    shown = true;
    managerWindow.show();
    managerWindow.webContents.send('zoom-open');
  };
  ipcMain.once('manager-ready', showAndZoom);
  const showFallback = setTimeout(showAndZoom, 1200);

  managerWindow.on('closed', () => {
    clearTimeout(showFallback);
    ipcMain.removeListener('manager-ready', showAndZoom);
    managerWindow = null;
  });
}

let updateReady = false;

// Builds the tray menu. When an update is downloaded, a prominent
// "Update & Restart now" item is added at the top WITHOUT dropping the normal
// items (the old code replaced the whole menu, hiding Show/Manage/Quit).
function buildTrayMenu() {
  const items = [];

  if (updateReady) {
    items.push(
      {
        label: '🟢 Update & Restart now',
        click: () => {
          app.isQuitting = true;
          autoUpdater.quitAndInstall();
        },
      },
      { type: 'separator' }
    );
  }

  items.push(
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
      label: updateReady ? 'Update downloaded ✓' : 'Check for Updates',
      enabled: !updateReady,
      click: () => autoUpdater.checkForUpdatesAndNotify(),
    },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    }
  );

  return Menu.buildFromTemplate(items);
}

function createTray() {
  tray = new Tray(getTrayIcon());
  tray.setToolTip('Heatmap');
  tray.setContextMenu(buildTrayMenu());
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

  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    mainWindow.webContents.send('update-status', 'Update ready — restart to apply');
    if (tray) {
      tray.setContextMenu(buildTrayMenu());
      tray.setToolTip('Heatmap — update ready, restart to apply');
    }

    // The app closes to the tray and only auto-installs on a full quit, so a
    // user who never quits would otherwise stay on the old version forever.
    // A clickable toast makes the ready update visible and one-click to apply.
    if (Notification.isSupported()) {
      const n = new Notification({
        title: 'Heatmap update ready',
        body: `Version ${info && info.version ? info.version : ''} is ready. Click to restart and update.`.replace('  ', ' '),
        icon: appIconPath,
      });
      n.on('click', () => {
        app.isQuitting = true;
        autoUpdater.quitAndInstall();
      });
      n.show();
    }
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
  applyAutoLaunch(config);
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
  const interviewIds = db.deleteInterviewsForApplication(id);

  let syncError = null;
  try {
    await sheetSyncer.deleteRow(id);
    for (const ivId of interviewIds) await sheetSyncer.deleteInterviewRow(ivId);
  } catch (err) {
    syncError = err.message;
    console.error('Sheet sync (delete) failed:', err.message);
  }

  notifyDataChanged();
  return { syncError };
});

// ── Interview reminders ──
// Windows toasts at ~24h and ~1h before each upcoming interview. Flags on the
// interview row prevent repeats; rescheduling re-arms them (see db.js).
function fmtEventTime(s) {
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  return d.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit',
  });
}

function checkInterviewReminders() {
  if (!Notification.isSupported()) return;
  const db = require('./src/db');
  for (const iv of db.listUpcoming()) {
    const t = new Date(iv.scheduled_at).getTime();
    if (isNaN(t)) continue;
    const delta = t - Date.now();
    if (delta <= 0) continue;

    const what = `${iv.stage || 'Interview'} — ${[iv.job_title, iv.company].filter(Boolean).join(' @ ')}`;
    if (delta <= 60 * 60 * 1000 && !iv.reminded_hour) {
      new Notification({
        title: 'Interview in less than an hour',
        body: `${what}\n${fmtEventTime(iv.scheduled_at)}`,
        icon: path.join(__dirname, 'assets', 'icon.ico'),
      }).show();
      db.markReminded(iv.id, 'hour');
    } else if (delta <= 24 * 60 * 60 * 1000 && !iv.reminded_day) {
      new Notification({
        title: 'Interview coming up',
        body: `${what}\n${fmtEventTime(iv.scheduled_at)}`,
        icon: path.join(__dirname, 'assets', 'icon.ico'),
      }).show();
      db.markReminded(iv.id, 'day');
    }
  }
}

// The gadget's "next interview" line: the soonest upcoming one.
ipcMain.handle('get-next-event', () => {
  const upcoming = require('./src/db').listUpcoming();
  const now = Date.now();
  return upcoming.find((iv) => {
    const t = new Date(iv.scheduled_at).getTime();
    return !isNaN(t) && t >= now;
  }) || null;
});

// ── Interviews ──
ipcMain.handle('list-interviews', (_event, applicationId) => {
  return require('./src/db').listInterviews(applicationId);
});

ipcMain.handle('list-all-interviews', () => {
  return require('./src/db').listAllInterviews();
});

ipcMain.handle('save-interview', async (_event, data) => {
  const db = require('./src/db');
  const id = db.upsertInterview(data);

  let syncError = null;
  try {
    const saved = db.getInterview(id);
    const app = db.getApplication(saved.application_id);
    const label = app ? [app.job_title, app.company].filter(Boolean).join(' — ') : '';
    await sheetSyncer.upsertInterviewRow(saved, label);
  } catch (err) {
    syncError = err.message;
    console.error('Sheet sync (interview upsert) failed:', err.message);
  }

  notifyDataChanged();
  return { id, syncError };
});

ipcMain.handle('delete-interview', async (_event, id) => {
  require('./src/db').deleteInterview(id);

  let syncError = null;
  try {
    await sheetSyncer.deleteInterviewRow(id);
  } catch (err) {
    syncError = err.message;
    console.error('Sheet sync (interview delete) failed:', err.message);
  }

  notifyDataChanged();
  return { syncError };
});

// Write an export file wherever the user picks. Content is built in the
// renderer; main only owns the save dialog and disk write.
ipcMain.handle('export-applications', async (_event, { defaultName, content }) => {
  const result = await dialog.showSaveDialog(managerWindow || mainWindow, {
    title: 'Export applications',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: 'Text', extensions: ['txt'] },
    ],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, content, 'utf8');
  return { canceled: false, filePath: result.filePath };
});

// Same as export-applications but with caller-chosen filters (.ics etc.).
ipcMain.handle('export-file', async (_event, { defaultName, content, filters }) => {
  const result = await dialog.showSaveDialog(managerWindow || mainWindow, {
    title: 'Export',
    defaultPath: path.join(app.getPath('documents'), defaultName),
    filters: filters || [{ name: 'All files', extensions: ['*'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  fs.writeFileSync(result.filePath, content, 'utf8');
  return { canceled: false, filePath: result.filePath };
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
  checkInterviewReminders();
  setInterval(checkInterviewReminders, 10 * 60 * 1000);
});

app.on('window-all-closed', () => {
  clearInterval(refreshInterval);
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
