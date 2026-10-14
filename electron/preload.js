'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('karmis', {
  platform: 'windows',
  fetchRaw: (url, opts) => ipcRenderer.invoke('http', url, opts),
  fetchBin: (url, opts) => ipcRenderer.invoke('http-bin', url, opts),
  openExternal: url => ipcRenderer.invoke('open-external', url),
  launchApp: name => ipcRenderer.invoke('launch-app', name),
  findApp: names => ipcRenderer.invoke('find-app', names),
  launchStartApp: id => ipcRenderer.invoke('launch-start-app', id),

  /* міні-вікно (electron/main.js → www/mini.html) */
  mini: {
    open: o => ipcRenderer.invoke('mini-open', o),
    close: () => ipcRenderer.invoke('mini-close'),
    push: evt => ipcRenderer.send('mini-evt', evt),
    onCmd: cb => ipcRenderer.on('mini-cmd', (_e, c) => cb(c)),
    onClosed: cb => ipcRenderer.on('mini-closed', () => cb()),
  },

  /* керування ноутбуком (electron/pc.js) */
  pc: {
    info: () => ipcRenderer.invoke('pc-info'),
    warmup: () => ipcRenderer.invoke('pc-warmup'),
    start: o => ipcRenderer.invoke('pc-start', o),
    stop: () => ipcRenderer.invoke('pc-stop'),
    window: op => ipcRenderer.invoke('pc-window', op),
    status: t => ipcRenderer.invoke('pc-status', t),
    screenshot: () => ipcRenderer.invoke('pc-screenshot'),
    observe: o => ipcRenderer.invoke('pc-observe', o),
    zoom: o => ipcRenderer.invoke('pc-zoom', o),
    mouse: o => ipcRenderer.invoke('pc-mouse', o),
    type: t => ipcRenderer.invoke('pc-type', t),
    key: k => ipcRenderer.invoke('pc-key', k),
    clipRead: () => ipcRenderer.invoke('pc-clip-read'),
    clipWrite: t => ipcRenderer.invoke('pc-clip-write', t),
    selftest: () => ipcRenderer.invoke('pc-selftest'),
    onStopped: cb => ipcRenderer.on('pc-stopped', (_e, reason) => cb(reason)),
  },
});
