const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('heatmapAPI', {
  fetchData: () => ipcRenderer.invoke('fetch-application-data'),
  onDataRefreshed: (callback) => {
    ipcRenderer.on('data-refreshed', (_event, data) => callback(data));
  },
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (_event, msg) => callback(msg));
  },
  closeApp: () => ipcRenderer.send('close-app'),
  minimizeToTray: () => ipcRenderer.send('minimize-to-tray'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  openSettings: () => ipcRenderer.send('open-settings'),
  closeSettings: () => ipcRenderer.send('close-settings'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  pickCredentialsFile: () => ipcRenderer.invoke('pick-credentials-file'),
});
