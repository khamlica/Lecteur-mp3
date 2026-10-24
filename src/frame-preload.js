const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('frame', {
  onSkin: (cb) => ipcRenderer.on('frame-skin', (_e, skin) => cb(skin)),
  onFx: (cb) => ipcRenderer.on('frame-fx', (_e, fx) => cb(fx)),
});
