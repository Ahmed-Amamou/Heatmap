const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('heatmapAPI', {
  fetchData: () => ipcRenderer.invoke('fetch-application-data'),
  onDataRefreshed: (callback) => {
    ipcRenderer.on('data-refreshed', (_event, data) => callback(data));
  },
  closeApp: () => ipcRenderer.send('close-app'),
  minimizeToTray: () => ipcRenderer.send('minimize-to-tray'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
});
