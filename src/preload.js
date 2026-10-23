const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getInitialState: () => ipcRenderer.invoke('get-initial-state'),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  getMetadata: (file) => ipcRenderer.invoke('get-metadata', file),
  readAudio: (file) => ipcRenderer.invoke('read-audio', file),
  reportFx: (report) => ipcRenderer.send('fx-report', report),
  convertYoutube: (url) => ipcRenderer.invoke('convert-youtube', url),
  cancelYoutube: () => ipcRenderer.send('cancel-youtube'),
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),
  writeTags: (file, changes) => ipcRenderer.invoke('write-tags', file, changes),
  tagsSaved: (id, result) => ipcRenderer.send('tags-saved', id, result),
  openEditor: (file) => ipcRenderer.send('open-editor', file),
  saveState: (partial) => ipcRenderer.send('save-state', partial),
  hideWindow: () => ipcRenderer.send('hide-window'),
  showEffectsMenu: () => ipcRenderer.send('effects-menu'),
  showSoundMenu: () => ipcRenderer.send('sound-menu'),
  reportPlayback: (info) => ipcRenderer.send('playback', info),
  onCommand: (cb) => ipcRenderer.on('command', (_e, cmd, arg) => cb(cmd, arg)),
});
