const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ytdAPI', {
  togglePip: () => ipcRenderer.send('pip-toggle'),
  onPipStateChange: (callback) => ipcRenderer.on('pip-state-changed', (_event, state) => callback(state)),
});