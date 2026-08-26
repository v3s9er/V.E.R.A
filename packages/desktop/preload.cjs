const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed Electron preload scripts are loaded through the CommonJS bridge.
// Keeping this file as .cjs makes the desktop-only directory picker reliable
// even though the packaged application itself uses ESM.
contextBridge.exposeInMainWorld('mrRobotDesktop', Object.freeze({
  chooseDirectory: () => ipcRenderer.invoke('mr-robot:choose-directory'),
  getLocalConnection: () => ipcRenderer.invoke('mr-robot:local-connection'),
  platform: 'windows',
}));
