const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sweep', {
  dirSize: (p) => ipcRenderer.invoke('scan:dirSize', p),
  scanSystemJunk: () => ipcRenderer.invoke('scan:systemJunk'),
  scanSmart: () => ipcRenderer.invoke('scan:smart'),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  // Progress events for the cancellable scans; returns an unsubscribe function
  // so a view can listen only while its own scan runs.
  onScanProgress: (cb) => {
    const listener = (_e, p) => cb(p);
    ipcRenderer.on('scan:progress', listener);
    return () => ipcRenderer.removeListener('scan:progress', listener);
  },
  scanMemory: () => ipcRenderer.invoke('scan:memory'),
  scanLargeFiles: (minMB) => ipcRenderer.invoke('scan:largeFiles', minMB),
  scanTrash: () => ipcRenderer.invoke('scan:trash'),
  scanDownloads: () => ipcRenderer.invoke('scan:downloads'),
  scanLoginItems: () => ipcRenderer.invoke('scan:loginItems'),
  scanApps: () => ipcRenderer.invoke('scan:apps'),
  scanAppsInfo: (paths) => ipcRenderer.invoke('scan:appsInfo', paths),
  // Subscribe to per-app info events emitted during scanAppsInfo; returns an
  // unsubscribe function so a view can drop its listener between scans.
  onAppInfo: (cb) => {
    const listener = (_e, info) => cb(info);
    ipcRenderer.on('apps:info', listener);
    return () => ipcRenderer.removeListener('apps:info', listener);
  },
  scanAppLeftovers: (name, appPath) => ipcRenderer.invoke('scan:appLeftovers', name, appPath),
  isAppRunning: (appPath) => ipcRenderer.invoke('scan:appRunning', appPath),
  quitApp: (appPath) => ipcRenderer.invoke('app:quit', appPath),
  checkAccess: () => ipcRenderer.invoke('scan:access'),

  cleanCaches: (paths) => ipcRenderer.invoke('clean:caches', paths),
  trashFiles: (paths) => ipcRenderer.invoke('clean:trashFiles', paths),
  emptyTrash: () => ipcRenderer.invoke('clean:emptyTrash'),
  purgeMemory: () => ipcRenderer.invoke('clean:purgeMemory'),
  toggleLoginItem: (p, enable) => ipcRenderer.invoke('toggle:loginItem', p, enable),
  openDownloads: () => ipcRenderer.invoke('open:downloads'),
});
