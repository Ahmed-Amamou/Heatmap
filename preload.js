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
  openManager: (origin) => ipcRenderer.send('open-manager', origin),
  closeManager: () => ipcRenderer.send('close-manager'),
  managerReady: () => ipcRenderer.send('manager-ready'),
  onZoomOpen: (callback) => {
    ipcRenderer.on('zoom-open', () => callback());
  },
  listApplications: () => ipcRenderer.invoke('list-applications'),
  saveApplication: (appData) => ipcRenderer.invoke('save-application', appData),
  deleteApplication: (id) => ipcRenderer.invoke('delete-application', id),
  exportApplications: (payload) => ipcRenderer.invoke('export-applications', payload),
  listInterviews: (applicationId) => ipcRenderer.invoke('list-interviews', applicationId),
  listAllInterviews: () => ipcRenderer.invoke('list-all-interviews'),
  saveInterview: (data) => ipcRenderer.invoke('save-interview', data),
  deleteInterview: (id) => ipcRenderer.invoke('delete-interview', id),
});
