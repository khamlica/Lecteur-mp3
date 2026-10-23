const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('editor', {
  load: () => ipcRenderer.invoke('editor-load'),
  save: (changes) => ipcRenderer.invoke('editor-save', changes),
  close: () => ipcRenderer.send('editor-close'),
  onReload: (cb) => ipcRenderer.on('editor-reload', () => cb()),
});
