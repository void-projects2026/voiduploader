'use strict';

// Direct binary upload to EarnVid / Doodstream / Voe, run from Electron's MAIN process (Node http/https: no CORS).
//
// 2.8.0 rewrite of the transfer layer:
//  * raw http/https streaming from disk (never reads the file into memory), real "bytes flushed" progress;
//  * connect timeout (20 s) + stall timeout (60 s without progress) -> abort;
//  * dead upload node handling: the hosts hand out a different node (random CDN sub-domain) on every
//    /api/upload/server call and now and then one is dead (ETIMEDOUT ...). When the connection fails or stalls we
//    ask for a NEW server (the site's direct-init gives a fresh one each call) and send again, up to 6 servers;
//  * no fake 99% cap: stage "sending" reports measured bytes only; the "processing" stage lives in hostStatus.js.
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { classifyError, isConnectError, errCode, redact, sleep, MAX_SERVER_TRIES } = require('./netErrors');

const PROVIDERS = {
  doodstream: {
    fileField: 'api_key',
    embedUrl: (fileCode) => `https://doodstream.com/e/${fileCode}`,
    // Doodstream wants the key in the upload URL query string as well: `.../upload/01?{key}`
    decorateUrl: (url, key) => (url.includes('?') ? url : `${url}?${key}`),
    parse: (json) => {
      const entry = Array.isArray(json?.result) ? json.result[0] : json?.result;
      const fileCode = entry?.filecode || entry?.file_code;
      if (json?.status === 200 && fileCode) return { fileCode };
      throw hostError(json?.msg || 'فشل رفع Doodstream', json);
    },
  },
  earnvid: {
    fileField: 'key',
    embedUrl: (fileCode) => `https://xvs.tt/${fileCode}.html`,
    decorateUrl: (url) => url,
    parse: (json) => {
      const entry = Array.isArray(json?.files) ? json.files[0] : (Array.isArray(json?.result) ? json.result[0] : json?.result);
      const fileCode = entry?.filecode || entry?.file_code;
      // official docs: { files:[{ filecode, filename, status:"OK" }] }
      if (fileCode && (json?.status === 200 || entry?.status === 'OK' || json?.status === undefined)) return { fileCode };
      throw hostError(json?.msg || 'فشل رفع EarnVid', json);
    },
  },
  voe: {
    fileField: 'key',
    embedUrl: (fileCode) => `https://voe.sx/e/${fileCode}`,
    decorateUrl: (url) => url,
    // Confirmed live 2026-11-16: `{ success: true, file: { file_code, ... } }` (singular "file"); other shapes kept as fallback.
    parse: (json) => {
      const candidates = [json?.file, json?.result, Array.isArray(json?.result) ? json.result[0] : null, json?.files?.[0], json].filter(Boolean);
      for (const c of candidates) {
        const fileCode = c?.file_code || c?.filecode;
        if (fileCode) return { fileCode };
      }
      throw hostError(json?.message || json?.msg || 'فشل رفع Voe', json);
    },
  },
};

const HOST_KEYS = ['earnvid', 'doodstream', 'voe'];

// Host answered 200 but the body says it failed: classify by the message text.
function hostError(message, json) {
  const e = new Error(message);
  e.hostBody = true;
  if (json && Number(json.status) >= 400) e.httpStatus = Number(json.status);
  e.detail = message;
  return e;
}

const DEFAULTS = {
  connectTimeoutMs: 20000,
  stallMs: 60000,
  responseTimeoutMs: 15 * 60 * 1000, // after the last byte left: the host may take long to answer
  configTimeoutMs: 30000,
  backoffMs: 1500,
  progressIntervalMs: 250,
  midTransferRetries: 2,
};

const RETRY_STATUS = new Set([301, 302, 307, 308, 408, 425, 502, 503, 504, 520, 521, 522, 523, 524]);

