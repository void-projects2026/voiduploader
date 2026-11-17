'use strict';

const path = require('path');
const fs = require('fs');
const { uploadFile } = require('./hosts');
const { pollProcessing } = require('./hostStatus');
const { RelayClient, relayHostToJobState } = require('./relayClient');
const { classifyError, sleep } = require('./netErrors');
const site = require('./site');
const { configStore, upsertJob, getJob } = require('./stores');

// Per-host job state shown by the UI (persisted in the ops store):
//   status: pending | waiting | uploading | processing | done | error
//   stage : sending | processing | done | error | relay-queue
//   progress/loaded/total/bytesPerSec  -> REAL bytes sent (never faked)
//   attempt/maxAttempts/note/stalled   -> dead-node retries ("trying another server 2/6")
//   processing: { state, pct|null, minPct?, indeterminate? } -> what the host API reports about its own encoding
//   errClass / error (short Arabic) / detail (technical, for the tooltip)

class Semaphore {
  constructor(max) { this.max = max; this.current = 0; this.queue = []; }
  setMax(max) { this.max = Math.max(1, max); this._drain(); }
  acquire() { return new Promise((resolve) => { this.queue.push(resolve); this._drain(); }); }
  release() { this.current -= 1; this._drain(); }
  _drain() { while (this.current < this.max && this.queue.length) { this.current += 1; this.queue.shift()(); } }
}

// Shared by every host-upload task across every episode (true cross-episode, cross-host parallelism).
const semaphore = new Semaphore(configStore.get('concurrency', 3));
// Only one episode at a time is pushed to OUR server (it is bandwidth bound; the server then fans out to the hosts).
const relaySemaphore = new Semaphore(1);

function setConcurrency(n) {
  configStore.set('concurrency', n);
  semaphore.setMax(n);
}

// --- auth (set once by main.js): fresh token + refresh-on-demand, because a multi-hour upload outlives the 1 h token
let auth = { getToken: () => '', refresh: async () => null };
function setAuthProvider(p) { auth = { ...auth, ...p }; }
async function withAuth(fn) {
  let r = await fn(auth.getToken());
  if (!r || !r.success) {
    const fresh = await auth.refresh().catch(() => null);
    if (fresh) r = await fn(fresh);
  }
  return r;
}

let changeListener = null;
function setChangeListener(fn) { changeListener = fn; }
let pending = null;
function notifyChange() {
  if (!changeListener || pending) return;
  pending = setTimeout(() => { pending = null; try { changeListener(); } catch { /* ignore */ } }, 250);
}

const controllers = new Map(); // `${jobId}:${host}` or `${jobId}:relay` -> AbortController

async function resolveSlot(accessToken, episodeId, host) {
  const { jobs } = await site.listHostJobs(accessToken, episodeId).catch(() => ({ jobs: [] }));
  const list = jobs || [];
  const existing = list.find((j) => j.host === host);
  if (existing) return { slot: existing.slot, existingUrl: !!existing.embed_url, status: existing.status };
  const used = new Set(list.map((j) => j.slot));
  for (let s = 1; s <= 4; s += 1) if (!used.has(s)) return { slot: s, existingUrl: false, status: null };
  return { slot: 1, existingUrl: false, status: null };
}

function hostPatcher(jobId, onUpdate) {
  return (patch) => {
    if (onUpdate) onUpdate(patch);
    else {
      const current = getJob(jobId);
      if (current) upsertJob({ id: jobId, hosts: current.hosts.map((h) => (h.host === patch.host ? { ...h, ...patch } : h)) });
    }
    notifyChange();
  };
}

const CLEAR_ERR = { error: null, errClass: null, detail: null };

