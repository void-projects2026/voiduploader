'use strict';

// Client for the site's "upload through our server" relay (server/upload-relay.mjs): one copy of the video goes to the
// Despair server in resumable 50 MB chunks, the server then uploads it to the 3 hosts. The CDN in front of the site
// refuses bodies above 100 MB, hence the chunks. Every chunk: raw PUT body + SHA-256 header, retried on its own;
// an interrupted upload is resumed by asking the server which chunks it already has.
const fs = require('fs');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { sleep, redact } = require('./netErrors');

const PREFIX = '/api/cache/upload-relay';

class RelayError extends Error {
  constructor(message, { status, code, errClass, retryable } = {}) {
    super(message);
    this.httpStatus = status; this.serverCode = code; this.errClass = errClass; this.retryable = !!retryable;
  }
}

class RelayClient {
  // getToken(): current access token; refreshToken(): async -> fresh token or null (called once on 401/403)
  constructor({ baseUrl, getToken, refreshToken, chunkRetries = 5, backoffMs = 1500, requestTimeoutMs = 30000, stallMs = 60000 }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.getToken = getToken;
    this.refreshToken = refreshToken || (async () => null);
    this.chunkRetries = chunkRetries;
    this.backoffMs = backoffMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.stallMs = stallMs;
  }

