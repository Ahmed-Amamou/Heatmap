const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { fetchApplicationDates } = require('./src/sheets');

// Auto-launch on Windows startup
app.setLoginItemSettings({
  openAtLogin: true,
  path: app.getPath('exe'),
});

// Single instance lock — prevent duplicate windows on startup
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow;
let tray;
let refreshInterval;

// ── Position memory ──
const positionFile = path.join(app.getPath('userData'), 'window-position.json');

function loadPosition() {
  try {
    if (fs.existsSync(positionFile)) {
      const data = JSON.parse(fs.readFileSync(positionFile, 'utf8'));
      // Validate position is on a visible display
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Smooth show after content loads
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Save position on move
  mainWindow.on('moved', savePosition);

  // Minimize to tray instead of closing via window controls
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  // Auto-refresh every 30 minutes
  refreshInterval = setInterval(async () => {
    try {
      const data = await fetchApplicationDates();
      mainWindow.webContents.send('data-refreshed', data);
    } catch (err) {
      console.error('Auto-refresh failed:', err.message);
    }
  }, 30 * 60 * 1000);
}

function createTray() {
  const icon = nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVQ4T2NkYPj/n4EBFTAiqjMy' +
      'MDDCVWHL4zQA2Rl0A0ZdMOoCkl0AAJFhCAkR0pWoAAAAAElFTkSuQmCC',
      'base64'
    )
  );

  tray = new Tray(icon);
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
    { type: 'separator' },
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

// IPC handlers
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
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  clearInterval(refreshInterval);
  app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;
});
