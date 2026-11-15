const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  getSession: () => ipcRenderer.invoke('auth:getSession'),
  logout: () => ipcRenderer.invoke('auth:logout'),

  searchAnimeWorks: (q) => ipcRenderer.invoke('anime:searchWorks', q),
  anilistSearch: (q) => ipcRenderer.invoke('anime:anilistSearch', q),
  anilistCreate: (payload) => ipcRenderer.invoke('anime:anilistCreate', payload),
  listEpisodes: (animeId) => ipcRenderer.invoke('anime:listEpisodes', animeId),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),

  pickFile: () => ipcRenderer.invoke('file:pick'),
  pickAndScanFolder: () => ipcRenderer.invoke('folder:pickAndScan'),

  checkEpisode: (payload) => ipcRenderer.invoke('upload:checkEpisode', payload),
  queueEpisodeUpload: (payload) => ipcRenderer.invoke('upload:queueEpisode', payload),

  listOps: () => ipcRenderer.invoke('ops:list'),
  retryHost: (payload) => ipcRenderer.invoke('ops:retryHost', payload),
  onOpsUpdated: (callback) => {
    ipcRenderer.on('ops:updated', (_event, jobs) => callback(jobs));
  },
});
