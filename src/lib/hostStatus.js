'use strict';

// The "processing" stage: after the bytes are on the host it encodes the video. We only ever report what the host's
// own API tells us:
//  * EarnVid:    file/encodings -> per-quality `progress` (real %), file/info -> canplay (0/1)
//  * Doodstream: file/info -> canplay (0/1) only. No percentage exists, so none is shown.
//  * VOE:        file/info result[0]; the docs are unavailable and the existing code only uses its 404 status. If the
//                answer carries a canplay-like flag we use it, otherwise the state is honestly "indeterminate".
const axios = require('axios');
const { sleep } = require('./netErrors');

const BASES = {
  earnvid: 'https://earnvidsapi.com/api',
  doodstream: 'https://doodapi.co/api',
  voe: 'https://voe.sx/api',
};

// polling cadence (ms): EarnVid ~4 s as the docs suggest; Doodstream (10 req/s limit) and VOE every 6 s. Tests lower these.
const POLL = { earnvid: 4000, other: 6000 };

async function getJson(url, params, signal) {
  const res = await axios.get(url, { params, timeout: 20000, validateStatus: () => true, signal, maxContentLength: 1024 * 1024 });
  return { status: res.status, data: res.data };
}

const first = (d) => (Array.isArray(d?.result) ? d.result[0] : d?.result) || null;

// Pure parsers (unit-tested) ------------------------------------------------
function parseEarnvid(info, enc) {
  const item = first(info);
  const canplay = item ? Number(item.canplay) === 1 : false;
  if (canplay) return { state: 'done', pct: 100, canplay: true };
  const list = Array.isArray(enc?.result) ? enc.result : [];
  const nums = list.map((e) => Number(e.progress)).filter((n) => Number.isFinite(n));
  if (nums.length) {
    const avg = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
    const min = Math.min(...nums);
    const failed = list.some((e) => /error|fail/i.test(String(e.status || '')));
    return { state: failed ? 'error' : 'encoding', pct: Math.min(99, avg), minPct: min, qualities: nums.length, detail: failed ? 'encoding failed' : null, canplay: false };
  }
  return { state: 'waiting', pct: null, canplay: false };
}

function parseDood(info) {
  const item = first(info);
  if (item && Number(item.canplay) === 1) return { state: 'done', pct: 100, canplay: true };
  return { state: 'waiting', pct: null, canplay: false };
}

function parseVoe(info) {
  const item = first(info);
  if (!item) return { state: 'unknown', pct: null };
  if (item.canplay !== undefined) return Number(item.canplay) === 1 ? { state: 'done', pct: 100, canplay: true } : { state: 'waiting', pct: null, canplay: false };
  return { state: 'unknown', pct: null };
}

// Polls until done / timeout / abort. onUpdate gets { state, pct, minPct?, qualities?, indeterminate? }.
async function pollProcessing(host, { apiKey, fileCode, onUpdate, signal, intervalMs, maxMs = 3 * 60 * 60 * 1000, baseUrls = {}, sleepFn = sleep }) {
  const base = baseUrls[host] || BASES[host];
  const every = intervalMs || (host === 'earnvid' ? POLL.earnvid : POLL.other);
  const started = Date.now();
  let failures = 0;
  let voeProbes = 0;
  let backoff = 0;
  while (Date.now() - started < maxMs) {
    if (signal && signal.aborted) return { cancelled: true };
    try {
      let s;
      if (host === 'earnvid') {
        const [info, enc] = await Promise.all([
          getJson(`${base}/file/info`, { key: apiKey, file_code: fileCode }, signal),
          getJson(`${base}/file/encodings`, { key: apiKey, file_code: fileCode }, signal),
        ]);
        if (info.status === 429 || enc.status === 429) throw Object.assign(new Error('429'), { rateLimited: true });
        s = parseEarnvid(info.data, enc.data);
      } else if (host === 'doodstream') {
        const info = await getJson(`${base}/file/info`, { key: apiKey, file_code: fileCode }, signal);
        if (info.status === 429) throw Object.assign(new Error('429'), { rateLimited: true });
        s = parseDood(info.data);
      } else {
        const info = await getJson(`${base}/file/info`, { key: apiKey, file_code: fileCode }, signal);
        if (info.status === 429) throw Object.assign(new Error('429'), { rateLimited: true });
        s = parseVoe(info.data);
        if (s.state === 'unknown') {
          voeProbes += 1;
          if (voeProbes >= 3) { onUpdate && onUpdate({ state: 'done', pct: 100, indeterminate: true }); return { done: true, indeterminate: true }; }
        }
      }
      failures = 0; backoff = 0;
      onUpdate && onUpdate(s);
      if (s.state === 'done') return { done: true };
      if (s.state === 'error') return { error: s.detail || 'encoding failed' };
    } catch (err) {
      if (signal && signal.aborted) return { cancelled: true };
      failures += 1;
      if (err.rateLimited) backoff = Math.min(60000, (backoff || every) * 2);
      if (failures > 12) return { error: 'status API unreachable' };
    }
    await sleepFn(every + backoff + Math.floor(Math.random() * 400));
  }
  return { timedOut: true };
}

module.exports = { pollProcessing, parseEarnvid, parseDood, parseVoe, BASES, POLL };
