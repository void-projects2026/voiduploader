const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  scanFolder: (folderPath) => ipcRenderer.invoke('folder:scan', folderPath),
  uploadFile: (payload) => ipcRenderer.invoke('upload:file', payload),
  onProgress: (callback) => {
    ipcRenderer.on('upload:progress', (_event, data) => callback(data));
  },
  testConnection: (payload) => ipcRenderer.invoke('provider:test', payload),
  testLink: (url) => ipcRenderer.invoke('link:test', url),
  createFolder: (payload) => ipcRenderer.invoke('folder:create', payload),
  addHistoryBatch: (payload) => ipcRenderer.invoke('history:addBatch', payload),
  recordHistoryLink: (payload) => ipcRenderer.invoke('history:recordLink', payload),
  listHistory: () => ipcRenderer.invoke('history:list'),
  clearHistory: () => ipcRenderer.invoke('history:clear'),
  writeClipboard: (text) => ipcRenderer.invoke('clipboard:write', text)
});
