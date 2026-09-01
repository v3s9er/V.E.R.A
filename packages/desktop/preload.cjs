const { contextBridge, ipcRenderer } = require('electron');

// Sandboxed Electron preload scripts are loaded through the CommonJS bridge.
// Keeping this file as .cjs makes the desktop-only directory picker reliable
// even though the packaged application itself uses ESM.
contextBridge.exposeInMainWorld('mrRobotDesktop', Object.freeze({
  chooseDirectory: () => ipcRenderer.invoke('mr-robot:choose-directory'),
  chooseCalendarWorkbook: () => ipcRenderer.invoke('mr-robot:choose-calendar-workbook'),
  getLocalConnection: () => ipcRenderer.invoke('mr-robot:local-connection'),
  connectLocalRpc: (input) => ipcRenderer.invoke('mr-robot:local-rpc.connect', input),
  callLocalRpc: (method, params, timeoutMs) => ipcRenderer.invoke('mr-robot:local-rpc.call', method, params, timeoutMs),
  closeLocalRpc: () => ipcRenderer.send('mr-robot:local-rpc.close'),
  onLocalRpcEvent: (handler) => {
    const listener = (_event, message) => handler(message);
    ipcRenderer.on('mr-robot:local-rpc-event', listener);
    return () => ipcRenderer.removeListener('mr-robot:local-rpc-event', listener);
  },
  onLocalRpcClose: (handler) => {
    const listener = (_event, reason) => handler(reason);
    ipcRenderer.on('mr-robot:local-rpc-close', listener);
    return () => ipcRenderer.removeListener('mr-robot:local-rpc-close', listener);
  },
  loadPcs: () => ipcRenderer.invoke('mr-robot:pcs.load'),
  savePcs: (pcs) => ipcRenderer.invoke('mr-robot:pcs.save', pcs),
  pairRemotePc: (input) => ipcRenderer.invoke('mr-robot:pcs.pair', input),
  downloadFile: (input) => ipcRenderer.invoke('mr-robot:download', input),
  cancelDownload: (id) => ipcRenderer.invoke('mr-robot:download.cancel', id),
  onNavigate: (handler) => {
    const listener = (_event, view) => handler(view);
    ipcRenderer.on('mr-robot:navigate', listener);
    return () => ipcRenderer.removeListener('mr-robot:navigate', listener);
  },
  platform: 'windows',
}));
