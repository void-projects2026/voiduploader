'use strict';

// "الجدول": unattended batch tasks. A task = a list of works, each with the
// episodes to fetch (via the download tool) and push to all three hosts.
// Runs one task at a time, one episode at a time:
//   check site -> download (source, then fallback source) -> upload ->
//   (auto-delete once confirmed on N hosts) -> pause -> next episode.

const Store = require('electron-store');
const pyTool = require('./pyTool');
const library = require('./library');
const site = require('./site');
const { configStore, getJob, upsertJob } = require('./stores');

const HOSTS = ['earnvid', 'doodstream', 'voe'];
const HOST_LABEL = { earnvid: 'EarnVid', doodstream: 'Doodstream', voe: 'Voe' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const DEFAULT_OPTIONS = {
  skipOnFail: true, // keep going when only some hosts failed (episode still got uploaded)
  deleteEnabled: true,
  deleteAfterHosts: 1,
  sources: ['anime_slayer', 'anime3rb'], // primary, then fallback
  pauseSec: 5,
  hosts: HOSTS,
};

function init({ ipcMain, getWindow, withAuthRetry, currentToken, queueEpisode, retryHost }) {
  const store = new Store({ name: 'schedule', defaults: { tasks: [] } });
  const INTERRUPTED = new Set(['running', 'waiting_decision', 'stopping']);
  let tasks = store.get('tasks', []).map((t) =>
    INTERRUPTED.has(t.status) ? { ...t, status: 'stopped', current: null, pendingDecision: null, note: 'توقفت لأن التطبيق أُغلق أثناء التشغيل' } : t
  );
  const runtime = new Map(); // taskId -> { stop, decide, bridgeId }

  const send = (channel, payload) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };
  let persistTimer = null;
  let sendTimer = null;
  const touch = () => {
    if (!persistTimer) persistTimer = setTimeout(() => { persistTimer = null; store.set('tasks', tasks); }, 1000);
    if (!sendTimer) sendTimer = setTimeout(() => { sendTimer = null; send('sched:updated', tasks); }, 250);
  };
  const log = (task, msg, level = 'info') => {
    task.log.push({ t: new Date().toISOString(), msg, level });
    if (task.log.length > 300) task.log.splice(0, task.log.length - 300);
    touch();
  };

  // -------------------------------------------------------------------------
  // Download one episode: primary source, then each fallback source.
  // -------------------------------------------------------------------------
  async function resolveOnProvider(item, provider, ep) {
    const queries = [...new Set([item.anime.title, item.workTitle, item.workTitleEn].filter(Boolean))];
    const wanted = new Set(queries.map(norm));
    for (const q of queries) {
      const sr = await pyTool.request('search', { provider, query: q }).promise.catch(() => null);
      const hit = (sr?.results || []).find((r) => {
        const names = [r.title_en, r.title_ar, r.title_jp, r.title_romaji].map(norm).filter(Boolean);
        return names.some((n) => wanted.has(n));
      });
      if (!hit) continue; // exact match only: a wrong anime must never get uploaded
      const er = await pyTool.request('episodes', { provider, anime_id: hit.id }).promise.catch(() => null);
      const match = (er?.episodes || []).find((e) => Number(e.display_num) === Number(ep.display));
      if (match) return { anime: { id: hit.id, type: hit.type || 'SERIES' }, number: String(match.number) };
    }
    return null;
  }

  async function downloadEpisode(task, item, ep, rt, setCur) {
    const providers = [item.provider, ...task.options.sources.filter((s) => s !== item.provider)];
    let lastErr = '';
    for (let i = 0; i < providers.length; i += 1) {
      if (rt.stop) return { ok: false, error: 'stopped' };
      const prov = providers[i];
      let ref = { anime: { id: item.anime.id, type: item.anime.type }, number: String(ep.number) };
      if (i > 0) {
        setCur('resolving', { provider: prov });
        ref = await resolveOnProvider(item, prov, ep);
        if (!ref) {
          lastErr = `لم يُعثر على العمل في المصدر الاحتياطي ${prov}`;
          log(task, lastErr, 'warn');
          continue;
        }
        log(task, `التحميل من المصدر الاحتياطي ${prov}`, 'warn');
      }
      setCur('downloading', { provider: prov, dl: { done: 0, total: null, speed: 0 } });
      let path = null;
      let err = null;
      let prev = null;
      const { id, promise } = pyTool.request(
        'download',
        {
          provider: prov,
          anime: { id: ref.anime.id, title: item.anime.title, type: ref.anime.type },
          episodes: [ref.number],
          quality: item.quality,
          out_dir: library.ensureRoot(),
          parallel: 1,
          speed_limit: Math.round(configStore.get('downloadSpeedMB', 0) * 1048576),
        },
        (ev) => {
          if (ev.type === 'progress' && task.current) {
            const now = Date.now();
            let speed = task.current.dl?.speed || 0;
            if (prev && ev.done >= prev.done && now > prev.t) {
              const inst = ((ev.done - prev.done) / (now - prev.t)) * 1000;
              speed = speed ? speed * 0.6 + inst * 0.4 : inst;
            }
            prev = { done: ev.done, t: now };
            task.current.dl = { done: ev.done, total: ev.total, speed };
            touch();
          } else if (ev.type === 'episode_done') path = ev.path;
          else if (ev.type === 'episode_error') err = ev.error;
        }
      );
      rt.bridgeId = id;
      try {
        await promise;
      } catch (e) {
        err = err || e.message;
      }
      rt.bridgeId = null;
      send('library:changed', null);
      if (path) return { ok: true, path, provider: prov };
      if (rt.stop) return { ok: false, error: 'stopped' };
      lastErr = err || 'فشل التحميل';
      log(task, `فشل التحميل من ${prov}: ${lastErr}`, 'warn');
    }
    return { ok: false, error: lastErr };
  }

  // Poll the persisted upload job until every host attempt settles.
  async function waitJob(jobId, task) {
    const deadline = Date.now() + 6 * 3600 * 1000;
    for (;;) {
      const job = getJob(jobId);
      if (!job) throw new Error('مهمة الرفع اختفت');
      if (task.current) {
        task.current.hosts = job.hosts.map((h) => ({ host: h.host, status: h.status, progress: h.progress }));
        touch();
      }
      if (job.hosts.every((h) => h.status === 'done' || h.status === 'error')) return job;
      if (Date.now() > deadline) throw new Error('انتهت مهلة الرفع');
      await sleep(2000);
    }
  }

  // Pause the task and wait for the user's "skip / stop" answer.
  async function decide(task, item, ep, reason, rt) {
    task.status = 'waiting_decision';
    task.pendingDecision = { itemId: item.id, title: item.workTitle, ep: ep.display, reason };
    log(task, `توقف مؤقت: ${item.workTitle} حلقة ${ep.display} — ${reason}`, 'error');
    send('sched:updated', tasks);
    const choice = await new Promise((resolve) => { rt.decide = resolve; });
    rt.decide = null;
    task.pendingDecision = null;
    if (choice !== 'stop') task.status = 'running';
    touch();
    return choice === 'stop' ? 'stop' : 'ok';
  }

  async function processEpisode(task, item, ep, rt) {
    const res = item.results[ep.display];
    const setCur = (phase, extra = {}) => {
      task.current = { itemId: item.id, title: item.workTitle, ep: ep.display, phase, ...extra };
      touch();
    };
    const fail = async (msg) => {
      res.state = 'failed';
      res.message = msg;
      return decide(task, item, ep, msg, rt);
    };

    res.state = 'running';
    setCur('checking');
    const present = await withAuthRetry((t) => site.episodeHosts(t, item.workId));
    const have = (present.success && present.hosts[Number(ep.display)]) || {};
    const targets = task.options.hosts.filter((h) => !have[h]);
    if (!targets.length) {
      res.state = 'skipped';
      res.message = 'موجودة بالفعل على كل السيرفرات';
      log(task, `${item.workTitle} حلقة ${ep.display}: موجودة بالفعل، تخطي`);
      return 'ok';
    }

    const dl = await downloadEpisode(task, item, ep, rt, setCur);
    if (rt.stop) { res.state = 'pending'; return 'stop'; }
    if (!dl.ok) return fail(`فشل التحميل من كل المصادر: ${dl.error}`);

    setCur('uploading', { hosts: [] });
    const queued = await queueEpisode({
      animeId: item.workId,
      animeTitle: item.workTitle,
      episodeNumber: Number(ep.display),
      filePath: dl.path,
      hosts: targets,
      extra: { deletePrompted: true, scheduledTaskId: task.id }, // the task decides about deleting, never the popup
    });
    if (!queued.success) return fail(queued.error || 'فشل بدء الرفع');

    let job;
    try {
      job = await waitJob(queued.job.id, task);
      const errored = job.hosts.filter((h) => h.status === 'error').map((h) => h.host);
      if (errored.length && !rt.stop) {
        log(task, `إعادة محاولة تلقائية: ${errored.map((h) => HOST_LABEL[h]).join('، ')}`, 'warn');
        await Promise.all(errored.map((h) => retryHost(queued.job.id, h).catch(() => {})));
        job = await waitJob(queued.job.id, task);
      }
    } catch (e) {
      return fail(e.message || 'خطأ أثناء الرفع');
    }

    const newlyDone = job.hosts.filter((h) => h.status === 'done').length;
    const failedHosts = job.hosts.filter((h) => h.status === 'error');
    const confirmed = HOSTS.length - targets.length + newlyDone; // hosts that now have this episode

    if (task.options.deleteEnabled && newlyDone >= 1 && confirmed >= task.options.deleteAfterHosts) {
      const removed = library.deleteFile(dl.path);
      upsertJob({ id: job.id, fileDeleted: removed });
      send('library:changed', null);
      if (removed) log(task, `تم مسح الحلقة ${ep.display} من الجهاز (مؤكدة على ${confirmed} استضافة)`);
    }

    if (newlyDone === 0) {
      return fail(`فشل الرفع على كل السيرفرات: ${failedHosts.map((h) => `${HOST_LABEL[h.host]} (${h.error || '؟'})`).join('، ')}`);
    }
    if (failedHosts.length) {
      const names = failedHosts.map((h) => HOST_LABEL[h.host]).join('، ');
      res.state = 'partial';
      res.message = `فشل على: ${names}`;
      log(task, `${item.workTitle} حلقة ${ep.display}: رُفعت، لكن فشل على ${names}`, 'warn');
      if (!task.options.skipOnFail) return decide(task, item, ep, res.message, rt);
      return 'ok';
    }
    res.state = 'done';
    res.message = '';
    log(task, `${item.workTitle} حلقة ${ep.display}: تم على ${newlyDone} استضافة`, 'ok');
    return 'ok';
  }

  async function sleepInterruptible(ms, rt) {
    const end = Date.now() + ms;
    while (Date.now() < end && !rt.stop) await sleep(250);
  }

  async function run(task) {
    const rt = { stop: false, decide: null, bridgeId: null };
    runtime.set(task.id, rt);
    task.status = 'running';
    task.startedAt = task.startedAt || new Date().toISOString();
    task.finishedAt = null;
    task.startAt = null;
    task.error = null;
    task.note = '';
    log(task, 'بدأ تشغيل المهمة');
    try {
      if (!pyTool.status().ready) throw new Error('أداة التحميل غير مجهّزة — جهّزها من تاب «التحميل» أولاً');
      const SETTLED = new Set(['done', 'partial', 'skipped']);
      outer: for (const item of task.items) {
        item.status = 'running';
        for (let i = 0; i < item.episodes.length; i += 1) {
          const ep = item.episodes[i];
          if (rt.stop) break outer;
          if (SETTLED.has(item.results[ep.display].state)) continue;
          const outcome = await processEpisode(task, item, ep, rt);
          if (outcome === 'stop' || rt.stop) { rt.stop = true; break outer; }
          const more = item.episodes.slice(i + 1).some((e) => !SETTLED.has(item.results[e.display].state)) || task.items.some((it) => it !== item && it.status !== 'done');
          if (more && task.options.pauseSec > 0) {
            task.current = { itemId: item.id, title: item.workTitle, ep: ep.display, phase: 'pausing' };
            touch();
            await sleepInterruptible(task.options.pauseSec * 1000, rt);
          }
        }
        item.status = item.episodes.every((e) => SETTLED.has(item.results[e.display].state)) ? 'done' : 'incomplete';
      }
      task.status = rt.stop ? 'stopped' : 'done';
      task.finishedAt = new Date().toISOString();
      const all = task.items.flatMap((it) => Object.values(it.results));
      log(task, rt.stop ? 'تم إيقاف المهمة' : `انتهت المهمة: ${all.filter((r) => r.state === 'done').length} ناجحة، ${all.filter((r) => r.state === 'partial').length} جزئية، ${all.filter((r) => r.state === 'failed').length} فاشلة`, rt.stop ? 'warn' : 'ok');
    } catch (err) {
      task.status = 'error';
      task.error = (err && err.message) || String(err);
      log(task, `خطأ: ${task.error}`, 'error');
    } finally {
      task.current = null;
      task.pendingDecision = null;
      runtime.delete(task.id);
      touch();
      setTimeout(pump, 500);
    }
  }

  function pump() {
    if (tasks.some((t) => INTERRUPTED.has(t.status))) return; // one task at a time
    const now = Date.now();
    const next = tasks.find((t) => t.status === 'queued' || (t.status === 'scheduled' && t.startAt && new Date(t.startAt).getTime() <= now));
    if (next) run(next);
  }
  setInterval(pump, 15000);

  // -------------------------------------------------------------------------
  // IPC
  // -------------------------------------------------------------------------
  const find = (id) => tasks.find((t) => t.id === id);

  ipcMain.handle('sched:list', () => tasks);
  ipcMain.handle('sched:works', () => withAuthRetry((t) => site.listWorksWithHosts(t)));

  ipcMain.handle('sched:create', (_e, req) => {
    if (!req.items || !req.items.length) return { success: false, error: 'أضف عملاً واحدًا على الأقل' };
    const options = { ...DEFAULT_OPTIONS, ...(req.options || {}), hosts: HOSTS };
    options.deleteAfterHosts = Math.max(1, Math.min(3, Number(options.deleteAfterHosts) || 1));
    options.pauseSec = Math.max(0, Math.min(600, Number(options.pauseSec) || 0));
    const task = {
      id: `sch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: (req.name || '').trim() || `مهمة ${tasks.length + 1}`,
      createdAt: new Date().toISOString(),
      status: req.mode === 'now' ? 'queued' : req.mode === 'at' ? 'scheduled' : 'draft',
      startAt: req.mode === 'at' ? req.startAt : null,
      options,
      items: req.items.map((it, i) => ({
        id: `it_${i}_${Math.random().toString(36).slice(2, 5)}`,
        workId: it.workId,
        workTitle: it.workTitle,
        workTitleEn: it.workTitleEn || '',
        coverUrl: it.coverUrl || '',
        provider: it.provider,
        quality: it.quality || '1080p',
        anime: it.anime,
        episodes: [...it.episodes].sort((a, b) => Number(a.display) - Number(b.display)),
        status: 'pending',
        results: Object.fromEntries(it.episodes.map((e) => [e.display, { state: 'pending', message: '' }])),
      })),
      log: [],
      current: null,
      pendingDecision: null,
    };
    if (task.status === 'scheduled' && !(new Date(task.startAt).getTime() > 0)) return { success: false, error: 'وقت الجدولة غير صالح' };
    tasks.unshift(task);
    log(task, 'تم إنشاء المهمة');
    send('sched:updated', tasks);
    setTimeout(pump, 200);
    return { success: true, id: task.id };
  });

  ipcMain.handle('sched:update', (_e, { id, name, options }) => {
    const t = find(id);
    if (!t || INTERRUPTED.has(t.status)) return { success: false, error: 'لا يمكن التعديل أثناء التشغيل' };
    if (name) t.name = name;
    if (options) {
      t.options = { ...t.options, ...options, hosts: HOSTS };
      t.options.deleteAfterHosts = Math.max(1, Math.min(3, Number(t.options.deleteAfterHosts) || 1));
      t.options.pauseSec = Math.max(0, Math.min(600, Number(t.options.pauseSec) || 0));
    }
    touch();
    return { success: true };
  });

  ipcMain.handle('sched:start', (_e, id) => {
    const t = find(id);
    if (!t || INTERRUPTED.has(t.status)) return { success: false };
    t.status = 'queued';
    t.startAt = null;
    log(t, 'في الانتظار للتشغيل');
    pump();
    return { success: true };
  });

  ipcMain.handle('sched:schedule', (_e, { id, startAt }) => {
    const t = find(id);
    if (!t || INTERRUPTED.has(t.status)) return { success: false };
    if (!(new Date(startAt).getTime() > 0)) return { success: false, error: 'وقت غير صالح' };
    t.status = 'scheduled';
    t.startAt = startAt;
    log(t, `مجدولة على ${new Date(startAt).toLocaleString('ar-EG')}`);
    return { success: true };
  });

  ipcMain.handle('sched:stop', (_e, id) => {
    const t = find(id);
    if (!t) return { success: false };
    const rt = runtime.get(id);
    if (rt) {
      rt.stop = true;
      if (t.status === 'running') t.status = 'stopping';
      if (rt.bridgeId) pyTool.request('cancel', { target: rt.bridgeId }).promise.catch(() => {});
      if (rt.decide) rt.decide('stop');
      log(t, 'طُلب الإيقاف (بعد انتهاء رفع الحلقة الجارية إن وُجد)', 'warn');
    } else if (t.status === 'queued' || t.status === 'scheduled') {
      t.status = 'stopped';
      t.startAt = null;
      log(t, 'تم الإيقاف', 'warn');
    }
    return { success: true };
  });

  ipcMain.handle('sched:decide', (_e, { id, choice }) => {
    const rt = runtime.get(id);
    if (rt && rt.decide) {
      if (choice === 'stop') rt.stop = true;
      rt.decide(choice);
      return { success: true };
    }
    return { success: false };
  });

  ipcMain.handle('sched:delete', (_e, id) => {
    const t = find(id);
    if (!t || INTERRUPTED.has(t.status)) return { success: false, error: 'أوقف المهمة أولاً' };
    tasks = tasks.filter((x) => x.id !== id);
    touch();
    return { success: true };
  });

  setTimeout(pump, 3000);
}

module.exports = { init };