// Processing stage for one host (no semaphore: the bytes are already on the host).
async function trackProcessing({ host, apiKey, fileCode, signal, setHostState }) {
  if (!apiKey || !fileCode) { setHostState({ status: 'done', stage: 'done', processing: { state: 'unknown', pct: null, indeterminate: true } }); return; }
  const r = await pollProcessing(host, {
    apiKey, fileCode, signal,
    onUpdate: (s) => setHostState({ status: s.state === 'done' ? 'done' : 'processing', stage: s.state === 'done' ? 'done' : 'processing', processing: s }),
  });
  if (r.cancelled) return;
  if (r.encodingError) { setHostState({ status: 'error', stage: 'error', error: `فشلت المعالجة لدى الاستضافة: ${r.error}`, errClass: 'rejected', detail: r.error, processing: { state: 'error', pct: null } }); return; }
  if (r.timedOut || r.error) setHostState({ status: 'done', stage: 'done', processing: { state: 'unknown', pct: null, indeterminate: true, note: r.error || 'لم تؤكد الاستضافة الجاهزية' } });
}

// One (episode, host) upload, straight from this machine to the host.
async function runHostUpload({ jobId, episodeId, animeId, host, filePath, slot, onUpdate }) {
  const setHostState = hostPatcher(jobId, onUpdate);
  const key = `${jobId}:${host}`;
  const ac = new AbortController();
  controllers.set(key, ac);
  setHostState({ host, status: 'waiting', stage: 'waiting', progress: 0, loaded: 0, bytesPerSec: 0, note: null, stalled: false, processing: null, ...CLEAR_ERR });
  await semaphore.acquire();
  let result = null; let apiKey = null; let fileCode = null;
  try {
    if (ac.signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
    setHostState({ host, status: 'uploading', stage: 'sending', progress: 0, attempt: 1, maxAttempts: 6 });
    let lastReported = 0;
    const getConfig = async () => {
      const c = await withAuth((t) => site.getDirectUploadConfig(t, host));
      return c;
    };
    result = await uploadFile(host, filePath, getConfig, (ev) => {
      if (ev.stage === 'retry') {
        setHostState({ host, status: 'uploading', stage: 'sending', note: ev.note, errClass: ev.errClass, detail: ev.detail, attempt: ev.attempt + 1, maxAttempts: ev.maxAttempts, bytesPerSec: 0, stalled: false, progress: 0, loaded: 0 });
        return;
      }
      setHostState({ host, status: 'uploading', stage: 'sending', progress: ev.pct, loaded: ev.loaded, total: ev.total, bytesPerSec: ev.bytesPerSec, stalled: ev.stalled, attempt: ev.attempt, maxAttempts: ev.maxAttempts, note: null, errClass: null, detail: null, error: null });
      if (ev.pct - lastReported >= 5 && ev.pct < 100) {
        lastReported = ev.pct;
        withAuth((t) => site.directProgress(t, { episodeId, animeId, slot, host, progress: ev.pct }).then(() => ({ success: true }))).catch(() => {});
      }
    }, { signal: ac.signal });
    apiKey = result.apiKey; fileCode = result.fileCode;
    // The link is stored on the site right away; encoding on the host continues in the background and is tracked below.
    const fin = await withAuth((t) => site.directFinalize(t, { episodeId, animeId, slot, host, fileCode }));
    if (!fin.success) throw Object.assign(new Error(fin.error || 'فشل حفظ الرابط في الموقع'), { errClass: 'unknown', detail: fin.error });
    setHostState({ host, status: 'processing', stage: 'processing', progress: 100, loaded: undefined, bytesPerSec: 0, stalled: false, note: null, fileCode, embedUrl: fin.embedUrl || result.embedUrl, processing: { state: 'waiting', pct: null }, ...CLEAR_ERR });
  } catch (err) {
    if (err && err.cancelled) setHostState({ host, status: 'error', stage: 'error', error: 'أُلغيت العملية', errClass: 'cancelled', detail: null, bytesPerSec: 0, stalled: false });
    else {
      const c = classifyError(err);
      setHostState({ host, status: 'error', stage: 'error', error: c.ar, errClass: c.cls, detail: (err && err.detail) || c.detail, note: null, bytesPerSec: 0, stalled: false });
    }
    controllers.delete(key);
    semaphore.release();
    return;
  }
  semaphore.release();
  try {
    await trackProcessing({ host, apiKey, fileCode, signal: ac.signal, setHostState: (p) => setHostState({ host, ...p }) });
  } finally {
    controllers.delete(key);
  }
}

// ---------------------------------------------------------------------------
// "Upload through our server": one chunked copy to the Despair relay, the server fans out to the hosts.
// ---------------------------------------------------------------------------
function makeRelayClient() {
  return new RelayClient({ baseUrl: site.SITE_URL, getToken: () => auth.getToken(), refreshToken: () => auth.refresh() });
}

async function runRelayJob({ jobId, filePath, hosts, animeId, episodeId, slots, title, resumeRelayId }) {
  const key = `${jobId}:relay`;
  const ac = new AbortController();
  controllers.set(key, ac);
  const setJob = (p) => { upsertJob({ id: jobId, ...p }); notifyChange(); };
  const patchHost = (host, patch) => {
    const cur = getJob(jobId);
    if (cur) upsertJob({ id: jobId, hosts: cur.hosts.map((h) => (h.host === host ? { ...h, ...patch } : h)) });
    notifyChange();
  };
  const patchAll = (patch) => hosts.forEach((h) => patchHost(h, patch));
  const client = makeRelayClient();
  const size = fs.statSync(filePath).size;
  try {
    patchAll({ status: 'waiting', stage: 'relay-queue', progress: 0, loaded: 0, total: size, ...CLEAR_ERR, processing: null });
    await relaySemaphore.acquire();
    let relayId = resumeRelayId || null;
    try {
      // The server accepts few active relays per user: when it says "busy", wait for our turn instead of failing.
      for (let waited = 0; ; waited += 1) {
        try {
          setJob({ relay: { stage: 'sending', pct: 0, loaded: 0, total: size, bytesPerSec: 0, note: waited ? 'ننتظر دورنا على السيرفر...' : null } });
          const r = await client.upload({
            filePath, hosts, title, relayId,
            signal: ac.signal,
            onRelayId: (id) => { relayId = id; setJob({ relayId: id }); },
            onProgress: (e) => {
              setJob({ relay: { stage: 'sending', pct: e.pct, loaded: e.loaded, total: e.total, bytesPerSec: e.bytesPerSec || 0, chunk: e.chunk, chunks: e.chunks, resumed: !!e.resumed, note: e.stage === 'relay-retry' ? e.note : null, detail: e.detail || null } });
              patchAll({ status: 'uploading', stage: 'relay-queue', progress: 0 });
            },
          });
          relayId = r.relayId;
          break;
        } catch (err) {
          if ((err.serverCode === 'too_many_active_relays' || err.serverCode === 'server_busy') && waited < 360) { await sleep(20000); continue; }
          if (err.serverCode === 'relay_not_found' && relayId) { relayId = null; continue; }
          throw err;
        }
      }
    } finally {
      relaySemaphore.release();
    }
    setJob({ relay: { stage: 'server', pct: 100, loaded: size, total: size, bytesPerSec: 0 }, relayId });
    await followRelay({ jobId, client, relayId, hosts, animeId, episodeId, slots, size, signal: ac.signal, patchHost, setJob });
  } catch (err) {
    if (err && err.cancelled) { setJob({ relay: { stage: 'cancelled' } }); patchAll({ status: 'error', stage: 'error', error: 'أُلغيت العملية', errClass: 'cancelled' }); }
    else {
      const c = classifyError(err);
      const ar = err && err.serverCode ? err.message : c.ar;
      setJob({ relay: { stage: 'error', error: ar } });
      patchAll({ status: 'error', stage: 'error', error: ar, errClass: err.errClass || c.cls, detail: err.detail || c.detail });
    }
  } finally {
    controllers.delete(key);
  }
}

// Polls the relay's status (every 2 s, gently) and mirrors it into the job; saves each link on the site once.
async function followRelay({ jobId, client, relayId, hosts, animeId, episodeId, slots, size, signal, patchHost, setJob }) {
  const finalized = new Set();
  let misses = 0;
  for (;;) {
    if (signal.aborted) throw Object.assign(new Error('cancelled'), { cancelled: true });
    let st;
    try { st = await client.status(relayId); misses = 0; } catch (err) {
      if (err.serverCode === 'relay_not_found') throw Object.assign(new Error('انتهت صلاحية الملف على السيرفر'), { errClass: 'quota', serverCode: 'relay_not_found' });
      misses += 1;
      if (misses > 30) throw err;
      await sleep(3000); continue;
    }
    setJob({ relay: { stage: st.state === 'assembling' ? 'assembling' : 'server', pct: 100, loaded: size, total: size, bytesPerSec: 0 } });
    for (const host of hosts) {
      const h = st.hosts && st.hosts[host];
      if (!h) continue;
      const js = relayHostToJobState(h, size);
      if ((h.state === 'processing' || h.state === 'done') && h.fileCode && !finalized.has(host)) {
        const fin = await withAuth((t) => site.directFinalize(t, { episodeId, animeId, slot: slots[host], host, fileCode: h.fileCode }));
        if (!fin.success) { patchHost(host, { status: 'error', stage: 'error', error: 'فشل حفظ الرابط في الموقع', errClass: 'unknown', detail: fin.error }); finalized.add(host); continue; }
        finalized.add(host);
        js.embedUrl = fin.embedUrl || h.embedUrl;
      } else if (h.embedUrl) js.embedUrl = h.embedUrl;
      if (js.status === 'error') { const c = classifyError({ errClass: h.errClass, detail: h.detail }); js.error = c.ar; js.errClass = h.errClass; js.detail = h.detail; }
      patchHost(host, js);
    }
    const terminal = hosts.every((host) => { const h = st.hosts[host]; return h && (h.state === 'done' || h.state === 'error'); });
    if (terminal) {
      setJob({ relay: { stage: 'finished', pct: 100, loaded: size, total: size, bytesPerSec: 0 } });
      return;
    }
    await sleep(2000);
  }
}

// Queues one episode's upload across all selected hosts in parallel.
function queueEpisodeUpload({ animeId, animeTitle, episodeId, episodeNumber, filePath, hosts, accessToken, viaServer = false, extra = {} }) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id: jobId, animeId, animeTitle, episodeId, episodeNumber,
    fileName: path.basename(filePath), filePath, createdAt: new Date().toISOString(),
    fileSize: (() => { try { return fs.statSync(filePath).size; } catch { return 0; } })(),
    viaServer: !!viaServer,
    hosts: hosts.map((h) => ({ host: h, status: 'pending', stage: 'waiting', progress: 0, error: null, embedUrl: null })),
    ...extra,
  };
  upsertJob(job);
  notifyChange();

  (async () => {
    try {
      const slots = {};
      for (const host of hosts) slots[host] = (await resolveSlot(accessToken, episodeId, host)).slot;
      if (viaServer) {
        await runRelayJob({ jobId, filePath, hosts, animeId, episodeId, slots, title: `${animeTitle || animeId} - ${episodeNumber}` });
      } else {
        await Promise.all(hosts.map((host) => runHostUpload({ jobId, episodeId, animeId, host, filePath, slot: slots[host] }).catch((err) => {
          hostPatcher(jobId)({ host, status: 'error', stage: 'error', error: (err && err.message) || String(err) });
        })));
      }
    } catch (err) {
      const c = classifyError(err);
      hosts.forEach((host) => hostPatcher(jobId)({ host, status: 'error', stage: 'error', error: c.ar, errClass: c.cls, detail: c.detail }));
    }
  })();

  return job;
}

