'use strict';

// Error classification shared by the upload engine and the UI. Every failure is mapped to a class + a short
// readable Arabic text; the technical detail is kept separately for the tooltip. Secrets never appear here:
// redact() strips anything that looks like an api key / token from messages.

const CONNECT_CODES = new Set(['ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNABORTED', 'EPIPE', 'ECONNCONNECT_TIMEOUT']);
const MAX_SERVER_TRIES = 6;

function errCode(err) {
  return (err && (err.code || (err.cause && err.cause.code))) || null;
}

function isConnectError(err) {
  return CONNECT_CODES.has(errCode(err));
}

function redact(text, secrets = []) {
  let s = String(text == null ? '' : text);
  for (const sec of secrets) if (sec && String(sec).length >= 6) s = s.split(String(sec)).join('***');
  // generic: key=... / api_key=... query params and long hex-ish tokens after '?'
  s = s.replace(/([?&](?:key|api_key|apikey|token)=)[^&\s"']+/gi, '$1***');
  s = s.replace(/(\/upload\/\d+\?)[A-Za-z0-9_-]{8,}/g, '$1***');
  return s;
}

// Classes: connection, timeout, stalled, http4xx, http5xx, auth (invalid key), quota, rejected, cancelled, unknown
function classifyError(err, secrets) {
  if (err && err.errClass) {
    return { cls: err.errClass, ar: arabicFor(err.errClass, err), detail: redact(err.detail || err.message, secrets) };
  }
  const code = errCode(err);
  const msg = String((err && err.message) || err || '');
  const status = err && (err.httpStatus || (err.response && err.response.status));
  let cls = 'unknown';
  if (err && err.cancelled) cls = 'cancelled';
  else if (code === 'ESTALLED') cls = 'stalled';
  else if (code === 'ECONNECT_TIMEOUT' || code === 'ETIMEDOUT' || code === 'ECONNABORTED' || /timeout|timed out/i.test(msg)) cls = code === 'ETIMEDOUT' ? 'connection' : 'timeout';
  else if (CONNECT_CODES.has(code)) cls = 'connection';
  else if (status === 401 || status === 403 || /invalid key|wrong key|api key|key is invalid|unauthor/i.test(msg)) cls = 'auth';
  else if (status === 507 || status === 413 || /quota|storage|disk|space|limit reached|no space/i.test(msg)) cls = 'quota';
  else if (status === 415 || status === 422 || /not a video|invalid file|unsupported|rejected|extension/i.test(msg)) cls = 'rejected';
  else if (status === 429) cls = 'http4xx';
  else if (status >= 500) cls = 'http5xx';
  else if (status >= 400) cls = 'http4xx';
  return { cls, ar: arabicFor(cls, err), detail: redact(msg, secrets) };
}

function arabicFor(cls, err) {
  switch (cls) {
    case 'connection': return 'تعذر الاتصال بسيرفر الرفع';
    case 'timeout': return 'انتهت مهلة الاتصال بسيرفر الرفع';
    case 'stalled': return 'توقف الرفع (لا بيانات منذ دقيقة)';
    case 'http4xx': return `رفض المضيف الطلب${err && err.httpStatus ? ` (${err.httpStatus})` : ''}`;
    case 'http5xx': return `خطأ في سيرفر المضيف${err && err.httpStatus ? ` (${err.httpStatus})` : ''}`;
    case 'auth': return 'مفتاح الـ API غير صالح أو مرفوض';
    case 'quota': return 'امتلأت المساحة أو تجاوزت الحد المسموح';
    case 'rejected': return 'المضيف رفض الملف (صيغة أو حجم غير مقبول)';
    case 'cancelled': return 'أُلغيت العملية';
    default: return 'فشل الرفع لسبب غير معروف';
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { CONNECT_CODES, MAX_SERVER_TRIES, errCode, isConnectError, redact, classifyError, arabicFor, sleep };
