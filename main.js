const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

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

// ── Lazy-load sheets module (needs config) ──
let fetchApplicationDates;
function initSheets() {
  const config = loadConfig();
  const { createFetcher } = require('./src/sheets');
  fetchApplicationDates = createFetcher(config);
}

// Auto-launch on Windows startup
app.setLoginItemSettings({
  openAtLogin: true,
  path: app.getPath('exe'),
});

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow;
let settingsWindow;
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
    try {
      const data = await fetchApplicationDates();
      mainWindow.webContents.send('data-refreshed', data);
    } catch (err) {
      console.error('Auto-refresh failed:', err.message);
    }
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
      label: 'Refresh Data',
      click: async () => {
        try {
          const data = await fetchApplicationDates();
          mainWindow.webContents.send('data-refreshed', data);
        } catch (err) {
          console.error('Refresh failed:', err.message);
        }
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
  try {
    return await fetchApplicationDates();
  } catch (err) {
    console.error('Failed to fetch data:', err.message);
    return { error: err.message };
  }
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

app.whenReady().then(() => {
  initSheets();
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