function retryHostUpload({ jobId, episodeId, animeId, host, filePath, accessToken, onUpdate }) {
  return (async () => {
    const job = getJob(jobId);
    const { slot } = await resolveSlot(accessToken, episodeId, host);
    if (job && job.viaServer && job.relayId) {
      const client = makeRelayClient();
      try {
        await client.retryHost(job.relayId, host);
      } catch (err) {
        if (err.serverCode !== 'relay_not_found') {
          const c = classifyError(err);
          hostPatcher(jobId, onUpdate)({ host, status: 'error', stage: 'error', error: err.serverCode ? err.message : c.ar, errClass: c.cls });
          return;
        }
        // the server copy is gone: send everything again (all hosts that are not done)
        const todo = job.hosts.filter((h) => h.status === 'error').map((h) => h.host);
        const slots = {}; for (const hh of todo) slots[hh] = (await resolveSlot(accessToken, episodeId, hh)).slot;
        await runRelayJob({ jobId, filePath, hosts: todo, animeId, episodeId, slots, title: `${job.animeTitle || animeId} - ${job.episodeNumber}` });
        return;
      }
      const ac = new AbortController(); controllers.set(`${jobId}:relay`, ac);
      const slots = { [host]: slot };
      try {
        await followRelay({
          jobId, client, relayId: job.relayId, hosts: [host], animeId, episodeId, slots, size: job.fileSize || 0, signal: ac.signal,
          patchHost: (h, p) => hostPatcher(jobId, onUpdate)({ host: h, ...p }), setJob: (p) => { upsertJob({ id: jobId, ...p }); notifyChange(); },
        });
      } finally { controllers.delete(`${jobId}:relay`); }
      return;
    }
    await runHostUpload({ jobId, episodeId, animeId, host, filePath, slot, onUpdate });
  })();
}

