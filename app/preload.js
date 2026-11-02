// The only bridge between the dashboard page and the desktop app. Exposes a narrow, typed API.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbitNative', {
  platform: process.platform,
  audio: (samples) => ipcRenderer.send('audio', samples),          // Float32Array, 16 kHz mono
  setListening: (on) => ipcRenderer.send('listening', on),
  ptt: (down) => ipcRenderer.send('ptt', down),
  followUp: (ms) => ipcRenderer.send('followUp', ms),
  cancel: () => ipcRenderer.send('cancel'),
  speak: (text, speed) => ipcRenderer.invoke('speak', text, speed),
  voices: () => ipcRenderer.invoke('voices'),
  setVoice: (id) => ipcRenderer.invoke('setVoice', id),
  report: (state) => ipcRenderer.send('report', state),            // mirrors state to the tray and overlay
  setSensitivity: (v) => ipcRenderer.send('sensitivity', v),
  getInfo: () => ipcRenderer.invoke('info'),
  setStt: (v) => ipcRenderer.invoke('setStt', v),
  setPatience: (v) => ipcRenderer.invoke('setPatience', v),
  setLaunchAtLogin: (on) => ipcRenderer.invoke('launchAtLogin', on),
  on: (channel, fn) => {
    const allowed = ['wake', 'partial', 'utterance', 'listening', 'speech-ready', 'speech-error', 'mic', 'ptt-toggle', 'models', 'voice-download', 'missed'];
    if (!allowed.includes(channel)) return () => {};
    const h = (_e, data) => fn(data);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.off(channel, h);
  },
});
