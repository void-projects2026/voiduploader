const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');
const axios = require('axios');
const FormData = require('form-data');

const store = new Store({
  name: 'config',
  defaults: {
    doodstreamApiKey: '',
    earnvidApiKey: '',
    uploadsBaseDir: ''
  }
});

// Separate store for upload history (kept apart from config so it can grow
// large without bloating/complicating the small config file).
const historyStore = new Store({
  name: 'history',
  defaults: {
    batches: [] // { id, folderPath, folderName, createdAt, files: [{ name, size, links: { doodstream: url, earnvid: url } }] }
  }
});

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm']);

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------------------------------------------------------------------------
// Config (API keys) - stored locally via electron-store in the user data dir.
// Never hardcoded, never committed.
// ---------------------------------------------------------------------------
ipcMain.handle('config:get', () => {
  return {
    doodstreamApiKey: store.get('doodstreamApiKey', ''),
    earnvidApiKey: store.get('earnvidApiKey', '')
  };
});

ipcMain.handle('config:set', (_event, { doodstreamApiKey, earnvidApiKey }) => {
  if (typeof doodstreamApiKey === 'string') store.set('doodstreamApiKey', doodstreamApiKey);
  if (typeof earnvidApiKey === 'string') store.set('earnvidApiKey', earnvidApiKey);
  return true;
});

