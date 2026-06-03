const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sweep', {
  dirSize: (p) => ipcRenderer.invoke('scan:dirSize', p),
  scanSystemJunk: () => ipcRenderer.invoke('scan:systemJunk'),
  scanMemory: () => ipcRenderer.invoke('scan:memory'),
  scanLargeFiles: (minMB) => ipcRenderer.invoke('scan:largeFiles', minMB),
  scanTrash: () => ipcRenderer.invoke('scan:trash'),
  scanDownloads: () => ipcRenderer.invoke('scan:downloads'),
  scanLoginItems: () => ipcRenderer.invoke('scan:loginItems'),
  scanApps: () => ipcRenderer.invoke('scan:apps'),
  scanAppLeftovers: (name, appPath) => ipcRenderer.invoke('scan:appLeftovers', name, appPath),
  checkAccess: () => ipcRenderer.invoke('scan:access'),

  cleanCaches: (paths) => ipcRenderer.invoke('clean:caches', paths),
  trashFiles: (paths) => ipcRenderer.invoke('clean:trashFiles', paths),
  emptyTrash: () => ipcRenderer.invoke('clean:emptyTrash'),
  purgeMemory: () => ipcRenderer.invoke('clean:purgeMemory'),
  toggleLoginItem: (p, enable) => ipcRenderer.invoke('toggle:loginItem', p, enable),
  openDownloads: () => ipcRenderer.invoke('open:downloads'),
});