// Cancel everything of a job (all hosts, the relay leg, in-flight streams).
function cancelJob(jobId) {
  let n = 0;
  for (const [k, ac] of controllers) if (k.startsWith(`${jobId}:`)) { ac.abort(); n += 1; }
  const job = getJob(jobId);
  if (job && job.viaServer && job.relayId) makeRelayClient().remove(job.relayId).catch(() => {});
  return n;
}

// After an app restart: pick up whatever was in flight (the file is still on disk).
async function resumeJob(job, accessToken) {
  if (!job.filePath || !fs.existsSync(job.filePath)) return false;
  const stuck = job.hosts.filter((h) => ['uploading', 'waiting', 'pending', 'processing'].includes(h.status));
  if (!stuck.length) return false;
  if (job.viaServer) {
    const hosts = stuck.map((h) => h.host);
    const slots = {}; for (const h of hosts) slots[h] = (await resolveSlot(accessToken, job.episodeId, h)).slot;
    runRelayJob({ jobId: job.id, filePath: job.filePath, hosts, animeId: job.animeId, episodeId: job.episodeId, slots, title: `${job.animeTitle || job.animeId} - ${job.episodeNumber}`, resumeRelayId: job.relayId });
    return true;
  }
  for (const h of stuck) {
    if (h.status === 'processing' && h.fileCode) {
      // only the encoding poll was interrupted: ask for a key once, then keep tracking (no re-upload)
      (async () => {
        const conf = await withAuth((t) => site.getDirectUploadConfig(t, h.host));
        const setHostState = hostPatcher(job.id);
        await trackProcessing({ host: h.host, apiKey: conf.success ? conf.apiKey : null, fileCode: h.fileCode, signal: new AbortController().signal, setHostState: (p) => setHostState({ host: h.host, ...p }) });
      })();
      continue;
    }
    retryHostUpload({ jobId: job.id, episodeId: job.episodeId, animeId: job.animeId, host: h.host, filePath: job.filePath, accessToken }).catch(() => {});
  }
  return true;
}

module.exports = { queueEpisodeUpload, retryHostUpload, resolveSlot, setConcurrency, cancelJob, resumeJob, setAuthProvider, setChangeListener };
