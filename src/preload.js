const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Drag&drop: a dropped File object has no usable path once contextBridge
  // clones it into the main world, except through webUtils.getPathForFile,
  // which must run here (preload) on the original File reference.
  getPathForFile: (file) => webUtils.getPathForFile(file),
  inspectDroppedFile: (filePath) => ipcRenderer.invoke('file:inspectDropped', filePath),
  openEpisodeOnSite: (payload) => ipcRenderer.invoke('shell:openEpisode', payload),
  resumeIncomplete: () => ipcRenderer.invoke('ops:resumeIncomplete'),

  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  getSession: () => ipcRenderer.invoke('auth:getSession'),
  logout: () => ipcRenderer.invoke('auth:logout'),

  searchAnimeWorks: (q) => ipcRenderer.invoke('anime:searchWorks', q),
  anilistSearch: (q) => ipcRenderer.invoke('anime:anilistSearch', q),
  anilistTranslatePreview: (payload) => ipcRenderer.invoke('anime:anilistTranslatePreview', payload),
  anilistCreate: (payload) => ipcRenderer.invoke('anime:anilistCreate', payload),
  listEpisodes: (animeId) => ipcRenderer.invoke('anime:listEpisodes', animeId),

  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  getAppVersion: () => ipcRenderer.invoke('app:getVersion'),

  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (callback) => {
    ipcRenderer.on('update:status', (_event, data) => callback(data));
  },

  pickFile: () => ipcRenderer.invoke('file:pick'),
  pickAndScanFolder: () => ipcRenderer.invoke('folder:pickAndScan'),

  checkEpisode: (payload) => ipcRenderer.invoke('upload:checkEpisode', payload),
  queueEpisodeUpload: (payload) => ipcRenderer.invoke('upload:queueEpisode', payload),

  // Download tool (ani-cli-arabic via the Python bridge) + local library
  toolStatus: () => ipcRenderer.invoke('tool:status'),
  toolSetup: (opts) => ipcRenderer.invoke('tool:setup', opts),
  onToolSetupProgress: (cb) => { ipcRenderer.on('tool:setupProgress', (_e, d) => cb(d)); },
  toolProviders: () => ipcRenderer.invoke('tool:providers'),
  toolSearch: (payload) => ipcRenderer.invoke('tool:search', payload),
  toolEpisodes: (payload) => ipcRenderer.invoke('tool:episodes', payload),
  getToolSettings: () => ipcRenderer.invoke('tool:getSettings'),
  setToolSettings: (s) => ipcRenderer.invoke('tool:setSettings', s),
  startDownload: (payload) => ipcRenderer.invoke('dl:start', payload),
  retryDownload: (id) => ipcRenderer.invoke('dl:retry', id),
  cancelDownload: (id) => ipcRenderer.invoke('dl:cancel', id),
  listDownloads: () => ipcRenderer.invoke('dl:list'),
  clearFinishedDownloads: () => ipcRenderer.invoke('dl:clearFinished'),
  onDownloadsUpdated: (cb) => { ipcRenderer.on('dl:updated', (_e, t) => cb(t)); },
  listLibrary: () => ipcRenderer.invoke('library:list'),
  openLibraryRoot: () => ipcRenderer.invoke('library:openRoot'),
  openLibraryAnime: (name) => ipcRenderer.invoke('library:openAnime', name),
  showLibraryFile: (file) => ipcRenderer.invoke('library:showFile', file),
  deleteLibraryFile: (file) => ipcRenderer.invoke('library:deleteFile', file),
  deleteLibraryAnime: (name) => ipcRenderer.invoke('library:deleteAnime', name),
  changeLibraryRoot: () => ipcRenderer.invoke('library:changeRoot'),
  onLibraryChanged: (cb) => { ipcRenderer.on('library:changed', () => cb()); },
  libraryReady: () => ipcRenderer.invoke('library:ready'),
  onDeletePrompt: (cb) => { ipcRenderer.on('library:deletePrompt', (_e, d) => cb(d)); },
  resolveDeletePrompt: (payload) => ipcRenderer.invoke('library:resolveDeletePrompt', payload),

  // Schedule (الجدول)
  schedList: () => ipcRenderer.invoke('sched:list'),
  schedWorks: () => ipcRenderer.invoke('sched:works'),
  schedCreate: (req) => ipcRenderer.invoke('sched:create', req),
  schedUpdate: (req) => ipcRenderer.invoke('sched:update', req),
  schedStart: (id) => ipcRenderer.invoke('sched:start', id),
  schedSchedule: (req) => ipcRenderer.invoke('sched:schedule', req),
  schedStop: (id) => ipcRenderer.invoke('sched:stop', id),
  schedDecide: (req) => ipcRenderer.invoke('sched:decide', req),
  schedDelete: (id) => ipcRenderer.invoke('sched:delete', id),
  onSchedUpdated: (cb) => { ipcRenderer.on('sched:updated', (_e, t) => cb(t)); },

  listOps: () => ipcRenderer.invoke('ops:list'),
  retryHost: (payload) => ipcRenderer.invoke('ops:retryHost', payload),
  onOpsUpdated: (callback) => {
    ipcRenderer.on('ops:updated', (_event, jobs) => callback(jobs));
  },
});
