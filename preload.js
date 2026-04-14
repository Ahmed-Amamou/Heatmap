const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('heatmapAPI', {
  fetchData: () => ipcRenderer.invoke('fetch-application-data'),
  onDataRefreshed: (callback) => {
    ipcRenderer.on('data-refreshed', (_event, data) => callback(data));
  },
  closeApp: () => ipcRenderer.send('close-app'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
});
