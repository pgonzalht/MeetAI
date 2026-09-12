const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('meetai', {
  desktop: true,
  version: process.versions.electron,
  // lets the window warn before closing with phrases still queued
  setPending: (n) => ipcRenderer.send('meetai:pending', n),
});
