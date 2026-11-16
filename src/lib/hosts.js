'use strict';

// Direct binary upload to EarnVid / Doodstream / Voe, run from Electron's
// MAIN process (not a browser renderer) - CORS is a browser-only
// restriction enforced by fetch/XHR in a page context; Node's own
// http/https client (what axios uses under the hood here) never applies
// it, so hitting these hosts' upload-server endpoint and reading its JSON
// response back works for all 3, including EarnVid whose response the
// website's own browser-based admin panel cannot read (no CORS header on
// EarnVid's reply) - that limitation simply does not exist here.
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

const PROVIDERS = {
  doodstream: {
    serverEndpoint: (key) => `https://doodapi.co/api/upload/server?key=${encodeURIComponent(key)}`,
    fileField: 'api_key',
    embedUrl: (fileCode) => `https://doodstream.com/e/${fileCode}`,
    parse: (json) => {
      const entry = Array.isArray(json?.result) ? json.result[0] : json?.result;
      const fileCode = entry?.filecode || entry?.file_code;
      if (json?.status === 200 && fileCode) return { fileCode };
      throw new Error(json?.msg || 'فشل رفع Doodstream');
    },
  },
  earnvid: {
    serverEndpoint: (key) => `https://earnvidsapi.com/api/upload/server?key=${encodeURIComponent(key)}`,
    fileField: 'key',
    embedUrl: (fileCode) => `https://xvs.tt/${fileCode}.html`,
    parse: (json) => {
      const entry = Array.isArray(json?.files) ? json.files[0] : (Array.isArray(json?.result) ? json.result[0] : json?.result);
      const fileCode = entry?.filecode || entry?.file_code;
      if (json?.status === 200 && fileCode) return { fileCode };
      throw new Error(json?.msg || 'فشل رفع EarnVid');
    },
  },
  voe: {
    serverEndpoint: (key) => `https://voe.sx/api/upload/server?key=${encodeURIComponent(key)}`,
    fileField: 'key',
    embedUrl: (fileCode) => `https://voe.sx/e/${fileCode}`,
    // Voe is documented (anime-hosts.mjs) as the same whitelabel API family
    // as Doodstream for its remote-upload-by-url endpoint (object-shaped
    // result with file_code); the direct binary-upload response shape for
    // this specific endpoint isn't separately doc-confirmed, so this parses
    // defensively across every shape the sibling hosts use (array/object,
    // filecode/file_code) instead of assuming one.
    parse: (json) => {
      const candidates = [
        json?.result,
        Array.isArray(json?.result) ? json.result[0] : null,
        json?.files?.[0],
        json,
      ].filter(Boolean);
      for (const c of candidates) {
        const fileCode = c?.filecode || c?.file_code;
        if (fileCode) return { fileCode };
      }
      throw new Error(json?.msg || json?.message || 'فشل رفع Voe');
    },
  },
};

const HOST_KEYS = ['earnvid', 'doodstream', 'voe'];

// `uploadConfig` ({ uploadUrl, fieldName, apiKey }) is resolved fresh, per
// upload, from the website's own `/host-upload/direct-init` endpoint (see
// site.js's getDirectUploadConfig) - the app never stores host API keys
// itself, the server hands back a short-lived upload URL + the real key
// every time (owner decision 2026-11-15).
async function uploadFile(host, filePath, uploadConfig, onProgress) {
  const cfg = PROVIDERS[host];
  if (!cfg) throw new Error(`استضافة غير معروفة: ${host}`);
  const { uploadUrl, fieldName, apiKey } = uploadConfig || {};
  if (!uploadUrl || !apiKey) throw new Error(`تعذر الحصول على رابط رفع ${host} من السيرفر`);

  const stat = fs.statSync(filePath);
  const form = new FormData();
  form.append(fieldName || cfg.fileField, apiKey);
  form.append('file', fs.createReadStream(filePath), { knownLength: stat.size });

  const totalLength = await new Promise((resolve, reject) => {
    form.getLength((err, length) => (err ? reject(err) : resolve(length)));
  });

  // Explicit Content-Length (not chunked transfer-encoding) - several of
  // these upload servers reject/hang on chunked bodies, and axios can't
  // report upload progress without a known total either.
  const headers = { ...form.getHeaders(), 'Content-Length': totalLength };

  let lastSampleTime = Date.now();
  let lastSampleLoaded = 0;
  let lastRateBytesPerSec = 0;

  const uploadRes = await axios.post(uploadUrl, form, {
    headers,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 0,
    onUploadProgress: (progressEvent) => {
      const loaded = progressEvent.loaded || 0;
      const total = progressEvent.total || totalLength || stat.size;
      const pct = total ? Math.min(99, Math.round((loaded / total) * 100)) : 0;
      const now = Date.now();
      const elapsedSec = (now - lastSampleTime) / 1000;
      if (elapsedSec >= 0.25) {
        const bytesSinceLast = loaded - lastSampleLoaded;
        lastRateBytesPerSec = elapsedSec > 0 ? bytesSinceLast / elapsedSec : 0;
        lastSampleTime = now;
        lastSampleLoaded = loaded;
      }
      onProgress && onProgress({ pct, loaded, total, bytesPerSec: Math.max(0, lastRateBytesPerSec) });
    },
  });

  const { fileCode } = cfg.parse(uploadRes.data);
  onProgress && onProgress({ pct: 100, loaded: stat.size, total: stat.size, bytesPerSec: 0 });
  return { fileCode, embedUrl: cfg.embedUrl(fileCode) };
}

module.exports = { uploadFile, HOST_KEYS, PROVIDERS };
