'use strict';
// Preload for the toolbar UI (tabs, address bar, popovers). Only these channels are exposed.
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['state', 'event', 'focus']);
contextBridge.exposeInMainWorld('aph', {
  call: (name, ...args) => ipcRenderer.invoke(`ui:${name}`, ...args),
  savePending: (yes) => ipcRenderer.invoke('ui:savePending', yes),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error(`no such channel ${channel}`);
    ipcRenderer.on(channel, (_e, ...args) => cb(...args));
  },
});
