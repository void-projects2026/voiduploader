// Orchestration test: uploadManager (direct mode + "through our server" mode) with fake stores/site, mock hosts, and the real relay module.
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const SERVER = '/home/test.despair-world.com/public_html/react-src/extracted/void-projects2026-s-Org-main/server';
const sreq = createRequire(`${SERVER}/x.js`);
const express = sreq('express');
const req = createRequire(import.meta.url);
const { startMock } = req('./mockHosts.js');
const { registerUploadRelayRoutes } = await import(`${SERVER}/upload-relay.mjs`);
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mocks = { earnvid: await startMock({ host: 'earnvid', deadNodes: 1, canplayAfter: 4, responseDelay: 200 }), doodstream: await startMock({ host: 'doodstream', canplayAfter: 3 }), voe: await startMock({ host: 'voe', voeNoFlag: true }) };
const hostOverrides = Object.fromEntries(Object.entries(mocks).map(([h, m]) => [h, { key: m.KEY, serverUrl: `${m.base}/api/upload/server`, apiBase: `${m.base}/api` }]));
const app = express();
const reg = registerUploadRelayRoutes(app, { requireAdminUid: async (r) => (r.headers.authorization === 'Bearer T' ? 'adminA' : null), options: { baseDir: fs.mkdtempSync(path.join(os.tmpdir(), 'um-')), chunkSize: 2 * MB, minFreeAfterBytes: 0, freeBytes: async () => 1e12, hostOverrides, engine: { backoffMs: 20, pollIntervalMs: 40 } } });
const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));

// fakes
const jobs = [];
const finalized = [];
const fakeStores = {
  configStore: { get: (_k, d) => d, set() {} },
  upsertJob: (j) => { const i = jobs.findIndex((x) => x.id === j.id); if (i >= 0) jobs[i] = { ...jobs[i], ...j }; else jobs.unshift(j); return jobs.find((x) => x.id === j.id); },
  getJob: (id) => jobs.find((j) => j.id === id) || null,
};
const fakeSite = {
  SITE_URL: `http://127.0.0.1:${srv.address().port}`,
  listHostJobs: async () => ({ success: true, jobs: [] }),
  getDirectUploadConfig: async (_t, host) => {
    const m = mocks[host]; const r = await (await fetch(`${m.base}/api/upload/server?key=${m.KEY}`)).json();
    return { success: true, uploadUrl: r.result, fieldName: host === 'doodstream' ? 'api_key' : 'key', apiKey: m.KEY };
  },
  directProgress: async () => ({}),
  directFinalize: async (_t, p) => { finalized.push(p); return { success: true, embedUrl: `https://embed/${p.host}/${p.fileCode}` }; },
};
const put = (m, o) => { const p = req.resolve(m); req.cache[p] = { id: p, filename: p, loaded: true, exports: o, children: [], paths: [] }; };
put('../src/lib/stores.js', fakeStores); put('../src/lib/site.js', fakeSite);
const { BASES, POLL } = req('../src/lib/hostStatus.js'); POLL.earnvid = 40; POLL.other = 40;
for (const h of Object.keys(mocks)) BASES[h] = `${mocks[h].base}/api`;
const um = req('../src/lib/uploadManager.js');
um.setAuthProvider({ getToken: () => 'T', refresh: async () => null });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'umf-'));
const file = path.join(tmp, 'ep.mkv'); const data = crypto.randomBytes(5 * MB + 99); fs.writeFileSync(file, data);
const sha = crypto.createHash('sha256').update(data).digest('hex');
let pass = 0;
const t = async (n, f) => { try { await f(); pass += 1; console.log('ok  -', n); } catch (e) { console.log('FAIL-', n, e.stack); process.exitCode = 1; } };
const waitJob = async (id, pred, ms = 20000) => { const t0 = Date.now(); for (;;) { const j = fakeStores.getJob(id); if (pred(j)) return j; if (Date.now() - t0 > ms) throw new Error('timeout ' + JSON.stringify(j.hosts.map((h) => [h.host, h.status, h.stage, h.processing]))); await sleep(30); } };

