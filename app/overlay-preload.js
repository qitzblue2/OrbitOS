const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('orbitOverlay', {
  on: (fn) => ipcRenderer.on('overlay', (_e, d) => fn(d)),
  open: () => ipcRenderer.send('show-main'),
  stop: () => ipcRenderer.send('overlay-stop'),
});
