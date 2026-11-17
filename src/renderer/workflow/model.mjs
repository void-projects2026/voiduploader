// Pure view-model for the workflow diagram: turns a persisted job/host record into what the UI shows.
// Rule: never show a number that was not measured. Percentages exist only for (a) bytes sent and (b) a percentage the
// host's own API reported (EarnVid encodings). Everything else is a label.

export const HOST_META = {
  earnvid: { label: 'EarnVid', tone: '#22c55e', mark: 'EV' },
  doodstream: { label: 'Doodstream', tone: '#f59e0b', mark: 'DS' },
  voe: { label: 'VOE', tone: '#38bdf8', mark: 'VOE' },
};

export const ERR_AR = {
  connection: 'تعذر الاتصال بسيرفر الرفع',
  timeout: 'انتهت مهلة الاتصال بسيرفر الرفع',
  stalled: 'توقف الرفع (لا بيانات منذ دقيقة)',
  http4xx: 'رفض المضيف الطلب',
  http5xx: 'خطأ في سيرفر المضيف',
  auth: 'مفتاح الـ API غير صالح أو مرفوض',
  quota: 'امتلأت المساحة أو تجاوزت الحد المسموح',
  rejected: 'المضيف رفض الملف (صيغة أو حجم غير مقبول)',
  cancelled: 'أُلغيت العملية',
  unknown: 'فشل الرفع لسبب غير معروف',
};

// phase: waiting | sending | stalled | retrying | processing | done | error
export function hostView(h, job = {}) {
  const speed = h.bytesPerSec || 0;
  const relay = job.viaServer ? (job.relay || {}) : null;
  const base = { host: h.host, speed, pct: null, step: 0, tip: null, link: h.embedUrl || null, code: h.fileCode || null };
  if (h.status === 'error') {
    return { ...base, phase: 'error', step: h.stage === 'processing' ? 1 : 0, label: h.error || ERR_AR[h.errClass] || ERR_AR.unknown, tip: h.detail || null, errClass: h.errClass || 'unknown', cancelled: h.errClass === 'cancelled' };
  }
  if (h.status === 'done') {
    const ind = h.processing && h.processing.indeterminate;
    return { ...base, phase: 'done', step: 2, pct: 100, label: ind ? 'تم الرفع (الاستضافة لا تُظهر حالة المعالجة)' : 'تم', tip: h.processing && h.processing.note };
  }
  if (h.status === 'processing') {
    const p = h.processing || {};
    if (typeof p.pct === 'number') return { ...base, phase: 'processing', step: 1, pct: p.pct, label: `معالجة ${p.pct}%`, tip: p.minPct != null ? `أقل جودة: ${p.minPct}% (${p.qualities || 1} جودة)` : null };
    return { ...base, phase: 'processing', step: 1, pct: null, label: p.state === 'unknown' ? 'معالجة (الاستضافة لا تُظهر نسبة)' : 'معالجة (بانتظار الاستضافة)' };
  }
  if (h.status === 'uploading') {
    if (h.stage === 'relay-queue') {
      const sending = relay && relay.stage === 'sending';
      return { ...base, phase: 'waiting', label: sending ? 'بانتظار وصول الملف للسيرفر' : 'السيرفر يجهّز الملف للرفع' };
    }
    if (h.note) return { ...base, phase: 'retrying', label: h.note, tip: h.detail || null, pct: null, errClass: h.errClass };
    const pct = Math.max(0, Math.min(100, h.progress || 0));
    if (h.stalled) return { ...base, phase: 'stalled', pct, label: `إرسال ${pct}% - توقف مؤقت`, speed: 0 };
    return { ...base, phase: 'sending', pct, label: `إرسال ${pct}%` };
  }
  return { ...base, phase: 'waiting', label: 'في الانتظار' };
}

// Travelling-balls parameters from the REAL bytes/second. 0 balls when nothing moves.
export function flowParams(bytesPerSec, moving = true) {
  if (!moving || !bytesPerSec || bytesPerSec < 1) return { balls: 0, dur: 0 };
  const b = bytesPerSec;
  if (b < 256 * 1024) return { balls: 2, dur: 5 };
  if (b < 1024 * 1024) return { balls: 3, dur: 3.6 };
  if (b < 4 * 1024 * 1024) return { balls: 4, dur: 2.6 };
  if (b < 12 * 1024 * 1024) return { balls: 5, dur: 1.9 };
  return { balls: 7, dur: 1.3 };
}

export function jobSummary(job) {
  const views = job.hosts.map((h) => hostView(h, job));
  const active = views.some((v) => ['waiting', 'sending', 'stalled', 'retrying', 'processing'].includes(v.phase));
  const failed = views.some((v) => v.phase === 'error');
  const sendingPcts = views.map((v) => (v.phase === 'done' || v.phase === 'processing' ? 100 : v.phase === 'error' ? 0 : v.pct || 0));
  const overall = Math.round(sendingPcts.reduce((a, b) => a + b, 0) / Math.max(1, views.length));
  return { views, active, failed, overall, done: views.every((v) => v.phase === 'done') };
}

// The leg computer -> our server (only when job.viaServer)
export function relayView(job) {
  const r = job.relay || {};
  if (r.stage === 'error') return { phase: 'error', label: r.error || 'فشل الرفع إلى السيرفر', pct: null };
  if (r.stage === 'cancelled') return { phase: 'error', label: 'أُلغيت العملية', pct: null };
  if (r.stage === 'sending') {
    if (r.note) return { phase: 'retrying', label: r.note, pct: r.pct, tip: r.detail };
    return { phase: r.bytesPerSec > 0 ? 'sending' : 'waiting', pct: r.pct || 0, label: r.chunks ? `إلى السيرفر ${r.pct || 0}% (جزء ${Math.min(r.chunk + 1, r.chunks)}/${r.chunks})${r.resumed ? ' - استئناف' : ''}` : 'جارِ التجهيز...', speed: r.bytesPerSec || 0 };
  }
  if (r.stage === 'assembling') return { phase: 'processing', pct: null, label: 'السيرفر يجمّع الأجزاء' };
  if (r.stage === 'server' || r.stage === 'finished') return { phase: 'done', pct: 100, label: 'وصل الملف للسيرفر' };
  return { phase: 'waiting', pct: null, label: 'في الانتظار' };
}