// ---------------------------------------------------------------------------
// Folder picking + scanning for video files
// ---------------------------------------------------------------------------
ipcMain.handle('folder:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('folder:scan', async (_event, folderPath) => {
  if (!folderPath || !fs.existsSync(folderPath)) return [];
  const entries = fs.readdirSync(folderPath, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .filter((name) => VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

  return files.map((name) => {
    const full = path.join(folderPath, name);
    const stat = fs.statSync(full);
    return { name, path: full, size: stat.size };
  });
});

// ---------------------------------------------------------------------------
// Upload flow
//
// Both DoodStream and EarnVid follow the same documented two-step flow:
//   1. GET  {base}/upload/server?key=API_KEY         -> { result: "https://.../upload/xx" }
//   2. POST multipart/form-data to that returned URL with the file
//      (DoodStream form field: api_key ; EarnVid form field: key)
//
// DoodStream docs: https://doodstream.com/api-docs (base https://doodapi.co/api)
// EarnVid docs:    https://earnvidsapi.com/api.html (base https://earnvidsapi.com/api)
// ---------------------------------------------------------------------------

const PROVIDERS = {
  doodstream: {
    serverEndpoint: (key) => `https://doodapi.co/api/upload/server?key=${encodeURIComponent(key)}`,
    accountInfoEndpoint: (key) => `https://doodapi.co/api/account/info?key=${encodeURIComponent(key)}`,
    fileFieldExtra: (form, key) => form.append('api_key', key),
    // DoodStream upload-server response shape (verified against
    // https://doodstream.com/api-docs): { status, msg, result: [{ filecode, ... }] }
    parseUploadResult: (json) => {
      if (json && json.status === 200 && json.result && json.result[0] && json.result[0].filecode) {
        const filecode = json.result[0].filecode;
        return { filecode, embedUrl: `https://doodstream.com/e/${filecode}` };
      }
      throw new Error((json && json.msg) || 'DoodStream upload failed');
    }
  },
  earnvid: {
    serverEndpoint: (key) => `https://earnvidsapi.com/api/upload/server?key=${encodeURIComponent(key)}`,
    accountInfoEndpoint: (key) => `https://earnvidsapi.com/api/account/info?key=${encodeURIComponent(key)}`,
    fileFieldExtra: (form, key) => form.append('key', key),
    // EarnVid upload-server response shape (verified against
    // https://earnvidsapi.com/api.html): { status, msg, files: [{ filecode, ... }] }
    parseUploadResult: (json) => {
      const entry = json && json.status === 200 && json.files && json.files[0];
      if (entry && entry.filecode) {
        return { filecode: entry.filecode, embedUrl: `https://xvs.tt/${entry.filecode}.html` };
      }
      throw new Error((json && json.msg) || 'EarnVid upload failed');
    }
  }
};

// ---------------------------------------------------------------------------
// API key validity check ("test connection") - hits the lightweight
// account/info endpoint documented for both providers. A 200 status with a
// result payload means the key is valid; anything else is reported back.
// ---------------------------------------------------------------------------
ipcMain.handle('provider:test', async (_event, { provider, apiKey }) => {
  const cfg = PROVIDERS[provider];
  if (!cfg) return { success: false, error: `Unknown provider: ${provider}` };
  const key = apiKey || store.get(provider === 'doodstream' ? 'doodstreamApiKey' : 'earnvidApiKey', '');
  if (!key) return { success: false, error: 'No API key entered' };
  try {
    const res = await axios.get(cfg.accountInfoEndpoint(key), { timeout: 15000 });
    const data = res.data;
    if (data && data.status === 200 && data.result) {
      return { success: true, account: data.result };
    }
    return { success: false, error: (data && data.msg) || 'Invalid API key' };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
});

// ---------------------------------------------------------------------------
// Reachability check for a resulting embed/download link (item 7).
// ---------------------------------------------------------------------------
ipcMain.handle('link:test', async (_event, url) => {
  if (!url) return { success: false, error: 'No URL' };
  try {
    let res;
    try {
      res = await axios.head(url, { timeout: 15000, maxRedirects: 5, validateStatus: () => true });
    } catch (headErr) {
      // Some hosts don't support HEAD; fall back to a ranged GET.
      res = await axios.get(url, {
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: () => true,
        headers: { Range: 'bytes=0-1024' },
        responseType: 'arraybuffer'
      });
    }
    const ok = res.status >= 200 && res.status < 400;
    return { success: ok, status: res.status };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
});

async function uploadOne(provider, filePath, apiKey, onProgress) {
  const cfg = PROVIDERS[provider];
  if (!cfg) throw new Error(`Unknown provider: ${provider}`);
  if (!apiKey) throw new Error(`Missing API key for ${provider}`);

  // Step 1: get an upload server URL
  const serverRes = await axios.get(cfg.serverEndpoint(apiKey), { timeout: 30000 });
  const uploadUrl = serverRes.data && serverRes.data.result;
  if (!uploadUrl) {
    throw new Error((serverRes.data && serverRes.data.msg) || 'Failed to get upload server');
  }

  // Step 2: multipart POST the file itself, with progress reporting
  const stat = fs.statSync(filePath);
  const form = new FormData();
  cfg.fileFieldExtra(form, apiKey);
  form.append('file', fs.createReadStream(filePath), { knownLength: stat.size });

  const totalLength = await new Promise((resolve, reject) => {
    form.getLength((err, length) => (err ? reject(err) : resolve(length)));
  });

  // IMPORTANT: form.getHeaders() only returns the multipart Content-Type
  // (with boundary) - it does NOT include Content-Length. Without an
  // explicit Content-Length header, Node's http client sends the request
  // with Transfer-Encoding: chunked, which (a) several of these upload
  // servers reject/hang on outright, causing uploads to silently fail or
  // time out, and (b) leaves axios's Node upload-progress tracker without
  // a known total, so progressEvent.total is undefined and percent/speed
  // reporting breaks. Setting Content-Length explicitly (we already know
  // the exact multipart body length from form.getLength) fixes both.
  const headers = { ...form.getHeaders(), 'Content-Length': totalLength };

  // Rolling speed sample: track the last (timestamp, loaded) pair so we can
  // compute an instantaneous-ish rate instead of a meaningless
  // total-bytes/total-time average that stays 0 until the transfer ends.
  let lastSampleTime = Date.now();
  let lastSampleLoaded = 0;
  let lastRateBytesPerSec = 0;

  const uploadRes = await axios.post(uploadUrl, form, {
    headers,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 0,
    onUploadProgress: (progressEvent) => {
      const loaded = progressEvent.loaded || 0;
      const total = progressEvent.total || totalLength || stat.size;
      const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;

      const now = Date.now();
      const elapsedSec = (now - lastSampleTime) / 1000;
      if (elapsedSec >= 0.25) {
        const bytesSinceLast = loaded - lastSampleLoaded;
        lastRateBytesPerSec = elapsedSec > 0 ? bytesSinceLast / elapsedSec : 0;
        lastSampleTime = now;
        lastSampleLoaded = loaded;
      }

      onProgress({ pct, loaded, total, bytesPerSec: Math.max(0, lastRateBytesPerSec) });
    }
  });

  return cfg.parseUploadResult(uploadRes.data);
}

ipcMain.handle('upload:file', async (event, { provider, filePath, id }) => {
  const keys = {
    doodstream: store.get('doodstreamApiKey', ''),
    earnvid: store.get('earnvidApiKey', '')
  };
  try {
    const result = await uploadOne(provider, filePath, keys[provider], (progress) => {
      event.sender.send('upload:progress', { id, provider, ...progress });
    });
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
});

// ---------------------------------------------------------------------------
// Folder creation (item 6): create a named organizational folder on disk
// under a configurable base directory, so uploads can be filed under a named
// work/series. We use a real on-disk folder (rather than a purely logical
// grouping in electron-store) because the existing workflow is already
// folder-driven - "Choose Folder" scans a real directory for video files -
// so creating a named folder the user can then immediately drop files into
// (or that already becomes the "Choose Folder" target) fits the existing
// mental model without inventing a second, parallel organizational system.
// ---------------------------------------------------------------------------
ipcMain.handle('folder:create', async (_event, { baseDir, name }) => {
  if (!name || !name.trim()) return { success: false, error: 'Folder name is required' };
  const safeName = name.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  let base = baseDir && baseDir.trim();
  if (!base) {
    base = store.get('uploadsBaseDir', '');
  }
  if (!base) {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
    if (result.canceled || !result.filePaths.length) return { success: false, error: 'No base directory chosen' };
    base = result.filePaths[0];
    store.set('uploadsBaseDir', base);
  }
  const fullPath = path.join(base, safeName);
  try {
    if (fs.existsSync(fullPath)) return { success: false, error: 'A folder with that name already exists' };
    fs.mkdirSync(fullPath, { recursive: true });
    return { success: true, path: fullPath };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
});

// ---------------------------------------------------------------------------
// Upload history (item 5): persisted via electron-store in userData dir.
// A "batch" is one folder-upload session; each batch holds every file and
// the per-provider links produced for it.
// ---------------------------------------------------------------------------
ipcMain.handle('history:addBatch', (_event, { folderPath, folderName }) => {
  const batches = historyStore.get('batches', []);
  const batch = {
    id: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    folderPath,
    folderName: folderName || path.basename(folderPath || ''),
    createdAt: new Date().toISOString(),
    files: []
  };
  batches.unshift(batch);
  historyStore.set('batches', batches);
  return batch;
});

ipcMain.handle('history:recordLink', (_event, { batchId, fileName, size, provider, url }) => {
  const batches = historyStore.get('batches', []);
  const batch = batches.find((b) => b.id === batchId);
  if (!batch) return false;
  let fileEntry = batch.files.find((f) => f.name === fileName);
  if (!fileEntry) {
    fileEntry = { name: fileName, size: size || 0, links: {} };
    batch.files.push(fileEntry);
  }
  fileEntry.links[provider] = url;
  historyStore.set('batches', batches);
  return true;
});

ipcMain.handle('history:list', () => {
  return historyStore.get('batches', []);
});

ipcMain.handle('history:clear', () => {
  historyStore.set('batches', []);
  return true;
});

// ---------------------------------------------------------------------------
// Clipboard (used by the history view; the main table already uses
// navigator.clipboard directly in the renderer, which works fine here since
// contextIsolation is on but the page is loaded via loadFile, not a remote
// origin, so the Clipboard API is permitted).
// ---------------------------------------------------------------------------
ipcMain.handle('clipboard:write', (_event, text) => {
  require('electron').clipboard.writeText(text || '');
  return true;
});