  // One HTTP exchange via node http(s): body is a Buffer written in small pieces so we get real flushed-byte progress.
  _request(method, pathAndQuery, { json, buf, headers = {}, onBytes, signal, timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + PREFIX + pathAndQuery);
      const lib = url.protocol === 'http:' ? http : https;
      const body = buf || (json !== undefined ? Buffer.from(JSON.stringify(json)) : null);
      const h = { Authorization: `Bearer ${this.getToken()}`, ...headers };
      if (json !== undefined) h['Content-Type'] = 'application/json';
      if (buf) h['Content-Type'] = 'application/octet-stream';
      if (body) h['Content-Length'] = body.length;
      const req = lib.request({ protocol: url.protocol, hostname: url.hostname, port: url.port || undefined, path: url.pathname + url.search, method, headers: h, agent: false });
      let done = false; let lastActivity = Date.now(); let flushed = 0;
      const end = (fn, v) => { if (done) return; done = true; clearInterval(watch); signal && signal.removeEventListener('abort', onAbort); fn(v); };
      const onAbort = () => { const e = new Error('cancelled'); e.cancelled = true; req.destroy(); end(reject, e); };
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, { once: true }); }
      const limit = timeoutMs || this.requestTimeoutMs;
      const watch = setInterval(() => {
        if (Date.now() - lastActivity > (body && body.length > 1e6 ? this.stallMs : limit)) {
          const e = new Error('relay request stalled'); e.code = 'ESTALLED'; req.destroy(); end(reject, e);
        }
      }, 1000);
      req.on('error', (e) => end(reject, e));
      req.on('response', (res) => {
        const parts = [];
        res.on('data', (c) => { lastActivity = Date.now(); parts.push(c); });
        res.on('end', () => {
          const text = Buffer.concat(parts).toString('utf8');
          let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* html error page from the CDN etc. */ }
          end(resolve, { status: res.statusCode, data, text: text.slice(0, 200) });
        });
        res.on('error', (e) => end(reject, e));
      });
      if (!body) return req.end();
      const PIECE = 256 * 1024;
      let off = 0;
      const pump = () => {
        while (off < body.length) {
          const piece = body.subarray(off, off + PIECE);
          off += piece.length;
          const ok = req.write(piece, () => { flushed += piece.length; lastActivity = Date.now(); onBytes && onBytes(flushed); });
          if (!ok) { req.once('drain', pump); return; }
        }
        req.end();
      };
      pump();
    });
  }

  // Wraps _request: refreshes the token once on 401/403; returns parsed JSON or throws RelayError.
  async _call(method, p, opts = {}) {
    let res = await this._request(method, p, opts);
    if (res.status === 401 || res.status === 403) {
      const fresh = await this.refreshToken().catch(() => null);
      if (fresh) { this._token = fresh; res = await this._request(method, p, opts); }
    }
    if (res.status >= 200 && res.status < 300 && res.data) return res.data;
    const code = res.data && res.data.error;
    throw new RelayError(this._explain(res.status, code), {
      status: res.status, code,
      errClass: res.status === 507 || res.status === 413 ? 'quota' : (res.status === 403 || res.status === 401 ? 'auth' : (res.status >= 500 || res.status === 0 ? 'http5xx' : 'http4xx')),
      retryable: res.status >= 500 || res.status === 408 || res.status === 429 || (!res.data && res.status >= 300),
    });
  }

  _explain(status, code) {
    const map = {
      forbidden: 'ليس لديك صلاحية الرفع عبر السيرفر',
      file_too_large: 'الملف أكبر من الحد المسموح (4 جيجابايت)',
      not_enough_disk_space: 'لا توجد مساحة كافية على السيرفر',
      too_many_active_relays: 'لديك عمليات رفع نشطة على السيرفر، احذف إحداها أولاً',
      server_busy: 'السيرفر مشغول برفع آخر، حاول لاحقًا',
      host_not_configured: 'مفتاح إحدى الاستضافات غير مضبوط على السيرفر',
      not_a_video: 'السيرفر لا يقبل هذا النوع من الملفات',
      relay_not_found: 'انتهت صلاحية الملف على السيرفر',
      checksum_mismatch: 'تلف جزء أثناء النقل',
    };
    return map[code] || `رد السيرفر ${status}${code ? ` (${code})` : ''}`;
  }

  async init({ filename, size, hosts, title }) { return this._call('POST', '/init', { json: { filename, size, hosts, title } }); }
  async status(relayId) { return this._call('GET', `/status?relayId=${encodeURIComponent(relayId)}`); }
  async finish(relayId) { return this._call('POST', `/finish?relayId=${encodeURIComponent(relayId)}`); }
  async retryHost(relayId, host) { return this._call('POST', `/retry?relayId=${encodeURIComponent(relayId)}&host=${encodeURIComponent(host)}`); }
  async remove(relayId) { return this._call('DELETE', `/relay?relayId=${encodeURIComponent(relayId)}`); }

  async _readChunk(fd, offset, length) {
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await fd.read(buf, got, length - got, offset + got);
      if (!bytesRead) throw new Error('file ended early / changed while uploading');
      got += bytesRead;
    }
    return buf;
  }

  // Uploads (or resumes) the file. onProgress({ stage:'relay-send', loaded,total,pct,bytesPerSec,chunk,chunks,note,stalled }).
  // Resolves { relayId }. `relayId` (previous attempt) makes it a resume: only the chunks the server lacks are sent.
  async upload({ filePath, hosts, title, relayId, onProgress, onRelayId, signal }) {
    const emit = (e) => { try { onProgress && onProgress(e); } catch { /* ignore */ } };
    const stat = fs.statSync(filePath);
    const filename = require('path').basename(filePath);
    let info = null;
    if (relayId) {
      try { info = await this.status(relayId); } catch (e) { if (e.serverCode !== 'relay_not_found') throw e; relayId = null; }
      if (info && (info.size !== stat.size || info.state !== 'receiving')) {
        if (info.state === 'receiving') { await this.remove(relayId).catch(() => {}); relayId = null; info = null; } // file changed: start over
        else return { relayId, resumedPastUpload: true, status: info }; // already assembled / running
      }
    }
    if (!relayId) {
      const r = await this.init({ filename, size: stat.size, hosts, title });
      relayId = r.relayId;
      info = { chunkSize: r.chunkSize, totalChunks: r.totalChunks, received: [] };
    }
    if (onRelayId) onRelayId(relayId);
    const { chunkSize, totalChunks } = info;
    const have = new Set(info.received || []);
    const lenOf = (i) => (i === totalChunks - 1 ? stat.size - i * chunkSize : chunkSize);
    let doneBytes = 0;
    for (const i of have) doneBytes += lenOf(i);
    const startBytes = doneBytes;
    emit({ stage: 'relay-send', loaded: doneBytes, total: stat.size, pct: Math.floor((doneBytes / stat.size) * 100), bytesPerSec: 0, chunk: have.size, chunks: totalChunks, resumed: have.size > 0 });

    const fd = await fs.promises.open(filePath, 'r');
    const t0 = Date.now();
    let lastT = Date.now(); let lastB = doneBytes; let rate = 0;
    try {
      for (let i = 0; i < totalChunks; i += 1) {
        if (have.has(i)) continue;
        if (signal && signal.aborted) { const e = new Error('cancelled'); e.cancelled = true; throw e; }
        const buf = await this._readChunk(fd, i * chunkSize, lenOf(i));
        const sha = crypto.createHash('sha256').update(buf).digest('hex');
        let lastErr = null;
        for (let attempt = 1; attempt <= this.chunkRetries; attempt += 1) {
          try {
            await this._call('PUT', `/chunk?relayId=${relayId}&index=${i}`, {
              buf, headers: { 'X-Chunk-Sha256': sha }, signal, timeoutMs: 60000,
              onBytes: (b) => {
                const loaded = doneBytes + b; const now = Date.now();
                if (now - lastT >= 400) { rate = Math.max(0, ((loaded - lastB) / (now - lastT)) * 1000); lastT = now; lastB = loaded; }
                emit({ stage: 'relay-send', loaded, total: stat.size, pct: Math.floor((loaded / stat.size) * 100), bytesPerSec: rate, chunk: have.size, chunks: totalChunks, attempt });
              },
            });
            lastErr = null; break;
          } catch (err) {
            lastErr = err;
            if (err.cancelled) throw err;
            if (err.serverCode === 'relay_not_found' || err.serverCode === 'not_receiving' || (err.httpStatus >= 400 && err.httpStatus < 500 && !err.retryable && err.serverCode !== 'checksum_mismatch' && err.serverCode !== 'bad_length')) throw err;
            emit({ stage: 'relay-retry', chunk: i + 1, chunks: totalChunks, attempt, note: `تعذر إرسال الجزء ${i + 1}/${totalChunks}، نعيد المحاولة (${attempt}/${this.chunkRetries})`, detail: redact(err.message) });
            await sleep(Math.min(10000, this.backoffMs * attempt));
          }
        }
        if (lastErr) throw lastErr;
        have.add(i); doneBytes += buf.length;
      }
    } finally {
      await fd.close().catch(() => {});
    }
    emit({ stage: 'relay-send', loaded: stat.size, total: stat.size, pct: 100, bytesPerSec: 0, chunk: totalChunks, chunks: totalChunks, sentBytes: stat.size - startBytes, ms: Date.now() - t0 });
    await this._finishWithRetry(relayId, signal);
    return { relayId };
  }

  async _finishWithRetry(relayId, signal) {
    let last;
    for (let a = 1; a <= 5; a += 1) {
      try { return await this.finish(relayId); } catch (e) {
        last = e;
        if (e.cancelled || (e.httpStatus >= 400 && e.httpStatus < 500 && !e.retryable)) throw e;
        await sleep(this.backoffMs * a);
        if (signal && signal.aborted) { const c = new Error('cancelled'); c.cancelled = true; throw c; }
      }
    }
    throw last;
  }
}

// Maps a relay status payload's host entry to the app's per-host job state (same shape the UI already understands).
function relayHostToJobState(h, size) {
  const base = { attempt: h.attempt || 0, maxAttempts: h.maxAttempts || 6, note: h.note || null, stalled: !!h.stalled, bytesPerSec: h.bytesPerSec || 0 };
  switch (h.state) {
    case 'pending': return { ...base, status: 'uploading', stage: 'relay-queue', progress: 0, loaded: 0, total: size };
    case 'sending': return { ...base, status: 'uploading', stage: 'sending', progress: size ? Math.floor((h.sentBytes / size) * 100) : 0, loaded: h.sentBytes, total: size };
    case 'processing': return { ...base, status: 'processing', stage: 'processing', progress: 100, loaded: size, total: size, fileCode: h.fileCode, processing: h.processing };
    case 'done': return { ...base, status: 'done', stage: 'done', progress: 100, loaded: size, total: size, fileCode: h.fileCode, processing: h.processing };
    case 'error': return { ...base, status: 'error', stage: 'error', errClass: h.errClass, error: h.error, detail: h.detail };
    default: return base;
  }
}

module.exports = { RelayClient, RelayError, relayHostToJobState };
