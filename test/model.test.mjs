import assert from 'node:assert';
import { hostView, flowParams, relayView, jobSummary } from '../src/renderer/workflow/model.mjs';
let n = 0; const t = (name, f) => { f(); n += 1; console.log('ok  -', name); };
t('sending shows measured pct only, never above 100, no 99 cap', () => {
  assert.strictEqual(hostView({ host: 'earnvid', status: 'uploading', stage: 'sending', progress: 100, bytesPerSec: 5e6 }).pct, 100);
  assert.strictEqual(hostView({ host: 'earnvid', status: 'uploading', stage: 'sending', progress: 42 }).label, 'إرسال 42%');
});
t('processing: EarnVid real %, others no number', () => {
  assert.strictEqual(hostView({ host: 'earnvid', status: 'processing', processing: { state: 'encoding', pct: 37 } }).pct, 37);
  const d = hostView({ host: 'doodstream', status: 'processing', processing: { state: 'waiting', pct: null } });
  assert.strictEqual(d.pct, null); assert.match(d.label, /بانتظار الاستضافة/);
  const v = hostView({ host: 'voe', status: 'processing', processing: { state: 'unknown', pct: null } });
  assert.strictEqual(v.pct, null);
});
t('retry note / stall / error / done', () => {
  assert.strictEqual(hostView({ host: 'voe', status: 'uploading', stage: 'sending', note: 'عقدة الرفع لا تستجيب، نجرّب سيرفرًا آخر (2/6)', progress: 0 }).phase, 'retrying');
  assert.strictEqual(hostView({ host: 'voe', status: 'uploading', stage: 'sending', stalled: true, progress: 40, bytesPerSec: 0 }).phase, 'stalled');
  const e = hostView({ host: 'voe', status: 'error', errClass: 'connection', detail: 'connect ETIMEDOUT 1.2.3.4:443' });
  assert.strictEqual(e.phase, 'error'); assert.match(e.label, /تعذر الاتصال/); assert.match(e.tip, /ETIMEDOUT/);
  assert.strictEqual(hostView({ host: 'voe', status: 'done', embedUrl: 'x' }).pct, 100);
});
t('flow density follows bytes/sec and is zero when stalled/idle', () => {
  assert.strictEqual(flowParams(0).balls, 0);
  assert.ok(flowParams(20e6).balls > flowParams(100e3).balls);
  assert.ok(flowParams(20e6).dur < flowParams(100e3).dur);
  assert.strictEqual(flowParams(5e6, false).balls, 0);
});
t('relay leg + summary', () => {
  assert.match(relayView({ relay: { stage: 'sending', pct: 10, chunk: 1, chunks: 5, bytesPerSec: 1e6 } }).label, /جزء 2\/5/);
  assert.strictEqual(relayView({ relay: { stage: 'server' } }).phase, 'done');
  const s = jobSummary({ hosts: [{ host: 'a', status: 'done' }, { host: 'b', status: 'error', errClass: 'auth' }] });
  assert.ok(s.failed && !s.active && !s.done);
});
console.log(`\n${n} passed`);