function buildMultipart({ fields, fileName, fileSize }) {
  const boundary = `----VoidUploader${crypto.randomBytes(12).toString('hex')}`;
  let head = '';
  for (const [k, v] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  }
  const safeName = String(fileName).replace(/[\r\n"]/g, '_');
  head += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  const prefix = Buffer.from(head, 'utf8');
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return { boundary, prefix, suffix, total: prefix.length + fileSize + suffix.length, fileSize };
}

// One multipart POST. Resolves { status, body, sent } or rejects with an Error carrying `.sent` (payload bytes flushed).
function postMultipart(urlStr, { fields, filePath, fileName, fileSize }, hooks = {}, opt = {}) {
  const o = { ...DEFAULTS, ...opt };
  const url = new URL(urlStr);
  const lib = url.protocol === 'http:' ? http : https;
  const mp = buildMultipart({ fields, fileName, fileSize });
  return new Promise((resolve, reject) => {
    let flushed = 0; // payload (file) bytes handed to the kernel
    let lastProgressAt = Date.now();
    let bodyDone = false;
    let settled = false;
    let fileStream = null;
    let timers = [];
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearInterval); timers.forEach(clearTimeout);
      if (hooks.signal) hooks.signal.removeEventListener('abort', onAbort);
      if (fileStream) fileStream.destroy();
      fn(val);
    };
    const fail = (err) => { err.sent = flushed; finish(reject, err); };
    const req = lib.request({
      protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${mp.boundary}`, 'Content-Length': mp.total },
      agent: false,
    });
    const onAbort = () => { const e = new Error('cancelled'); e.cancelled = true; req.destroy(); fail(e); };
    if (hooks.signal) {
      if (hooks.signal.aborted) return onAbort();
      hooks.signal.addEventListener('abort', onAbort, { once: true });
    }

    // connect timeout: from now until the TCP/TLS connection is up
    const connectTimer = setTimeout(() => {
      const e = new Error(`connect timeout after ${o.connectTimeoutMs} ms (${url.hostname})`);
      e.code = 'ECONNECT_TIMEOUT';
      req.destroy(); fail(e);
    }, o.connectTimeoutMs);
    timers.push(connectTimer);
    req.on('socket', (socket) => {
      const up = () => clearTimeout(connectTimer);
      if (!socket.connecting && (!socket.encrypted || socket.authorized !== undefined)) up();
      socket.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', up);
    });

    // stall + progress ticker
    let lastReported = -1;
    const tick = setInterval(() => {
      const now = Date.now();
      if (hooks.onProgress && flushed !== lastReported) { lastReported = flushed; hooks.onProgress(flushed, mp.fileSize); }
      if (!bodyDone && now - lastProgressAt > o.stallMs) {
        const e = new Error(`no upload progress for ${Math.round(o.stallMs / 1000)} s`);
        e.code = 'ESTALLED';
        req.destroy(); fail(e);
      }
      if (hooks.onTick) hooks.onTick({ flushed, stalledFor: bodyDone ? 0 : now - lastProgressAt });
    }, Math.min(o.progressIntervalMs, 1000));
    timers.push(tick);

    req.on('error', (err) => fail(err));
    req.on('response', (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => { size += c.length; if (size < 1024 * 1024) chunks.push(c); });
      res.on('end', () => {
        if (hooks.onProgress) hooks.onProgress(flushed, mp.fileSize);
        const text = Buffer.concat(chunks).toString('utf8');
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
        finish(resolve, { status: res.statusCode, body, text: text.slice(0, 300), sent: flushed });
      });
      res.on('error', (e) => fail(e));
    });

    const written = (n) => () => { flushed += n; lastProgressAt = Date.now(); };
    req.write(mp.prefix);
    fileStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
    fileStream.on('data', (c) => {
      if (!req.write(c, written(c.length))) {
        fileStream.pause();
        req.once('drain', () => fileStream && fileStream.resume());
      }
    });
    fileStream.on('end', () => {
      bodyDone = true;
      lastProgressAt = Date.now();
      // response watchdog: the host may encode/store before answering, but not forever
      timers.push(setTimeout(() => {
        const e = new Error(`no response ${Math.round(o.responseTimeoutMs / 1000)} s after the upload finished`);
        e.code = 'ETIMEDOUT';
        e.errClass = 'timeout';
        req.destroy(); fail(e);
      }, o.responseTimeoutMs));
      req.end(mp.suffix);
    });
    fileStream.on('error', (e) => { req.destroy(); fail(e); });
  });
}

// `uploadConfig` is either an object or an async function returning { success, uploadUrl, fieldName, apiKey, error }
// that asks the site for a FRESH upload server each call (the site's direct-init does exactly that).
// onEvent receives { stage:'sending', loaded,total,pct,bytesPerSec,attempt,maxAttempts,stalled } and
// { stage:'retry', attempt,maxAttempts,errClass,note,detail }.
async function uploadFile(host, filePath, uploadConfig, onEvent, options = {}) {
  const cfg = PROVIDERS[host];
  if (!cfg) throw new Error(`استضافة غير معروفة: ${host}`);
  const emit = (e) => { try { onEvent && onEvent(e); } catch { /* UI callback must never break the upload */ } };
  const stat = fs.statSync(filePath);
  const fileName = require('path').basename(filePath);
  const getConfig = typeof uploadConfig === 'function' ? uploadConfig : async () => ({ success: true, ...uploadConfig });
  const o = { ...DEFAULTS, ...options };
  const maxTries = options.maxTries || MAX_SERVER_TRIES;
  let lastErr = null;
  let midRetries = 0;
  let secrets = [];

  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    if (options.signal && options.signal.aborted) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
    let sent = 0;
    try {
      // 1) a (new) upload server
      let conf;
      try {
        conf = await withTimeout(getConfig(attempt), o.configTimeoutMs, 'timeout asking for an upload server');
      } catch (e) {
        if (!e.code) e.code = 'ECONNECT_TIMEOUT';
        throw e;
      }
      if (!conf || !conf.success || !conf.uploadUrl || !conf.apiKey) {
        const e = new Error((conf && conf.error) || `تعذر الحصول على سيرفر رفع ${host}`);
        e.configFailure = true;
        e.httpStatus = conf && conf.httpStatus;
        throw e;
      }
      secrets = [conf.apiKey];
      const url = cfg.decorateUrl(conf.uploadUrl, conf.apiKey);
      const fields = { [conf.fieldName || cfg.fileField]: conf.apiKey };

      // 2) the transfer
      let lastLoaded = 0; let lastT = Date.now(); let rate = 0; let rateAt = 0;
      const res = await postMultipart(url, { fields, filePath, fileName, fileSize: stat.size }, {
        signal: options.signal,
        onProgress: (loaded, total) => {
          const now = Date.now();
          const dt = (now - lastT) / 1000;
          if (dt >= 0.25) { rate = Math.max(0, (loaded - lastLoaded) / dt); lastLoaded = loaded; lastT = now; rateAt = now; }
          sent = loaded;
          emit({ stage: 'sending', loaded, total, pct: total ? Math.floor((loaded / total) * 100) : 0, bytesPerSec: rate, attempt, maxAttempts: maxTries, stalled: false });
        },
        onTick: ({ stalledFor }) => { if (stalledFor > Math.min(5000, o.stallMs / 2)) emit({ stage: 'sending', loaded: sent, total: stat.size, pct: stat.size ? Math.floor((sent / stat.size) * 100) : 0, bytesPerSec: 0, attempt, maxAttempts: maxTries, stalled: true }); },
      }, o);
      sent = res.sent;

      if (RETRY_STATUS.has(res.status)) {
        const e = new Error(`upload node answered HTTP ${res.status}`);
        e.httpStatus = res.status; e.nodeProblem = true;
        throw e;
      }
      if (res.status === 429) { const e = new Error('rate limited (HTTP 429)'); e.httpStatus = 429; e.rateLimited = true; throw e; }
      if (res.status >= 400) {
        const e = new Error(`HTTP ${res.status} ${(res.body && (res.body.msg || res.body.message)) || res.text || ''}`.trim());
        e.httpStatus = res.status;
        throw e;
      }
      if (!res.body) { const e = new Error(`الرد ليس JSON صالحًا (HTTP ${res.status})`); e.httpStatus = res.status; e.nodeProblem = true; throw e; }
      const { fileCode } = cfg.parse(res.body);
      emit({ stage: 'sending', loaded: stat.size, total: stat.size, pct: 100, bytesPerSec: 0, attempt, maxAttempts: maxTries, stalled: false, sentAll: true });
      return { fileCode, embedUrl: cfg.embedUrl(fileCode), apiKey: conf.apiKey, attempts: attempt };
    } catch (err) {
      lastErr = err;
      if (err.cancelled) throw err;
      const code = errCode(err);
      const sentSmall = (err.sent != null ? err.sent : sent) < 1024 * 1024;
      const connectish = isConnectError(err) || code === 'ECONNECT_TIMEOUT' || code === 'ESTALLED';
      let retry = false;
      if (err.rateLimited) retry = true;
      else if (err.configFailure) retry = !err.httpStatus || err.httpStatus >= 500 || err.httpStatus === 429;
      else if (err.nodeProblem) retry = true;
      else if (connectish && sentSmall) retry = true;
      else if (connectish || code === 'ESTALLED') { retry = midRetries < o.midTransferRetries; midRetries += 1; }
      if (!retry || attempt === maxTries) break;
      const c = classifyError(err, secrets);
      const wait = err.rateLimited ? Math.min(30000, o.backoffMs * 2 * attempt) : Math.min(8000, o.backoffMs * attempt);
      emit({
        stage: 'retry', attempt, maxAttempts: maxTries, errClass: c.cls, detail: c.detail,
        note: `${c.ar}، نجرّب سيرفرًا آخر (${attempt}/${maxTries - 1})`, waitMs: wait,
      });
      await sleep(wait);
    }
  }
  const c = classifyError(lastErr, secrets);
  const final = new Error(c.ar);
  final.errClass = c.cls;
  final.detail = c.detail;
  final.httpStatus = lastErr && lastErr.httpStatus;
  final.attempts = maxTries;
  throw final;
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, rej) => { t = setTimeout(() => { const e = new Error(label); e.code = 'ECONNECT_TIMEOUT'; rej(e); }, ms); }),
  ]).finally(() => clearTimeout(t));
}

module.exports = { uploadFile, postMultipart, HOST_KEYS, PROVIDERS, DEFAULTS, redact, withTimeout };
