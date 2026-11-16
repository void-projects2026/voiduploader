import React from 'react';
import { RotateCw, Copy, AlertTriangle } from 'lucide-react';
import { useOps } from '../context/OpsContext.jsx';
import { useToast } from '../context/ToastContext.jsx';

const HOST_LABEL = { earnvid: 'EarnVid', doodstream: 'Doodstream', voe: 'Voe' };
const BADGE_CLASS = { pending: 'badge-pending', waiting: 'badge-pending', uploading: 'badge-uploading', done: 'badge-done', error: 'badge-error' };

function HostRow({ job, h }) {
  const { retryHost } = useOps();
  const { push } = useToast();
  return (
    <div className="flex items-center gap-2.5 py-1">
      <span className="w-20 text-xs text-zinc-400 shrink-0">{HOST_LABEL[h.host] || h.host}</span>
      <span className={`badge ${BADGE_CLASS[h.status] || 'badge-pending'} w-24 justify-center`}>{h.status}</span>
      <div className="flex-1 h-1.5 bg-border rounded-full overflow-hidden">
        <div className="h-full bg-accent transition-all" style={{ width: `${h.progress || 0}%` }} />
      </div>
      <span className="text-[11px] text-zinc-500 w-10 text-left">{h.progress || 0}%</span>
      {h.status === 'done' && h.embedUrl && (
        <button onClick={() => { navigator.clipboard.writeText(h.embedUrl); push('تم نسخ الرابط', 'success'); }} className="text-zinc-500 hover:text-zinc-200">
          <Copy className="w-3.5 h-3.5" />
        </button>
      )}
      {h.status === 'error' && (
        <>
          <span title={h.error} className="text-rose-400"><AlertTriangle className="w-3.5 h-3.5" /></span>
          <button onClick={() => retryHost(job.id, h.host)} className="text-accent hover:text-blue-400"><RotateCw className="w-3.5 h-3.5" /></button>
        </>
      )}
    </div>
  );
}

export default function OpsTab() {
  const { jobs } = useOps();
  return (
    <div className="max-w-4xl">
      <h2 className="text-lg font-bold text-white mb-5">العمليات</h2>
      {jobs.length === 0 && <p className="text-sm text-zinc-500">لا توجد عمليات رفع بعد.</p>}
      <div className="space-y-3">
        {jobs.map((job) => (
          <div key={job.id} className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm font-semibold text-white">{job.animeTitle || job.animeId} <span className="text-zinc-500">· حلقة {job.episodeNumber}</span></div>
              <div className="text-[11px] text-zinc-500 truncate max-w-[220px]">{job.fileName}</div>
            </div>
            <div className="space-y-1.5">
              {job.hosts.map((h) => <HostRow key={h.host} job={job} h={h} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
