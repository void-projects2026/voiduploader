'use strict';

// IPC for the download tool (search/providers/episodes/download), the
// "تحميلاتي" library, and the post-upload "delete the local copies?" prompt.

const fs = require('fs');
const path = require('path');
const Store = require('electron-store');
const pyTool = require('./pyTool');
const library = require('./library');
const { configStore, listJobs, upsertJob, getJob } = require('./stores');

const dlStore = new Store({ name: 'downloads', defaults: { tasks: [] } });
const ACTIVE = new Set(['pending', 'waiting', 'uploading']);

function registerToolIpc({ ipcMain, shell, dialog, getWindow }) {
  const send = (channel, payload) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };

  // ---- download tasks (in memory, persisted so the list survives restarts) --
  let tasks = dlStore.get('tasks', []).map((t) =>
    t.status === 'running' ? { ...t, status: 'interrupted', bridgeId: null } : t
  );
  const lastSample = new WeakMap();
  let persistTimer = null;
  let broadcastTimer = null;

  const persist = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => dlStore.set('tasks', tasks.slice(0, 60)), 800);
  };
  const broadcast = () => {
    if (broadcastTimer) return;
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      send('dl:updated', tasks);
    }, 300);
  };
  const touch = () => { persist(); broadcast(); };

  function runTask(task, episodes) {
    task.status = 'running';
    task.error = null;
    for (const n of episodes) {
      task.episodes[n] = { ...(task.episodes[n] || {}), status: 'queued', error: null };
    }
    const { id, promise } = pyTool.request(
      'download',
      {
        provider: task.provider,
        anime: { id: task.animeId, title: task.animeTitle, type: task.animeType },
        episodes,
        quality: task.quality,
        out_dir: library.ensureRoot(),
        parallel: configStore.get('downloadParallel', 2),
        speed_limit: Math.round(configStore.get('downloadSpeedMB', 0) * 1048576),
      },
      (ev) => {
        const e = task.episodes[ev.episode];
        if (ev.type === 'progress' && e) {
          // Live speed (smoothed) from successive byte counts - shown even
          // when the server never told us the total size.
          const now = Date.now();
          const prev = lastSample.get(e);
          if (prev && ev.done >= prev.done && now > prev.t) {
            const inst = ((ev.done - prev.done) / (now - prev.t)) * 1000;
            e.speed = e.speed ? e.speed * 0.6 + inst * 0.4 : inst;
          }
          lastSample.set(e, { done: ev.done, t: now });
          Object.assign(e, { status: ev.state === 'resolving' ? 'resolving' : 'downloading', done: ev.done, total: ev.total });
        } else if (ev.type === 'episode_done' && e) {
          Object.assign(e, { status: 'done', path: ev.path, done: ev.size, total: ev.size, error: null, speed: 0 });
          send('library:changed', null);
        } else if (ev.type === 'episode_error' && e) {
          Object.assign(e, { status: 'error', error: ev.error });
        }
        touch();
      }
    );
    task.bridgeId = id;
    touch();
    promise
      .then((fin) => {
        task.status = fin && fin.cancelled ? 'cancelled' : 'done';
        if (fin && fin.folder) task.folder = fin.folder;
      })
      .catch((err) => {
        task.status = 'error';
        task.error = (err && err.message) || String(err);
        for (const e of Object.values(task.episodes)) {
          if (e.status === 'queued' || e.status === 'resolving' || e.status === 'downloading') e.status = 'error';
        }
      })
      .finally(() => {
        task.bridgeId = null;
        touch();
        send('library:changed', null);
      });
  }

  ipcMain.handle('tool:status', () => pyTool.status());
  ipcMain.handle('tool:setup', (_e, opts) => pyTool.setup((p) => send('tool:setupProgress', p), opts || {}));

  const wrap = async (fn) => {
    try { return { success: true, ...(await fn()) }; } catch (err) { return { success: false, error: (err && err.message) || String(err) }; }
  };
  ipcMain.handle('tool:providers', () => wrap(() => pyTool.request('providers', {}).promise));
  ipcMain.handle('tool:search', (_e, { provider, query }) => wrap(() => pyTool.request('search', { provider, query }).promise));
  ipcMain.handle('tool:episodes', (_e, { provider, animeId }) => wrap(() => pyTool.request('episodes', { provider, anime_id: animeId }).promise));

  ipcMain.handle('tool:getSettings', () => ({
    downloadsDir: library.root(),
    quality: configStore.get('downloadQuality', '1080p'),
    parallel: configStore.get('downloadParallel', 2),
    speedMB: configStore.get('downloadSpeedMB', 0),
  }));
  ipcMain.handle('tool:setSettings', (_e, s) => {
    if (s.quality) configStore.set('downloadQuality', s.quality);
    if (Number.isFinite(s.speedMB)) configStore.set('downloadSpeedMB', Math.max(0, s.speedMB));
    if (Number.isFinite(s.parallel)) configStore.set('downloadParallel', Math.max(1, Math.min(4, s.parallel)));
    return true;
  });

  ipcMain.handle('dl:start', (_e, { provider, anime, episodes, quality }) => {
    if (!episodes || !episodes.length) return { success: false, error: 'اختر حلقة واحدة على الأقل' };
    const task = {
      id: `dl_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      provider,
      animeId: anime.id,
      animeTitle: anime.title,
      animeType: anime.type || 'SERIES',
      cover: anime.cover || '',
      quality: quality || configStore.get('downloadQuality', '1080p'),
      createdAt: new Date().toISOString(),
      status: 'running',
      episodes: {},
    };
    tasks.unshift(task);
    runTask(task, episodes.map(String));
    return { success: true, taskId: task.id };
  });

  // Retries everything not finished (failed / cancelled / interrupted). The
  // tool resumes .part files and skips complete ones.
  ipcMain.handle('dl:retry', (_e, taskId) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === 'running') return { success: false };
    const todo = Object.keys(task.episodes).filter((n) => task.episodes[n].status !== 'done');
    if (!todo.length) return { success: false, error: 'كل الحلقات مكتملة' };
    runTask(task, todo);
    return { success: true };
  });

  ipcMain.handle('dl:cancel', async (_e, taskId) => {
    const task = tasks.find((t) => t.id === taskId);
    if (task && task.bridgeId) await pyTool.request('cancel', { target: task.bridgeId }).promise.catch(() => {});
    return true;
  });

  ipcMain.handle('dl:list', () => tasks);
  ipcMain.handle('dl:clearFinished', () => {
    tasks = tasks.filter((t) => t.status === 'running');
    touch();
    return tasks;
  });

  // ---- library -------------------------------------------------------------
  ipcMain.handle('library:list', () => library.list());
  ipcMain.handle('library:openRoot', async () => {
    await shell.openPath(library.ensureRoot());
    return true;
  });
  ipcMain.handle('library:openAnime', async (_e, name) => {
    const dir = path.join(library.root(), path.basename(name));
    if (!library.isInside(dir)) return false;
    await shell.openPath(dir);
    return true;
  });
  ipcMain.handle('library:showFile', (_e, file) => {
    if (!library.isInside(file)) return false;
    shell.showItemInFolder(file);
    return true;
  });
  ipcMain.handle('library:deleteFile', (_e, file) => {
    const ok = library.deleteFile(file);
    send('library:changed', null);
    return ok;
  });
  ipcMain.handle('library:deleteAnime', (_e, name) => {
    const ok = library.deleteAnime(name);
    send('library:changed', null);
    return ok;
  });
  ipcMain.handle('library:changeRoot', async () => {
    const res = await dialog.showOpenDialog(getWindow(), { properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths.length) return null;
    configStore.set('downloadsDir', res.filePaths[0]);
    send('library:changed', null);
    return res.filePaths[0];
  });

  // ---- "delete local copies after upload?" ---------------------------------
  // A job is eligible once every host attempt has settled, at least one
  // succeeded, and its file is inside the downloads folder. We wait until the
  // whole queue is idle so a batch yields ONE prompt ("delete N episodes?").
  let promptOpen = false;

  const settled = (j) => j.hosts.length > 0 && j.hosts.every((h) => h.status === 'done' || h.status === 'error' || h.status === 'processing');
  const inLibrary = (j) => j.filePath && library.isInside(j.filePath);

  function eligibleJobs() {
    return listJobs().filter(
      (j) => !j.deletePrompted && inLibrary(j) && settled(j) && j.hosts.some((h) => h.status === 'done' || h.status === 'processing') && fs.existsSync(j.filePath)
    );
  }

  function checkDeletePrompt() {
    if (promptOpen) return;
    const busy = listJobs().some((j) => inLibrary(j) && j.hosts.some((h) => ACTIVE.has(h.status)) && fs.existsSync(j.filePath));
    if (busy) return;
    const items = eligibleJobs();
    if (!items.length) return;
    promptOpen = true;
    send('library:deletePrompt', {
      items: items.map((j) => ({
        jobId: j.id,
        animeTitle: j.animeTitle,
        episodeNumber: j.episodeNumber,
        fileName: j.fileName,
        size: (() => { try { return fs.statSync(j.filePath).size; } catch { return 0; } })(),
      })),
    });
  }

  ipcMain.handle('library:ready', () => {
    promptOpen = false; // renderer (re)mounted: any open modal is gone
    return true;
  });

  ipcMain.handle('library:resolveDeletePrompt', (_e, { jobIds, doDelete }) => {
    let deleted = 0;
    for (const id of jobIds || []) {
      const job = getJob(id);
      if (!job) continue;
      // Re-verify here: never delete on the renderer's word alone.
      const ok = doDelete && !job.deletePrompted && inLibrary(job) && settled(job) && job.hosts.some((h) => h.status === 'done');
      let removed = false;
      if (ok) removed = library.deleteFile(job.filePath);
      if (removed) deleted += 1;
      upsertJob({ id, deletePrompted: true, fileDeleted: removed });
    }
    promptOpen = false;
    send('library:changed', null);
    return { deleted };
  });

  const timer = setInterval(checkDeletePrompt, 4000);
  return { stop: () => clearInterval(timer) };
}

module.exports = { registerToolIpc };
