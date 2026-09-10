const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  scanFolder: (folderPath) => ipcRenderer.invoke('folder:scan', folderPath),
  uploadFile: (payload) => ipcRenderer.invoke('upload:file', payload),
  onProgress: (callback) => {
    ipcRenderer.on('upload:progress', (_event, data) => callback(data));
  }
});
