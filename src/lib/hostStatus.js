'use strict';

// The "processing" stage: after the bytes are on the host it encodes the video. We only ever report what the host's
// own API tells us:
//  * EarnVid:    file/encodings -> per-quality `progress` (real %), file/info -> canplay (0/1)
//  * Doodstream: file/info -> canplay (0/1) only. No percentage exists, so none is shown.
//  * VOE:        encodings/list -> per-quality `percent` (real %), filtered by file_code; no entry + file/info 200 = done.
//                Indeterminate only if the API gives nothing usable.
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

// VOE (official docs): GET encodings/list?key=  -> data[]{ status, percent, quality, error, file_code } for ALL of the
// account's files (no file_code filter), file/info -> result[]{ status 200|404 } (no canplay, no percent).
// ONE shared encodings/list request serves every VOE file in flight (cached ~3 s, in-flight de-duplicated) so
// several uploads never go near VOE's 3-4 req/s limit.
const voeShared = new Map(); // key+base -> { at, promise }
function voeEncodings(base, apiKey, signal, ttlMs = 3000) {
  const id = `${base}|${apiKey}`;
  const hit = voeShared.get(id);
  if (hit && Date.now() - hit.at < ttlMs) return hit.promise;
  const promise = getJson(`${base}/encodings/list`, { key: apiKey, details: 'false' }, signal).then((r) => {
    if (r.status === 429) throw Object.assign(new Error('429'), { rateLimited: true });
    return r.data;
  });
  voeShared.set(id, { at: Date.now(), promise });
  promise.catch(() => { if (voeShared.get(id) && voeShared.get(id).promise === promise) voeShared.delete(id); });
  return promise;
}

// Pure: entries of this file from the encodings list -> state (or null when the file has no entry / list unusable)
function parseVoeEncodings(enc, fileCode) {
  if (!enc || !Array.isArray(enc.data)) return { usable: false };
  const mine = enc.data.filter((e) => String(e.file_code) === String(fileCode));
  if (!mine.length) return { usable: true, entries: 0 };
  const err = mine.find((e) => e.error);
  if (err) return { usable: true, entries: mine.length, state: 'error', pct: null, detail: String(err.error).slice(0, 200) };
  const nums = mine.map((e) => Number(e.percent)).filter((n) => Number.isFinite(n));
  if (!nums.length) return { usable: true, entries: mine.length, state: 'waiting', pct: null };
  const avg = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);
  return { usable: true, entries: mine.length, state: 'encoding', pct: Math.min(99, avg), minPct: Math.min(...nums), qualities: nums.length };
}

// Polls until done / timeout / abort. onUpdate gets { state, pct, minPct?, qualities?, indeterminate? }.
async function pollProcessing(host, { apiKey, fileCode, onUpdate, signal, intervalMs, maxMs = 3 * 60 * 60 * 1000, baseUrls = {}, sleepFn = sleep }) {
  const base = baseUrls[host] || BASES[host];
  const every = intervalMs || (host === 'earnvid' ? POLL.earnvid : POLL.other);
  const started = Date.now();
  let failures = 0;
  let voeProbes = 0; let voeEmpty = 0; let voeMissing = 0; let voeSeen = false;
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
        const enc = parseVoeEncodings(await voeEncodings(base, apiKey, signal), fileCode);
        if (enc.usable && enc.entries) {
          voeEmpty = 0; voeSeen = true;
          s = enc.state === 'error' ? { state: 'error', pct: null, detail: enc.detail } : enc.state === 'waiting' ? { state: 'waiting', pct: null } : { state: 'encoding', pct: enc.pct, minPct: enc.minPct, qualities: enc.qualities };
        } else {
          // no entry: finished (or not queued yet) -> ask file/info; 200 = exists
          const info = await getJson(`${base}/file/info`, { key: apiKey, file_code: fileCode }, signal);
          if (info.status === 429) throw Object.assign(new Error('429'), { rateLimited: true });
          const item = first(info.data);
          const st = item ? Number(item.status) : null;
          if (st === 404) { voeMissing += 1; s = voeMissing >= 3 ? { state: 'error', pct: null, detail: 'file not found on VOE (404)' } : { state: 'waiting', pct: null }; }
          else if (st === 200 && enc.usable) {
            voeEmpty += 1; voeMissing = 0;
            // right after the upload the entry may not be listed yet: need 2 empty polls unless we already saw it encoding
            s = voeSeen || voeEmpty >= 2 ? { state: 'done', pct: 100, canplay: true } : { state: 'waiting', pct: null };
          } else {
            voeProbes += 1;
            if (voeProbes >= 3) { onUpdate && onUpdate({ state: 'done', pct: 100, indeterminate: true }); return { done: true, indeterminate: true }; }
            s = { state: 'unknown', pct: null };
          }
        }
      }
      failures = 0; backoff = 0;
      onUpdate && onUpdate(s);
      if (s.state === 'done') return { done: true };
      if (s.state === 'error') return { error: s.detail || 'encoding failed', encodingError: true };
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

module.exports = { pollProcessing, parseEarnvid, parseDood, parseVoeEncodings, voeShared, BASES, POLL };
