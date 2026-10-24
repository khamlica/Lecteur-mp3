const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lyricsApi', {
  load: () => ipcRenderer.invoke('lyrics-load'),
  onLyrics: (cb) => ipcRenderer.on('lyrics-data', (_e, data) => cb(data)),
  onClock: (cb) => ipcRenderer.on('lyrics-clock', (_e, clock) => cb(clock)),
  onTransparent: (cb) => ipcRenderer.on('lyrics-transparent', (_e, flag) => cb(flag)),
  seek: (time) => ipcRenderer.send('lyrics-seek', time),
  setOption: (name, value) => ipcRenderer.send('lyrics-option', name, value),
  setOffset: (offset) => ipcRenderer.send('lyrics-offset', offset),
  research: () => ipcRenderer.send('lyrics-research'),
  close: () => ipcRenderer.send('lyrics-close'),
});
