'use strict';

const Store = require('electron-store');

// Session (login tokens + profile) - local machine only, same tradeoff the
// previous prototype already made for host API keys (electron-store isn't
// OS-keychain-encrypted, but this is a single-admin desktop tool, not a
// multi-tenant app).
const sessionStore = new Store({ name: 'session', defaults: { accessToken: '', refreshToken: '', userId: '', profile: null } });

// Host API keys, entered once in Settings.
const configStore = new Store({
  name: 'config',
  defaults: { earnvidApiKey: '', doodstreamApiKey: '', voeApiKey: '', concurrency: 3 },
});

// Operations table: one row per (episode, host) upload attempt, persisted
// so it survives app restarts and keeps updating while minimized to tray.
const opsStore = new Store({ name: 'operations', defaults: { jobs: [] } });

function listJobs() {
  return opsStore.get('jobs', []);
}

function upsertJob(job) {
  const jobs = opsStore.get('jobs', []);
  const idx = jobs.findIndex((j) => j.id === job.id);
  if (idx >= 0) jobs[idx] = { ...jobs[idx], ...job };
  else jobs.unshift(job);
  opsStore.set('jobs', jobs);
  return jobs.find((j) => j.id === job.id);
}

function getJob(id) {
  return opsStore.get('jobs', []).find((j) => j.id === id) || null;
}

function clearFinishedJobs() {
  const jobs = opsStore.get('jobs', []).filter((j) => j.hosts.some((h) => h.status === 'uploading' || h.status === 'pending'));
  opsStore.set('jobs', jobs);
  return jobs;
}

module.exports = { sessionStore, configStore, opsStore, listJobs, upsertJob, getJob, clearFinishedJobs };
