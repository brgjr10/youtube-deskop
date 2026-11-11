const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pipAPI', {
  play: () => ipcRenderer.send('pip-action', { type: 'play' }),
  pause: () => ipcRenderer.send('pip-action', { type: 'pause' }),
  seekTo: (time) => ipcRenderer.send('pip-action', { type: 'seek-to', time }),
  loadVideo: (videoId, seekTime) => ipcRenderer.send('pip-action', { type: 'load-video', videoId, seekTime }),
  onReady: () => ipcRenderer.send('pip-ready'),
  onStateChange: (callback) => {
    ipcRenderer.on('pip-state-change', (_event, state) => callback(state));
  }
});

ipcRenderer.on('pip-command', (_event, command) => {
  const api = window.pipAPI;
  if (!api) return;

  switch (command.type) {
    case 'load-video':
      api.loadVideo(command.videoId, command.seekTime || 0);
      break;
    case 'play':
      api.play();
      break;
    case 'pause':
      api.pause();
      break;
    case 'seek-to':
      api.seekTo(command.time);
      break;
  }
});

ipcRenderer.on('pip-state-update', (_event, state) => {
  if (window.pipAPI && window.pipAPI.onStateChange) {
    window.pipAPI.onStateChange(state);
  }
});
