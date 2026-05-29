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
  openManager: () => ipcRenderer.send('open-manager'),
  closeManager: () => ipcRenderer.send('close-manager'),
  listApplications: () => ipcRenderer.invoke('list-applications'),
  saveApplication: (appData) => ipcRenderer.invoke('save-application', appData),
  deleteApplication: (id) => ipcRenderer.invoke('delete-application', id),
});
