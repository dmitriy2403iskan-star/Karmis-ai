'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('karmisMini', {
  send: cmd => ipcRenderer.send('mini-cmd', cmd),
  onEvt: cb => ipcRenderer.on('mini-evt', (_e, evt) => cb(evt)),
  expand: () => ipcRenderer.invoke('mini-expand'),
  close: () => ipcRenderer.invoke('mini-close'),
});
