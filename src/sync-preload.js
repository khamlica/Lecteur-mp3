const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sync', {
  load: () => ipcRenderer.invoke('sync-load'),
  action: (name, arg) => ipcRenderer.invoke('sync-action', name, arg),
  qrCodes: () => ipcRenderer.invoke('sync-qr'),
  close: () => ipcRenderer.send('sync-close'),
  onUpdate: (cb) => ipcRenderer.on('sync-update', (_e, state) => cb(state)),
});
