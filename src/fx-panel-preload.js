const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fxPanel', {
  load: () => ipcRenderer.invoke('fx-panel-load'),
  set: (partial) => ipcRenderer.send('fx-panel-set', partial),
  close: () => ipcRenderer.send('fx-panel-close'),
  onUpdate: (cb) => ipcRenderer.on('fx-panel-update', (_e, state) => cb(state)),
});
