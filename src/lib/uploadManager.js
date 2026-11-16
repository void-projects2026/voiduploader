'use strict';

const path = require('path');
const { uploadFile } = require('./hosts');
const site = require('./site');
const { configStore, upsertJob } = require('./stores');

// A small global semaphore shared by every host-upload task across every
// episode in the queue, so "رفع متوازي" means true cross-episode,
// cross-host parallelism bounded by one concurrency setting, not just
// parallelism within a single episode's 3 hosts.
class Semaphore {
  constructor(max) {
    this.max = max;
    this.current = 0;
    this.queue = [];
  }
  setMax(max) {
    this.max = Math.max(1, max);
    this._drain();
  }
  acquire() {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this._drain();
    });
  }
  release() {
    this.current -= 1;
    this._drain();
  }
  _drain() {
    while (this.current < this.max && this.queue.length) {
      this.current += 1;
      const resolve = this.queue.shift();
      resolve();
    }
  }
}

const semaphore = new Semaphore(configStore.get('concurrency', 3));

function setConcurrency(n) {
  configStore.set('concurrency', n);
  semaphore.setMax(n);
}

async function resolveSlot(accessToken, episodeId, host) {
  const { jobs } = await site.listHostJobs(accessToken, episodeId).catch(() => ({ jobs: [] }));
  const list = jobs || [];
  const existing = list.find((j) => j.host === host);
  if (existing) return { slot: existing.slot, existingUrl: !!existing.embed_url, status: existing.status };
  const used = new Set(list.map((j) => j.slot));
  for (let s = 1; s <= 4; s += 1) {
    if (!used.has(s)) return { slot: s, existingUrl: false, status: null };
  }
  return { slot: 1, existingUrl: false, status: null };
}

// Runs one (episode, host) upload: acquires the semaphore, uploads the
// file bytes directly to the host, then reports progress + finalizes into
// the site's own DB via the exact same direct-finalize endpoint the
// website's browser-based admin panel uses. Updates the persisted
// operations row as it goes so the UI (and app restarts) see live state.
async function runHostUpload({ jobId, episodeId, animeId, host, filePath, accessToken, slot, onUpdate }) {
  const setHostState = (patch) => {
    onUpdate({ host, ...patch });
  };

  setHostState({ status: 'waiting', progress: 0 });
  await semaphore.acquire();
  try {
    setHostState({ status: 'uploading', progress: 1, error: null });
    const uploadConfig = await site.getDirectUploadConfig(accessToken, host);
    if (!uploadConfig.success) throw new Error(uploadConfig.error);
    let lastReported = 0;
    const result = await uploadFile(host, filePath, uploadConfig, ({ pct }) => {
      setHostState({ status: 'uploading', progress: pct });
      if (pct - lastReported >= 5) {
        lastReported = pct;
        site.directProgress(accessToken, { episodeId, animeId, slot, host, progress: pct }).catch(() => {});
      }
    });
    const fin = await site.directFinalize(accessToken, { episodeId, animeId, slot, host, fileCode: result.fileCode });
    if (!fin.success) throw new Error(fin.error || 'فشل حفظ الرابط في الموقع');
    setHostState({ status: 'done', progress: 100, embedUrl: fin.embedUrl || result.embedUrl, error: null });
  } catch (err) {
    setHostState({ status: 'error', error: (err && err.message) || String(err) });
  } finally {
    semaphore.release();
  }
}

// Queues one episode's upload across all selected hosts in parallel.
// `filePath`/`episodeNumber` describe the local file; `episodeId`/`animeId`
// must already exist on the site (caller creates the episode row first via
// site.createEpisode if it doesn't exist yet).
function queueEpisodeUpload({ animeId, animeTitle, episodeId, episodeNumber, filePath, hosts, accessToken, extra = {} }) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const job = {
    id: jobId,
    animeId,
    animeTitle,
    episodeId,
    episodeNumber,
    fileName: path.basename(filePath),
    filePath,
    createdAt: new Date().toISOString(),
    hosts: hosts.map((h) => ({ host: h, status: 'pending', progress: 0, error: null, embedUrl: null })),
    ...extra,
  };
  upsertJob(job);

  const update = (patch) => {
    const current = upsertJob({ id: jobId, hosts: job.hosts });
    const hostsArr = current.hosts.map((h) => (h.host === patch.host ? { ...h, ...patch } : h));
    upsertJob({ id: jobId, hosts: hostsArr });
    job.hosts = hostsArr;
  };

  hosts.forEach(async (host) => {
    try {
      const { slot } = await resolveSlot(accessToken, episodeId, host);
      await runHostUpload({ jobId, episodeId, animeId, host, filePath, accessToken, slot, onUpdate: update });
    } catch (err) {
      update({ host, status: 'error', error: (err && err.message) || String(err) });
    }
  });

  return job;
}

function retryHostUpload({ jobId, episodeId, animeId, host, filePath, accessToken, onUpdate }) {
  return (async () => {
    const { slot } = await resolveSlot(accessToken, episodeId, host);
    await runHostUpload({ jobId, episodeId, animeId, host, filePath, accessToken, slot, onUpdate });
  })();
}

module.exports = { queueEpisodeUpload, retryHostUpload, resolveSlot, setConcurrency };
