import React, { useMemo, useState } from 'react';
import { RotateCw, Copy, AlertTriangle, ExternalLink, Search, TrendingUp } from 'lucide-react';
import { useOps } from '../context/OpsContext.jsx';
import { useToast } from '../context/ToastContext.jsx';

const HOST_LABEL = { earnvid: 'EarnVid', doodstream: 'Doodstream', voe: 'Voe' };
const BADGE_CLASS = { pending: 'badge-pending', waiting: 'badge-pending', uploading: 'badge-uploading', processing: 'badge-uploading', done: 'badge-done', error: 'badge-error' };
const STATUS_AR = { pending: 'بانتظار', waiting: 'بانتظار', uploading: 'إرسال', processing: 'معالجة', done: 'تم', error: 'فشل' };
const STATUS_FILTERS = [
  { id: 'all', label: 'الكل' },
  { id: 'uploading', label: 'جارِ الرفع' },
  { id: 'done', label: 'ناجحة' },
  { id: 'error', label: 'فاشلة' },
];

function jobOverallStatus(job) {
  if (job.hosts.some((h) => h.status === 'error')) return 'error';
  if (job.hosts.some((h) => h.status === 'uploading' || h.status === 'waiting' || h.status === 'processing')) return 'uploading';
  if (job.hosts.every((h) => h.status === 'done')) return 'done';
  return 'pending';
}

function StatsBar({ jobs }) {
  const stats = useMemo(() => {
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const thisWeek = jobs.filter((j) => new Date(j.createdAt).getTime() >= weekAgo);
    const perHost = {};
    for (const host of Object.keys(HOST_LABEL)) {
      let done = 0;
      let total = 0;
      for (const j of jobs) {
        const h = j.hosts.find((x) => x.host === host);
        if (!h || h.status === 'pending' || h.status === 'waiting' || h.status === 'uploading' || h.status === 'processing') continue;
        total += 1;
        if (h.status === 'done') done += 1;
      }
      perHost[host] = total ? Math.round((done / total) * 100) : null;
    }
    return { weekCount: thisWeek.length, perHost };
  }, [jobs]);

  return (
    <div className="card p-4 mb-5 flex items-center gap-6 flex-wrap">
      <div className="flex items-center gap-2">
        <TrendingUp className="w-4 h-4 text-accent" />
        <span className="text-sm text-zinc-300">هذا الأسبوع: <b className="text-white">{stats.weekCount}</b> حلقة</span>
      </div>
      {Object.entries(stats.perHost).map(([host, pct]) => (
        <div key={host} className="text-sm text-zinc-300">
          {HOST_LABEL[host]}: <b className={pct == null ? 'text-zinc-500' : pct >= 80 ? 'text-emerald-400' : pct >= 50 ? 'text-amber-400' : 'text-rose-400'}>{pct == null ? '--' : `${pct}%`}</b>
        </div>
      ))}
    </div>
  );
}

function HostRow({ job, h }) {
  const { retryHost } = useOps();
  const { push } = useToast();
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span className="w-20 text-xs text-zinc-400 shrink-0">{HOST_LABEL[h.host] || h.host}</span>
      <span className={`badge ${BADGE_CLASS[h.status] || 'badge-pending'} w-24 justify-center`}>{STATUS_AR[h.status] || h.status}</span>
      <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
        <div className="h-full bg-accent transition-all" style={{ width: `${h.progress || 0}%` }} />
      </div>
      <span className="text-[11px] text-zinc-500 w-10 text-left">{h.status === 'processing' ? (h.processing && typeof h.processing.pct === 'number' ? `${h.processing.pct}%` : '...') : `${h.progress || 0}%`}</span>
      {(h.status === 'done' || h.status === 'processing') && h.embedUrl && (
        <button onClick={() => { navigator.clipboard.writeText(h.embedUrl); push('تم نسخ الرابط', 'success'); }} className="text-zinc-500 hover:text-zinc-200" title="نسخ رابط التضمين">
          <Copy className="w-3.5 h-3.5" />
        </button>
      )}
      {h.status === 'error' && (
        <>
          <span title={[h.error, h.detail].filter(Boolean).join(' - ')} className="text-rose-400"><AlertTriangle className="w-3.5 h-3.5" /></span>
          <button onClick={() => retryHost(job.id, h.host)} className="text-accent hover:text-blue-400" title="إعادة المحاولة"><RotateCw className="w-3.5 h-3.5" /></button>
        </>
      )}
    </div>
  );
}

export default function OpsTab() {
  const { jobs } = useOps();
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const filtered = jobs.filter((job) => {
    if (statusFilter !== 'all' && jobOverallStatus(job) !== statusFilter) return false;
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      const haystack = `${job.animeTitle || job.animeId} ${job.episodeNumber} ${job.fileName}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="max-w-4xl">
      <h2 className="text-lg font-bold text-white mb-5">سجل العمليات</h2>

      {jobs.length > 0 && <StatsBar jobs={jobs} />}

      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-zinc-500 absolute right-3 top-1/2 -translate-y-1/2" />
          <input className="input !pr-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="بحث بالعمل أو رقم الحلقة أو اسم الملف..." />
        </div>
        <div className="flex gap-1.5 shrink-0">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id)}
              className={`px-3 py-1.5 rounded-lg text-xs transition-colors ${statusFilter === f.id ? 'bg-accent text-white' : 'bg-panel text-zinc-400 hover:text-zinc-200'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {jobs.length === 0 && <p className="text-sm text-zinc-500">لا توجد عمليات رفع بعد.</p>}
      {jobs.length > 0 && filtered.length === 0 && <p className="text-sm text-zinc-500">لا توجد نتائج مطابقة.</p>}

      <div className="space-y-3">
        {filtered.map((job) => {
          const allDone = job.hosts.every((h) => h.status === 'done');
          return (
            <div key={job.id} className="card p-4">
              <div className="flex items-center justify-between mb-3">
                <div className="text-sm font-semibold text-white flex items-center gap-2">
                  {job.animeTitle || job.animeId} <span className="text-zinc-500">· حلقة {job.episodeNumber}</span>
                  {allDone && (
                    <button
                      onClick={() => window.api.openEpisodeOnSite({ animeId: job.animeId, episodeNumber: job.episodeNumber })}
                      className="text-accent hover:text-blue-400"
                      title="فتح الحلقة على الموقع"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="text-[11px] text-zinc-500 truncate max-w-[220px]">{job.fileName}</div>
              </div>
              <div className="space-y-1.5">
                {job.hosts.map((h) => <HostRow key={h.host} job={job} h={h} />)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
