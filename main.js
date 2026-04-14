const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { fetchApplicationDates } = require('./src/sheets');

let mainWindow;
let tray;
let refreshInterval;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420,
    height: 280,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

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
  // Create a simple 16x16 green square icon
  const icon = nativeImage.createFromBuffer(
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAKklEQVQ4T2NkYPj/n4EBFTAiqjMy' +
      'MDDCVWHL4zQA2Rl0A0ZdMOoCkl0AAJFhCAkR0pWoAAAAAElFTkSuQmCC',
      'base64'
    )
  );

  tray = new Tray(icon);
  tray.setToolTip('Job Application Heatmap');

  const contextMenu = Menu.buildFromTemplate([
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
      label: 'Toggle Always on Top',
      click: () => {
        const current = mainWindow.isAlwaysOnTop();
        mainWindow.setAlwaysOnTop(!current);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => app.quit(),
    },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    mainWindow.show();
    mainWindow.focus();
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

ipcMain.on('close-app', () => {
  app.quit();
});

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', () => {
  clearInterval(refreshInterval);
  app.quit();
});
