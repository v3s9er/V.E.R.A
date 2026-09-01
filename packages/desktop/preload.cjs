const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed Electron preload scripts are loaded through the CommonJS bridge.
// Keeping this file as .cjs makes the desktop-only directory picker reliable
// even though the packaged application itself uses ESM.
contextBridge.exposeInMainWorld('mrRobotDesktop', Object.freeze({
  chooseDirectory: () => ipcRenderer.invoke('mr-robot:choose-directory'),
  chooseCalendarWorkbook: () => ipcRenderer.invoke('mr-robot:choose-calendar-workbook'),
  getLocalConnection: () => ipcRenderer.invoke('mr-robot:local-connection'),
  loadPcs: () => ipcRenderer.invoke('mr-robot:pcs.load'),
  savePcs: (pcs) => ipcRenderer.invoke('mr-robot:pcs.save', pcs),
  downloadFile: (input) => ipcRenderer.invoke('mr-robot:download', input),
  cancelDownload: (id) => ipcRenderer.invoke('mr-robot:download.cancel', id),
  onNavigate: (handler) => {
    const listener = (_event, view) => handler(view);
    ipcRenderer.on('mr-robot:navigate', listener);
    return () => ipcRenderer.removeListener('mr-robot:navigate', listener);
  },
  platform: 'windows',
}));
