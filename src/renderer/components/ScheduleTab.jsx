import React, { useEffect, useMemo, useState } from 'react';
import { Plus, RefreshCw, Loader2, Play, Square, Trash2, CalendarClock, ChevronDown, ChevronUp, CheckCircle2 } from 'lucide-react';
import { useToast } from '../context/ToastContext.jsx';
import { useSchedule } from '../context/ScheduleContext.jsx';
import { fmtBytes, fmtSpeed, compressRanges } from '../format.js';
import CreateTaskModal from './CreateTaskModal.jsx';

const HOST_LABEL = { earnvid: 'EarnVid', doodstream: 'Doodstream', voe: 'Voe' };
const STATUS = {
  draft: ['محفوظة', 'badge-pending'],
  scheduled: ['مجدولة', 'badge-pending'],
  queued: ['في الانتظار', 'badge-pending'],
  running: ['شغالة', 'badge-uploading'],
  stopping: ['جارِ الإيقاف', 'badge-pending'],
  waiting_decision: ['تنتظر قرارك', 'badge-error'],
  done: ['انتهت', 'badge-done'],
  stopped: ['متوقفة', 'badge-pending'],
  error: ['خطأ', 'badge-error'],
};
const ACTIVE = new Set(['running', 'stopping', 'waiting_decision']);
const EP_COLOR = { pending: 'border-border text-zinc-500', running: 'border-accent text-white', done: 'border-emerald-500/50 text-emerald-300', partial: 'border-amber-500/50 text-amber-300', skipped: 'border-border text-zinc-400', failed: 'border-rose-500/50 text-rose-300' };
const PHASE = { checking: 'فحص الموقع', resolving: 'البحث في المصدر الاحتياطي', downloading: 'تحميل', uploading: 'رفع', pausing: 'استراحة بين الحلقات' };

function counts(task) {
  const all = task.items.flatMap((it) => Object.values(it.results));
  const settled = all.filter((r) => ['done', 'partial', 'skipped'].includes(r.state)).length;
  return { total: all.length, settled, failed: all.filter((r) => r.state === 'failed').length };
}

function CurrentLine({ task }) {
  const c = task.current;
  if (!c) return null;
  return (
    <div className="text-[11px] text-zinc-400 mt-2 space-y-1">
      <div>
        <b className="text-zinc-200">{c.title}</b> — حلقة {c.ep}: {PHASE[c.phase] || c.phase}{c.provider ? ` (${c.provider})` : ''}
      </div>
      {c.phase === 'downloading' && c.dl && (
        <div className="flex items-center gap-2" dir="ltr">
          <div className="flex-1 h-1.5 rounded bg-panel overflow-hidden">
            {c.dl.total ? <div className="h-full bg-accent" style={{ width: `${Math.min(100, (c.dl.done / c.dl.total) * 100)}%` }} /> : <div className="h-full w-1/3 bg-accent animate-pulse rounded" />}
          </div>
          <span className="tabular-nums">{fmtBytes(c.dl.done)}{c.dl.total ? ` / ${fmtBytes(c.dl.total)}` : ''}{c.dl.speed > 0 ? ` • ${fmtSpeed(c.dl.speed)}` : ''}</span>
        </div>
      )}
      {c.phase === 'uploading' && (c.hosts || []).length > 0 && (
        <div className="flex gap-3 flex-wrap">
          {c.hosts.map((h) => <span key={h.host}>{HOST_LABEL[h.host]}: {h.status === 'done' ? '✓' : h.status === 'error' ? '✗' : `${h.progress || 0}%`}</span>)}
        </div>
      )}
    </div>
  );
}

