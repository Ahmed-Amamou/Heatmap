const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('heatmapAPI', {
  fetchData: () => ipcRenderer.invoke('fetch-application-data'),
  onDataRefreshed: (callback) => {
    ipcRenderer.on('data-refreshed', (_event, data) => callback(data));
  },
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update-status', (_event, msg) => callback(msg));
  },
  onUpdateReady: (callback) => {
    ipcRenderer.on('update-ready', (_event, info) => callback(info));
  },
  installUpdate: () => ipcRenderer.send('install-update'),
  closeApp: () => ipcRenderer.send('close-app'),
  minimizeToTray: () => ipcRenderer.send('minimize-to-tray'),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('toggle-always-on-top'),
  openSettings: () => ipcRenderer.send('open-settings'),
  closeSettings: () => ipcRenderer.send('close-settings'),
  getConfig: () => ipcRenderer.invoke('get-config'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  saveConfig: (config) => ipcRenderer.invoke('save-config', config),
  pickCredentialsFile: () => ipcRenderer.invoke('pick-credentials-file'),
  openManager: (origin, appId) => ipcRenderer.send('open-manager', origin, appId),
  onFocusApplication: (callback) => {
    ipcRenderer.on('focus-application', (_event, id) => callback(id));
  },
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
  getNextEvent: () => ipcRenderer.invoke('get-next-event'),
  getCalendarInterviews: () => ipcRenderer.invoke('get-calendar-interviews'),
  exportFile: (payload) => ipcRenderer.invoke('export-file', payload),
});
