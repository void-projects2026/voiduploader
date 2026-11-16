const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const site = require('./lib/site');
const { HOST_KEYS } = require('./lib/hosts');
const { sessionStore, configStore, listJobs, upsertJob, getJob } = require('./lib/stores');
const uploadManager = require('./lib/uploadManager');

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm']);

let mainWindow;
let tray;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);

  // Dev: load the Vite dev server (HMR - edits show up instantly, no
  // rebuild/reinstall). Packaged app: load the pre-built static files.
  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
  }

  // Uploads must keep running even if the window is closed - minimize to
  // tray instead of quitting, per the owner's explicit choice (simplest +
  // safest: single process, no separate background service).
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  const image = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(image);
  tray.setToolTip('Despair Downloader');
  const menu = Menu.buildFromTemplate([
    { label: 'إظهار التطبيق', click: () => mainWindow.show() },
    { type: 'separator' },
    {
      label: 'خروج',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => mainWindow.show());
}

function sendUpdateStatus(status, extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', { status, ...extra });
  }
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }));
autoUpdater.on('update-not-available', () => sendUpdateStatus('up-to-date'));
autoUpdater.on('download-progress', (p) => sendUpdateStatus('downloading', { percent: Math.round(p.percent) }));
autoUpdater.on('update-downloaded', (info) => sendUpdateStatus('ready', { version: info.version }));
autoUpdater.on('error', (err) => sendUpdateStatus('error', { message: err?.message }));

ipcMain.handle('update:check', () => autoUpdater.checkForUpdates().catch((err) => sendUpdateStatus('error', { message: err?.message })));
ipcMain.handle('update:install', () => autoUpdater.quitAndInstall());

app.whenReady().then(() => {
  createWindow();
  createTray();
  if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
});

app.on('window-all-closed', () => {
  // Intentionally no-op: closing all windows must not kill background
  // uploads. Quitting only happens via the tray's "خروج".
});

app.on('before-quit', () => {
  isQuitting = true;
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
ipcMain.handle('auth:login', async (_event, { email, password }) => {
  const result = await site.login(email, password);
  if (!result.success) return result;
  sessionStore.set('accessToken', result.session.accessToken);
  sessionStore.set('refreshToken', result.session.refreshToken);
  sessionStore.set('userId', result.session.userId);
  sessionStore.set('profile', result.profile);
  return result;
});

ipcMain.handle('auth:getSession', async () => {
  const accessToken = sessionStore.get('accessToken', '');
  const profile = sessionStore.get('profile', null);
  if (!accessToken || !profile) return { loggedIn: false };
  return { loggedIn: true, profile };
});

ipcMain.handle('auth:logout', async () => {
  sessionStore.set('accessToken', '');
  sessionStore.set('refreshToken', '');
  sessionStore.set('userId', '');
  sessionStore.set('profile', null);
  return true;
});

function currentToken() {
  return sessionStore.get('accessToken', '');
}

// ---------------------------------------------------------------------------
// Anime works / episodes
// ---------------------------------------------------------------------------
ipcMain.handle('anime:searchWorks', (_e, q) => site.searchAnimeWorks(currentToken(), q));
ipcMain.handle('anime:anilistSearch', (_e, q) => site.anilistSearch(currentToken(), q));
ipcMain.handle('anime:anilistTranslatePreview', (_e, payload) => site.anilistTranslatePreview(currentToken(), payload));
ipcMain.handle('anime:anilistCreate', (_e, payload) => site.anilistCreate(currentToken(), payload));
ipcMain.handle('anime:listEpisodes', (_e, animeId) => site.listEpisodes(currentToken(), animeId));
ipcMain.handle('anime:createEpisode', (_e, payload) => site.createEpisode(currentToken(), payload));
ipcMain.handle('anime:listHostJobs', (_e, episodeId) => site.listHostJobs(currentToken(), episodeId));

// ---------------------------------------------------------------------------
// Config (concurrency only - host keys come from the server per-upload)
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => ({
  concurrency: configStore.get('concurrency', 3),
}));

ipcMain.handle('config:set', (_e, cfg) => {
  if (Number.isFinite(cfg.concurrency)) uploadManager.setConcurrency(cfg.concurrency);
  return true;
});

ipcMain.handle('app:getVersion', () => app.getVersion());

// ---------------------------------------------------------------------------
// Folder / file pickers
// ---------------------------------------------------------------------------
ipcMain.handle('file:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('folder:pickAndScan', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  const folderPath = result.filePaths[0];
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  return {
    folderPath,
    files: files.map((name) => {
      const full = path.join(folderPath, name);
      const match = name.match(/(\d{1,4})(?!.*\d)/);
      return { name, path: full, size: fs.statSync(full).size, guessedEpisode: match ? Number(match[1]) : null };
    }),
  };
});

// ---------------------------------------------------------------------------
// Upload orchestration + operations table
// ---------------------------------------------------------------------------
ipcMain.handle('upload:checkEpisode', async (_e, { animeId, episodeNumber }) => {
  const { episodes, success, error } = await site.listEpisodes(currentToken(), animeId);
  if (!success) return { success: false, error };
  const existing = episodes.find((ep) => Number(ep.episode_number) === Number(episodeNumber));
  if (!existing) return { success: true, exists: false };
  const { jobs } = await site.listHostJobs(currentToken(), existing.id).catch(() => ({ jobs: [] }));
  const hostsPresent = {};
  HOST_KEYS.forEach((h) => {
    const j = (jobs || []).find((row) => row.host === h);
    hostsPresent[h] = !!(j && j.status === 'done');
  });
  return { success: true, exists: true, episodeId: existing.id, hostsPresent };
});

ipcMain.handle('upload:queueEpisode', async (_e, { animeId, animeTitle, episodeNumber, filePath, hosts, title, teamId, isFree }) => {
  let episodeId;
  const existing = await site.listEpisodes(currentToken(), animeId);
  const found = existing.success ? existing.episodes.find((ep) => Number(ep.episode_number) === Number(episodeNumber)) : null;
  if (found) {
    episodeId = found.id;
  } else {
    const created = await site.createEpisode(currentToken(), { animeId, episodeNumber, title, teamId, isFree });
    if (!created.success) return created;
    episodeId = created.episode.id;
  }
  const job = uploadManager.queueEpisodeUpload({
    animeId,
    animeTitle,
    episodeId,
    episodeNumber,
    filePath,
    hosts,
    accessToken: currentToken(),
  });
  broadcastOps();
  return { success: true, job };
});

ipcMain.handle('ops:list', () => listJobs());

ipcMain.handle('ops:retryHost', async (_e, { jobId, host }) => {
  const job = getJob(jobId);
  if (!job) return { success: false, error: 'المهمة غير موجودة' };
  await uploadManager.retryHostUpload({
    jobId,
    episodeId: job.episodeId,
    animeId: job.animeId,
    host,
    filePath: job.filePath,
    accessToken: currentToken(),
    onUpdate: (patch) => {
      const current = getJob(jobId);
      const hostsArr = current.hosts.map((h) => (h.host === patch.host ? { ...h, ...patch } : h));
      upsertJob({ id: jobId, hosts: hostsArr });
      broadcastOps();
    },
  });
  return { success: true };
});

function broadcastOps() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ops:updated', listJobs());
  }
}

setInterval(broadcastOps, 3000);
