'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startMock } = require('./mockHosts');
const { uploadFile, DEFAULTS } = require('../src/lib/hosts');
const { pollProcessing, parseEarnvid, parseDood, parseVoe } = require('../src/lib/hostStatus');
const { classifyError, redact } = require('../src/lib/netErrors');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vu-'));
const file = path.join(tmp, 'ep01 [test].mp4');
fs.writeFileSync(file, Buffer.alloc(3 * 1024 * 1024 + 123, 7));
let pass = 0;
const t = async (name, fn) => { try { await fn(); pass += 1; console.log('ok  -', name); } catch (e) { console.log('FAIL-', name, e.stack); process.exitCode = 1; } };

(async () => {
  await t('dead node first, then good node (earnvid) + progress is real, no 99 cap', async () => {
    const m = await startMock({ host: 'earnvid', deadNodes: 1 });
    const ev = [];
    const cfgFn = async () => { const r = await (await fetch(`${m.base}/api/upload/server?key=${m.KEY}`)).json(); return { success: true, uploadUrl: r.result, fieldName: 'key', apiKey: m.KEY }; };
    const r = await uploadFile('earnvid', file, cfgFn, (e) => ev.push(e), { backoffMs: 10 });
    assert.strictEqual(r.fileCode, 'earn123');
    assert.strictEqual(r.attempts, 2);
    assert.strictEqual(m.state.serverCalls, 2);
    const retry = ev.find((e) => e.stage === 'retry');
    assert.ok(retry && /سيرفرًا آخر \(1\/5\)/.test(retry.note), 'retry note ' + (retry && retry.note));
    assert.strictEqual(retry.errClass, 'connection');
    const last = ev[ev.length - 1];
    assert.strictEqual(last.pct, 100);
    const sending = ev.filter((e) => e.stage === 'sending' && !e.sentAll);
    assert.ok(sending.every((e) => e.loaded <= e.total));
    assert.strictEqual(m.state.uploads[0].hasKey, true);
    assert.ok(m.state.uploads[0].size >= 3 * 1024 * 1024);
    await m.close();
  });

  await t('doodstream: key also in the URL query string', async () => {
    const m = await startMock({ host: 'doodstream', deadNodes: 0 });
    const cfgFn = async () => { const r = await (await fetch(`${m.base}/api/upload/server?key=${m.KEY}`)).json(); return { success: true, uploadUrl: r.result, fieldName: 'api_key', apiKey: m.KEY }; };
    const r = await uploadFile('doodstream', file, cfgFn, () => {}, { backoffMs: 10 });
    assert.strictEqual(r.fileCode, 'dood123');
    assert.strictEqual(m.state.uploads[0].query, `?${m.KEY}`);
    await m.close();
  });

  await t('voe response shape (singular file)', async () => {
    const m = await startMock({ host: 'voe', deadNodes: 0 });
    const cfgFn = async () => { const r = await (await fetch(`${m.base}/api/upload/server?key=${m.KEY}`)).json(); return { success: true, uploadUrl: r.result, fieldName: 'key', apiKey: m.KEY }; };
    const r = await uploadFile('voe', file, cfgFn, () => {}, { backoffMs: 10 });
    assert.strictEqual(r.fileCode, 'voe123');
    await m.close();
  });

  await t('stall timeout -> abort -> new server succeeds', async () => {
    const m = await startMock({ host: 'earnvid', deadNodes: 0, stallFirst: 1 });
    const cfgFn = async () => { const r = await (await fetch(`${m.base}/api/upload/server?key=${m.KEY}`)).json(); return { success: true, uploadUrl: r.result, fieldName: 'key', apiKey: m.KEY }; };
    const ev = [];
    const big = path.join(tmp, 'big.mp4'); fs.writeFileSync(big, Buffer.alloc(64 * 1024 * 1024, 1)); // bigger than the kernel socket buffers
    const r = await uploadFile('earnvid', big, cfgFn, (e) => ev.push(e), { backoffMs: 10, stallMs: 1500, progressIntervalMs: 200 });
    assert.strictEqual(r.fileCode, 'earn123');
    const retry = ev.find((e) => e.stage === 'retry');
    assert.strictEqual(retry.errClass, 'stalled');
    assert.ok(ev.some((e) => e.stalled === true), 'stalled flag emitted for the UI');
    await m.close();
  });

  await t('all 6 servers dead -> final readable error, class connection', async () => {
    const m = await startMock({ host: 'earnvid', deadNodes: 99 });
    const cfgFn = async () => { const r = await (await fetch(`${m.base}/api/upload/server?key=${m.KEY}`)).json(); return { success: true, uploadUrl: r.result, fieldName: 'key', apiKey: m.KEY }; };
    const ev = [];
    await assert.rejects(uploadFile('earnvid', file, cfgFn, (e) => ev.push(e), { backoffMs: 5 }), (e) => e.errClass === 'connection' && /تعذر الاتصال/.test(e.message) && e.attempts === 6);
    assert.strictEqual(m.state.serverCalls, 6);
    assert.strictEqual(ev.filter((e) => e.stage === 'retry').length, 5);
    await m.close();
  });

  await t('invalid key -> no retry, class auth, key never in error', async () => {
    const m = await startMock({ host: 'earnvid', deadNodes: 0 });
    const cfgFn = async () => ({ success: true, uploadUrl: `${m.base}/api/upload/server`, fieldName: 'key', apiKey: 'SECRETKEY_zzzzzz' });
    // the "upload" url answers JSON status 403 Wrong Auth (GET path, so POST -> 404 json); emulate with 403 host body
    const http = require('http');
    const srv = http.createServer((q, s) => { q.resume(); q.on('end', () => { s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify({ status: 403, msg: 'Wrong Auth SECRETKEY_zzzzzz' })); }); });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const cfg2 = async () => ({ success: true, uploadUrl: `http://127.0.0.1:${srv.address().port}/upload/01`, fieldName: 'key', apiKey: 'SECRETKEY_zzzzzz' });
    await assert.rejects(uploadFile('earnvid', file, cfg2, () => {}, { backoffMs: 5 }), (e) => { assert.strictEqual(e.errClass, 'auth'); assert.ok(!JSON.stringify([e.message, e.detail]).includes('SECRETKEY'), 'secret leaked'); return true; });
    srv.close(); await m.close();
  });

  await t('cancel via AbortSignal mid-upload', async () => {
    const m = await startMock({ host: 'earnvid', deadNodes: 0, stallFirst: 5 });
    const cfgFn = async () => { const r = await (await fetch(`${m.base}/api/upload/server?key=${m.KEY}`)).json(); return { success: true, uploadUrl: r.result, fieldName: 'key', apiKey: m.KEY }; };
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    await assert.rejects(uploadFile('earnvid', file, cfgFn, () => {}, { signal: ac.signal, stallMs: 30000 }), (e) => e.cancelled);
    await m.close();
  });

  await t('connect timeout (blackhole address) is classified', async () => {
    // 10.255.255.1 is non-routable: SYN is dropped -> connect timeout (or ENETUNREACH in sandbox: both are connection-class)
    const cfgFn = async () => ({ success: true, uploadUrl: 'http://10.255.255.1/upload/01', fieldName: 'key', apiKey: 'KEYKEYKEY1' });
    const ev = [];
    await assert.rejects(uploadFile('earnvid', file, cfgFn, (e) => ev.push(e), { maxTries: 2, connectTimeoutMs: 800, backoffMs: 5 }), (e) => ['connection', 'timeout'].includes(e.errClass));
  });

  await t('processing: EarnVid encodings progress then canplay', async () => {
    const m = await startMock({ host: 'earnvid', canplayAfter: 3 });
    const ups = [];
    const r = await pollProcessing('earnvid', { apiKey: m.KEY, fileCode: 'earn123', onUpdate: (s) => ups.push(s), intervalMs: 20, baseUrls: { earnvid: `${m.base}/api` } });
    assert.ok(r.done);
    const encoding = ups.filter((u) => u.state === 'encoding');
    assert.ok(encoding.length >= 1 && encoding.every((u) => typeof u.pct === 'number'));
    assert.strictEqual(ups[ups.length - 1].state, 'done');
    await m.close();
  });
  await t('processing: Doodstream gives no percentage (null) until canplay=1', async () => {
    const m = await startMock({ canplayAfter: 2 });
    const ups = [];
    await pollProcessing('doodstream', { apiKey: m.KEY, fileCode: 'dood123', onUpdate: (s) => ups.push(s), intervalMs: 20, baseUrls: { doodstream: `${m.base}/api` } });
    assert.ok(ups.filter((u) => u.state === 'waiting').every((u) => u.pct === null));
    assert.strictEqual(ups[ups.length - 1].state, 'done');
    await m.close();
  });
  await t('processing: VOE without flag -> honest indeterminate, no number', async () => {
    const m = await startMock({ voeNoFlag: true });
    const ups = [];
    const r = await pollProcessing('voe', { apiKey: m.KEY, fileCode: 'voe123', onUpdate: (s) => ups.push(s), intervalMs: 10, baseUrls: { voe: `${m.base}/api` } });
    assert.ok(r.indeterminate);
    assert.strictEqual(ups[ups.length - 1].indeterminate, true);
    await m.close();
  });
  await t('parsers + classify + redact', () => {
    assert.deepStrictEqual(parseEarnvid({ result: [{ canplay: 1 }] }, {}).state, 'done');
    assert.strictEqual(parseEarnvid({ result: [{ canplay: 0 }] }, { result: [{ progress: 10 }, { progress: 30 }] }).pct, 20);
    assert.strictEqual(parseDood({ result: [{ canplay: 0 }] }).pct, null);
    assert.strictEqual(parseVoe({ result: [{ status: 200 }] }).state, 'unknown');
    assert.strictEqual(classifyError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT 1.2.3.4:443' }).cls, 'connection');
    assert.strictEqual(classifyError({ httpStatus: 507, message: 'x' }).cls, 'quota');
    assert.strictEqual(classifyError({ httpStatus: 500, message: 'x' }).cls, 'http5xx');
    assert.strictEqual(classifyError({ httpStatus: 415, message: 'x' }).cls, 'rejected');
    assert.ok(!redact('https://a.b/upload/01?ABCDEFGH12345 and ?key=SECRET99').includes('ABCDEFGH'));
  });
  console.log(`\n${pass} passed`); process.exit(process.exitCode || 0);
})();
