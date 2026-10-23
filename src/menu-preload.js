const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('menu', {
  items: () => ipcRenderer.invoke('menu-items'),
  click: (id) => ipcRenderer.send('menu-click', id),
  close: () => ipcRenderer.send('menu-close'),
  resize: (height) => ipcRenderer.send('menu-resize', height),
});