function TaskReview({ task }) {
  const editable = !ACTIVE.has(task.status);
  const o = task.options;
  const upd = (patch) => window.api.schedUpdate({ id: task.id, options: patch });
  return (
    <div className="mt-3 pt-3 border-t border-border space-y-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-zinc-300">
        <label className="flex items-center gap-1.5"><input type="checkbox" disabled={!editable} checked={o.skipOnFail} onChange={(e) => upd({ skipOnFail: e.target.checked })} /> تخطي الفشل الجزئي</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" disabled={!editable} checked={o.deleteEnabled} onChange={(e) => upd({ deleteEnabled: e.target.checked })} /> مسح تلقائي بعد
          <input type="number" min="1" max="3" disabled={!editable || !o.deleteEnabled} className="input !w-14 !py-0.5 text-xs" value={o.deleteAfterHosts} onChange={(e) => upd({ deleteAfterHosts: Number(e.target.value) })} /> استضافة
        </label>
        <label className="flex items-center gap-1.5">استراحة
          <input type="number" min="0" disabled={!editable} className="input !w-16 !py-0.5 text-xs" value={o.pauseSec} onChange={(e) => upd({ pauseSec: Number(e.target.value) })} /> ثانية
        </label>
        <span className="text-zinc-500">المصدر: {o.sources.join(' ← ')}</span>
      </div>

      {task.items.map((it) => (
        <div key={it.id}>
          <div className="text-xs text-zinc-200 mb-1">{it.workTitle} <span className="text-zinc-500">({it.provider} • {it.quality})</span></div>
          <div className="flex flex-wrap gap-1">
            {it.episodes.map((e) => {
              const r = it.results[e.display];
              return <span key={e.display} title={r.message || r.state} className={`min-w-[2rem] text-center px-1.5 py-0.5 rounded border text-[11px] ${EP_COLOR[r.state]}`}>{e.display}</span>;
            })}
          </div>
        </div>
      ))}

      {task.log.length > 0 && (
        <div className="max-h-40 overflow-y-auto bg-panel rounded-lg p-2 text-[11px] leading-5 font-mono" dir="auto">
          {[...task.log].reverse().slice(0, 40).map((l, i) => (
            <div key={i} className={l.level === 'error' ? 'text-rose-300' : l.level === 'warn' ? 'text-amber-300' : l.level === 'ok' ? 'text-emerald-300' : 'text-zinc-400'}>
              <span className="text-zinc-600">{new Date(l.t).toLocaleTimeString('ar-EG')}</span> {l.msg}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaskCard({ task }) {
  const { push, confirm } = useToast();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [at, setAt] = useState('');
  const [label, cls] = STATUS[task.status] || [task.status, 'badge-pending'];
  const c = counts(task);
  const active = ACTIVE.has(task.status);

  const start = async () => { const r = await window.api.schedStart(task.id); if (!r.success) push(r.error || 'تعذر التشغيل', 'error'); };
  const schedule = async () => {
    const r = await window.api.schedSchedule({ id: task.id, startAt: new Date(at).toISOString() });
    if (!r.success) return push(r.error || 'تعذرت الجدولة', 'error');
    setPicking(false);
  };
  const del = async () => {
    if (!(await confirm(`حذف المهمة «${task.name}»؟`, { yes: 'حذف', no: 'إلغاء' }))) return;
    const r = await window.api.schedDelete(task.id);
    if (!r.success) push(r.error || 'تعذر الحذف', 'error');
  };

  return (
    <div className="card p-4 mb-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-bold text-white truncate">{task.name}</span>
            <span className={`badge ${cls}`}>{label}</span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            {task.items.length} عمل • {c.settled}/{c.total} حلقة{c.failed ? ` • ${c.failed} فاشلة` : ''}
            {task.status === 'scheduled' && task.startAt && ` • تبدأ ${new Date(task.startAt).toLocaleString('ar-EG')}`}
            {task.note && ` • ${task.note}`}{task.error && ` • ${task.error}`}
          </div>
        </div>
        {!active && task.status !== 'queued' && <button onClick={start} className="btn btn-primary !py-1 text-xs"><Play className="w-3.5 h-3.5" /> {task.status === 'done' && !c.failed ? 'إعادة' : 'تشغيل'}</button>}
        {!active && <button onClick={() => setPicking((v) => !v)} className="btn btn-secondary !py-1 text-xs"><CalendarClock className="w-3.5 h-3.5" /> جدولة</button>}
        {(active || task.status === 'queued' || task.status === 'scheduled') && <button onClick={() => window.api.schedStop(task.id)} className="btn btn-danger !py-1 text-xs"><Square className="w-3.5 h-3.5" /> إيقاف</button>}
        <button onClick={() => setOpen((v) => !v)} className="btn btn-secondary !py-1 text-xs">مراجعة {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}</button>
        {!active && <button onClick={del} className="text-zinc-500 hover:text-rose-400"><Trash2 className="w-4 h-4" /></button>}
      </div>

      {c.total > 0 && <div className="h-1 rounded bg-panel overflow-hidden mt-3"><div className="h-full bg-emerald-500" style={{ width: `${(c.settled / c.total) * 100}%` }} /></div>}
      <CurrentLine task={task} />

      {picking && (
        <div className="mt-3 flex items-center gap-2">
          <input type="datetime-local" className="input !w-56 !py-1.5" value={at} onChange={(e) => setAt(e.target.value)} />
          <button onClick={schedule} disabled={!at} className="btn btn-primary !py-1.5 text-xs">تأكيد</button>
        </div>
      )}
      {open && <TaskReview task={task} />}
    </div>
  );
}

function MissingWorks({ onCreate }) {
  const { works, worksLoading, worksError, refreshWorks } = useSchedule();
  const [filter, setFilter] = useState('');
  const [showComplete, setShowComplete] = useState(false);

  useEffect(() => { if (!works) refreshWorks(); }, [works, refreshWorks]);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (works || []).filter((w) => (showComplete || w.missing.length) && (!q || `${w.title} ${w.titleEn}`.toLowerCase().includes(q)));
  }, [works, filter, showComplete]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-3 flex-wrap">
        <h3 className="text-sm font-bold text-white">أعمال الموقع والحلقات الناقصة</h3>
        <input className="input !w-48 !py-1.5 text-xs" placeholder="بحث..." value={filter} onChange={(e) => setFilter(e.target.value)} />
        <label className="flex items-center gap-1.5 text-[11px] text-zinc-400"><input type="checkbox" checked={showComplete} onChange={(e) => setShowComplete(e.target.checked)} /> إظهار المكتملة</label>
        <button onClick={refreshWorks} disabled={worksLoading} className="ms-auto text-[11px] text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1">
          {worksLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} تحديث
        </button>
      </div>
      {worksError && <div className="text-xs text-rose-400 mb-2">{worksError}</div>}
      {worksLoading && !works && <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />}
      <p className="text-[11px] text-zinc-600 mb-2">«ناقصة» = الحلقة ليس عليها الـ3 سيرفرات (EarnVid + Doodstream + Voe).</p>
      <div className="space-y-1.5">
        {works && rows.length === 0 && <div className="card p-6 text-center text-sm text-zinc-500">لا توجد أعمال ناقصة 🎉</div>}
        {rows.map((w) => (
          <div key={w.id} className="card p-3 flex items-center gap-3">
            <img src={w.coverUrl} alt="" className="w-9 h-12 rounded-md object-cover bg-panel shrink-0" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-zinc-100 truncate">{w.title}</div>
              {w.missing.length ? (
                <div className="text-[11px] text-amber-300 truncate" title={w.missing.map((m) => `حلقة ${m.n}: ينقص ${m.lacking.map((h) => HOST_LABEL[h]).join('، ')}`).join('\n')}>
                  ناقص ({w.missing.length}/{w.total}): {compressRanges(w.missing.map((m) => m.n))}
                </div>
              ) : (
                <div className="text-[11px] text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> مكتمل ({w.total})</div>
              )}
            </div>
            <button onClick={() => onCreate(w)} className="btn btn-secondary !py-1 text-xs"><Plus className="w-3.5 h-3.5" /> مهمة</button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ScheduleTab() {
  const { tasks } = useSchedule();
  const [modal, setModal] = useState(null); // { work? }

  return (
    <div className="max-w-3xl">
      <div className="flex items-center mb-5">
        <h2 className="text-lg font-bold text-white">الجدول</h2>
        <button onClick={() => setModal({})} className="btn btn-primary ms-auto"><Plus className="w-4 h-4" /> مهمة جديدة</button>
      </div>

      {tasks.length > 0 && (
        <div className="mb-8">
          <h3 className="text-sm font-bold text-white mb-3">المهام</h3>
          {tasks.map((t) => <TaskCard key={t.id} task={t} />)}
        </div>
      )}

      <MissingWorks onCreate={(w) => setModal({ work: w })} />
      {modal && <CreateTaskModal initialWork={modal.work} onClose={() => setModal(null)} />}
    </div>
  );
}
