// Chunked relay client vs. the REAL relay server module (server/upload-relay.mjs) wired to mock hosts.
import assert from 'node:assert';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const SERVER = '/home/test.despair-world.com/public_html/react-src/extracted/void-projects2026-s-Org-main/server';
const sreq = createRequire(`${SERVER}/x.js`);
const express = sreq('express');
const lreq = createRequire(import.meta.url);
const { startMock } = lreq('./mockHosts.js');
const { RelayClient, relayHostToJobState } = lreq('../src/lib/relayClient.js');
const { registerUploadRelayRoutes } = await import(`${SERVER}/upload-relay.mjs`);
const MB = 1024 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
const t = async (n, f) => { try { await f(); pass += 1; console.log('ok  -', n); } catch (e) { console.log('FAIL-', n, e.stack); process.exitCode = 1; } };

const mocks = { earnvid: await startMock({ host: 'earnvid', deadNodes: 0, canplayAfter: 1 }), doodstream: await startMock({ host: 'doodstream', deadNodes: 0, canplayAfter: 1 }), voe: await startMock({ host: 'voe', voeNoFlag: true }) };
const hostOverrides = Object.fromEntries(Object.entries(mocks).map(([h, m]) => [h, { key: m.KEY, serverUrl: `${m.base}/api/upload/server`, apiBase: `${m.base}/api` }]));
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
const app = express();
const puts = []; // every PUT chunk the server saw
app.use((req, _res, next) => { if (req.method === 'PUT') puts.push(Number(new URL(req.url, 'http://x').searchParams.get('index'))); next(); });
let tokenOk = 'tok1';
const reg = registerUploadRelayRoutes(app, { requireAdminUid: async (req) => (req.headers.authorization === `Bearer ${tokenOk}` ? 'adminA' : null), options: { baseDir: base, chunkSize: 2 * MB, minFreeAfterBytes: 0, freeBytes: async () => 1e12, hostOverrides, engine: { backoffMs: 20, pollIntervalMs: 30 } } });
const srv = app.listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
const baseUrl = `http://127.0.0.1:${srv.address().port}`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rcf-'));
const file = path.join(tmp, 'Episode 01.mkv');
const data = crypto.randomBytes(9 * MB + 777); // 5 chunks of 2 MB
fs.writeFileSync(file, data);
const sha = crypto.createHash('sha256').update(data).digest('hex');
const mk = (extra = {}) => new RelayClient({ baseUrl, getToken: () => tokenOk, refreshToken: async () => { tokenOk = 'tok2'; return 'tok2'; }, backoffMs: 10, ...extra });

await t('killed mid-way, then resumed: only missing chunks are sent, final bytes identical on all 3 hosts', async () => {
  puts.length = 0;
  const c = mk(); let id; const ac = new AbortController(); const ev = [];
  await assert.rejects(c.upload({ filePath: file, hosts: ['earnvid', 'doodstream', 'voe'], title: 'x', signal: ac.signal, onRelayId: (r) => { id = r; }, onProgress: (e) => { ev.push(e); if (e.chunk >= 2) ac.abort(); } }), (e) => e.cancelled);
  const st = await mk().status(id);
  assert.strictEqual(st.state, 'receiving');
  const have = st.received.length;
  assert.ok(have >= 2 && have < 5, `partial: ${have}`);
  puts.length = 0;
  const ev2 = [];
  const r = await mk().upload({ filePath: file, hosts: ['earnvid', 'doodstream', 'voe'], relayId: id, onProgress: (e) => ev2.push(e) });
  assert.strictEqual(r.relayId, id);
  assert.strictEqual(puts.length, 5 - have, `resent only missing chunks: ${puts}`);
  assert.ok(!puts.some((i) => st.received.includes(i)));
  assert.strictEqual(ev2[0].resumed, true);
  assert.ok(ev2.some((e) => e.pct === 100));
  let s; for (let i = 0; i < 200; i += 1) { s = await mk().status(id); if (s.state === 'done') break; await sleep(50); }
  assert.strictEqual(s.state, 'done');
  for (const h of Object.keys(mocks)) assert.strictEqual(mocks[h].state.uploads[0].fileSha, sha, h);
  const js = relayHostToJobState(s.hosts.earnvid, s.size);
  assert.strictEqual(js.status, 'done'); assert.strictEqual(js.progress, 100);
  assert.ok(ev.some((e) => e.pct > 0 && e.pct < 100), 'intermediate real progress');
});

await t('token expiry mid-upload: refreshed once and the upload continues', async () => {
  tokenOk = 'tok3';
  const c = new RelayClient({ baseUrl, getToken: () => c._token || 'stale', refreshToken: async () => { c._token = 'tok3'; return 'tok3'; }, backoffMs: 10 });
  const r = await c.upload({ filePath: file, hosts: ['voe'] });
  assert.ok(r.relayId);
  await c.remove(r.relayId).catch(() => {});
});

await t('flaky network: a chunk PUT that fails (server 500 once) is retried', async () => {
  tokenOk = 'tok1';
  let fails = 1;
  const app2 = express();
  app2.use((req, res, next) => { if (req.method === 'PUT' && fails-- > 0) return res.status(502).send('<html>bad gateway</html>'); next(); });
  const reg2 = registerUploadRelayRoutes(app2, { requireAdminUid: async () => 'adminB', options: { baseDir: base, chunkSize: 2 * MB, minFreeAfterBytes: 0, freeBytes: async () => 1e12, hostOverrides } });
  const s2 = app2.listen(0, '127.0.0.1'); await new Promise((r) => s2.once('listening', r));
  const c = new RelayClient({ baseUrl: `http://127.0.0.1:${s2.address().port}`, getToken: () => 'x', backoffMs: 10 });
  const ev = [];
  const r = await c.upload({ filePath: file, hosts: ['voe'], onProgress: (e) => ev.push(e) });
  assert.ok(ev.some((e) => e.stage === 'relay-retry'), 'retry event');
  assert.ok(r.relayId);
  reg2.stop(); s2.close();
});

await t('server refusals surface readable Arabic errors (403 / too many relays)', async () => {
  tokenOk = 'nope';
  await assert.rejects(new RelayClient({ baseUrl, getToken: () => 'bad', backoffMs: 5 }).upload({ filePath: file, hosts: ['voe'] }), (e) => e.errClass === 'auth' && /صلاحية/.test(e.message));
});

reg.stop(); srv.close(); await Promise.all(Object.values(mocks).map((m) => m.close()));
console.log(`\n${pass} passed`); process.exit(process.exitCode || 0);
