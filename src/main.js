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
    earnvidApiKey: ''
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
    fileFieldExtra: (form, key) => form.append('api_key', key),
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
    fileFieldExtra: (form, key) => form.append('key', key),
    parseUploadResult: (json) => {
      const entry = json && json.status === 200 && json.files && json.files[0];
      if (entry && entry.filecode) {
        return { filecode: entry.filecode, embedUrl: `https://xvs.tt/${entry.filecode}.html` };
      }
      throw new Error((json && json.msg) || 'EarnVid upload failed');
    }
  }
};

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

  const uploadRes = await axios.post(uploadUrl, form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 0,
    onUploadProgress: (progressEvent) => {
      const loaded = progressEvent.loaded || 0;
      const total = progressEvent.total || totalLength || stat.size;
      const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
      onProgress(pct);
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
    const result = await uploadOne(provider, filePath, keys[provider], (pct) => {
      event.sender.send('upload:progress', { id, provider, pct });
    });
    return { success: true, ...result };
  } catch (err) {
    return { success: false, error: (err && err.message) || String(err) };
  }
});