await t('direct mode: dead node retried, real progress, processing stage (earnvid %, dood none), links saved', async () => {
  const seen = { earnvid: [], doodstream: [], voe: [] };
  const timer = setInterval(() => { const j = jobs[0]; if (j) j.hosts.forEach((h) => seen[h.host].push({ status: h.status, stage: h.stage, progress: h.progress, note: h.note, processing: h.processing && { ...h.processing } })); }, 15);
  const job = um.queueEpisodeUpload({ animeId: 'a1', animeTitle: 'T', episodeId: 'e1', episodeNumber: 1, filePath: file, hosts: ['earnvid', 'doodstream', 'voe'], accessToken: 'T' });
  const done = await waitJob(job.id, (j) => j.hosts.every((h) => h.status === 'done'));
  clearInterval(timer);
  assert.deepStrictEqual(done.hosts.map((h) => h.fileCode).sort(), ['dood123', 'earn123', 'voe123']);
  assert.strictEqual(finalized.length, 3);
  assert.ok(seen.earnvid.some((s) => /سيرفرًا آخر \(1\/5\)/.test(s.note || '')), 'retry note visible to UI');
  const evProc = seen.earnvid.filter((s) => s.status === 'processing' && s.processing && s.processing.state === 'encoding');
  assert.ok(evProc.length && evProc.every((s) => typeof s.processing.pct === 'number' && s.processing.pct < 100), 'earnvid real encoding %');
  assert.ok(seen.doodstream.filter((s) => s.status === 'processing').every((s) => s.processing.pct === null), 'dood: no fake %');
  const sendingPcts = seen.earnvid.filter((s) => s.stage === 'sending').map((s) => s.progress);
  assert.ok(sendingPcts.every((p) => p <= 100));
  assert.strictEqual(done.hosts.find((h) => h.host === 'voe').processing.indeterminate, true);
  assert.ok(done.hosts.every((h) => h.embedUrl && h.embedUrl.startsWith('https://embed/')));
});

await t('through-our-server mode: one copy uploaded, server fans out, job reaches done on all hosts', async () => {
  finalized.length = 0; Object.values(mocks).forEach((m) => { m.state.uploads.length = 0; m.state.serverCalls = 0; m.state.infoCalls = 0; m.state.encCalls = 0; });
  const job = um.queueEpisodeUpload({ animeId: 'a1', animeTitle: 'T', episodeId: 'e2', episodeNumber: 2, filePath: file, hosts: ['earnvid', 'doodstream', 'voe'], accessToken: 'T', viaServer: true });
  assert.strictEqual(job.viaServer, true);
  const sawRelay = new Set();
  const timer = setInterval(() => { const j = fakeStores.getJob(job.id); if (j && j.relay) sawRelay.add(j.relay.stage); }, 10);
  const done = await waitJob(job.id, (j) => j.hosts.every((h) => h.status === 'done') && j.relay && j.relay.stage === 'finished');
  clearInterval(timer);
  assert.ok(sawRelay.has('sending'), 'saw relay sending leg');
  for (const h of Object.keys(mocks)) assert.strictEqual(mocks[h].state.uploads[0].fileSha, sha, h);
  assert.strictEqual(finalized.length, 3);
  assert.ok(done.relayId);
  assert.ok(done.hosts.every((h) => h.fileCode));
});

await t('cancel aborts the in-flight transfer and marks hosts cancelled', async () => {
  const big = path.join(tmp, 'big.mkv'); fs.writeFileSync(big, Buffer.alloc(80 * MB, 3));
  const m = await startMock({ host: 'voe', stallFirst: 5, deadNodes: 0 });
  const old = fakeSite.getDirectUploadConfig;
  fakeSite.getDirectUploadConfig = async () => { const r = await (await fetch(`${m.base}/api/upload/server?key=${m.KEY}`)).json(); return { success: true, uploadUrl: r.result, fieldName: 'key', apiKey: m.KEY }; };
  const job = um.queueEpisodeUpload({ animeId: 'a1', animeTitle: 'T', episodeId: 'e3', episodeNumber: 3, filePath: big, hosts: ['voe'], accessToken: 'T' });
  await waitJob(job.id, (j) => j.hosts[0].status === 'uploading' && j.hosts[0].stage === 'sending');
  await sleep(300);
  assert.strictEqual(um.cancelJob(job.id), 1);
  const j = await waitJob(job.id, (x) => x.hosts[0].status === 'error');
  assert.strictEqual(j.hosts[0].errClass, 'cancelled');
  fakeSite.getDirectUploadConfig = old; await m.close();
});

reg.stop(); console.log(`\n${pass} passed`); process.exit(process.exitCode || 0);
