import React, { useEffect, useMemo, useState } from 'react';
import { Check, Copy, RotateCw, X, Monitor, Server, Workflow, ExternalLink } from 'lucide-react';
import { useOps } from '../context/OpsContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { fmtBytes, fmtSpeed } from '../format.js';
import { HOST_META, hostView, relayView, flowParams, jobSummary } from '../workflow/model.mjs';

// ---------------------------------------------------------------------------
// Geometry. Everything is laid out in one 800 x H coordinate space: the SVG paths and the HTML chips are positioned
// from the same numbers (chips use percentages of the same box), so they always line up at any window width.
// ---------------------------------------------------------------------------
const W = 800;
const HOST_X = [130, 400, 670];
const HOST_BOTTOM = 122; // host cards are anchored here (they grow upward), so a path always touches its card

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    if (!window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const on = () => setReduced(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

const bez = (x0, y0, x1, y1, t) => {
  const ym = (y0 + y1) / 2;
  const mt = 1 - t;
  return { x: mt ** 3 * x0 + 3 * mt * mt * t * x0 + 3 * mt * t * t * x1 + t ** 3 * x1, y: mt ** 3 * y0 + 3 * mt * mt * t * ym + 3 * mt * t * t * ym + t ** 3 * y1 };
};
const pathD = (x0, y0, x1, y1) => { const ym = (y0 + y1) / 2; return `M ${x0} ${y0} C ${x0} ${ym}, ${x1} ${ym}, ${x1} ${y1}`; };

const TONE = { idle: '#2a3142', waiting: '#3a4357', sending: '#3b82f6', stalled: '#f59e0b', retrying: '#f59e0b', processing: '#a78bfa', done: '#34d399', error: '#f43f5e' };

// ---------------------------------------------------------------------------
// A path between two nodes: dashed flow + travelling balls (density/speed from real bytes/s) + state colours.
// ---------------------------------------------------------------------------
function FlowPath({ id, d, phase, speed, reduced }) {
  const color = TONE[phase] || TONE.idle;
  const { balls, dur } = flowParams(speed, phase === 'sending');
  const moving = phase === 'sending' && !reduced;
  const cls = `wf-path wf-${phase}`;
  return (
    <g>
      <path d={d} fill="none" stroke="#1a2030" strokeWidth="7" strokeLinecap="round" />
      <path id={id} d={d} fill="none" stroke={color} strokeWidth={phase === 'done' ? 3.5 : 3} strokeLinecap="round" className={cls}
        strokeDasharray={phase === 'sending' || phase === 'retrying' ? '2 9' : phase === 'processing' ? '10 8' : phase === 'waiting' ? '3 8' : undefined}
        opacity={phase === 'idle' ? 0.55 : 1} />
      {moving && Array.from({ length: balls }).map((_, i) => (
        <circle key={`${balls}-${dur}-${i}`} r="5" fill={color} filter="url(#wfGlow)">
          <animateMotion dur={`${dur}s`} begin={`${-(dur / balls) * i}s`} repeatCount="indefinite" keyPoints="1;0" keyTimes="0;1" calcMode="linear">
            <mpath href={`#${id}`} />
          </animateMotion>
        </circle>
      ))}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------
function HostBadge({ host, size = 38 }) {
  const m = HOST_META[host] || { mark: '?', tone: '#64748b' };
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <defs>
        <linearGradient id={`g-${host}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor={m.tone} stopOpacity="0.95" />
          <stop offset="1" stopColor={m.tone} stopOpacity="0.55" />
        </linearGradient>
      </defs>
      <rect x="1" y="1" width="38" height="38" rx="11" fill={`url(#g-${host})`} />
      <path d="M15 12.5 L28 20 L15 27.5 Z" fill="#0b0e14" opacity="0.18" />
      <text x="20" y="25" textAnchor="middle" fontSize={m.mark.length > 2 ? 12 : 15} fontWeight="800" fill="#08101a" fontFamily="Segoe UI, Arial, sans-serif">{m.mark}</text>
    </svg>
  );
}

const STEPS = ['إرسال', 'معالجة', 'تم'];
function Steps({ step, phase }) {
  return (
    <div className="flex items-center gap-1 text-[10px]" dir="rtl">
      {STEPS.map((s, i) => {
        const on = i === step;
        const past = i < step || (phase === 'done' && i <= step);
        const color = phase === 'error' && on ? 'text-rose-300 bg-rose-500/15' : on ? 'text-sky-200 bg-sky-500/15' : past ? 'text-emerald-300/80' : 'text-zinc-600';
        return (
          <React.Fragment key={s}>
            <span className={`px-1.5 py-0.5 rounded-md ${color} ${phase === 'done' && on ? '!text-emerald-200 !bg-emerald-500/15' : ''}`}>{s}</span>
            {i < 2 && <span className="text-zinc-700">›</span>}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function HostCard({ v, onCopy, onRetry, style }) {
  const meta = HOST_META[v.host] || { label: v.host };
  const phase = v.phase;
  const ring = phase === 'done' ? 'border-emerald-500/50 shadow-[0_0_24px_-8px_rgba(52,211,153,.5)]' : phase === 'error' ? 'border-rose-500/60 wf-card-error' : phase === 'processing' ? 'border-violet-400/40' : phase === 'sending' ? 'border-sky-500/40' : 'border-border';
  return (
    <div className={`wf-card absolute -translate-x-1/2 rounded-2xl bg-card border ${ring} px-3 py-2.5 transition-colors`} style={style} data-phase={phase} data-host={v.host}>
      <div className="flex items-center gap-2.5">
        <div className="relative shrink-0">
          <HostBadge host={v.host} />
          {phase === 'done' && <span className="absolute -bottom-1 -left-1 w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center ring-2 ring-card wf-pop"><Check className="w-3 h-3 text-[#06281c]" strokeWidth={3.5} /></span>}
          {phase === 'error' && <span className="absolute -bottom-1 -left-1 w-4 h-4 rounded-full bg-rose-500 flex items-center justify-center ring-2 ring-card"><X className="w-3 h-3 text-white" strokeWidth={3.5} /></span>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-bold text-white">{meta.label}</span>
            {v.pct != null && phase !== 'error' && <span className="text-xs font-bold tabular-nums text-zinc-200" dir="ltr">{v.pct}%</span>}
          </div>
          <Steps step={v.step} phase={phase} />
        </div>
      </div>
      <div className="mt-2 h-1 rounded-full bg-[#1a2030] overflow-hidden">
        {v.pct != null && phase !== 'error' ? (
          <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${v.pct}%`, background: TONE[phase] || TONE.sending }} />
        ) : phase === 'processing' || phase === 'waiting' ? (
          <div className="h-full w-1/3 rounded-full wf-indet" style={{ background: TONE[phase] }} />
        ) : null}
      </div>
      {phase === 'done' && (v.link || v.code) && (
        <div className="mt-2 flex items-center gap-1.5">
          <span className="flex-1 min-w-0 truncate text-[10px] text-emerald-200/80 bg-emerald-500/10 rounded-md px-1.5 py-1" dir="ltr" title={v.link || v.code}>{(v.link || v.code).replace(/^https?:\/\//, '')}</span>
          <button onClick={() => onCopy(v.link || v.code)} className="btn btn-secondary !px-2 !py-1 text-[10px]" title="نسخ الرابط"><Copy className="w-3 h-3" /> نسخ</button>
        </div>
      )}
      {phase === 'error' && !v.cancelled && (
        <button onClick={onRetry} className="mt-2 btn btn-danger !py-1 !px-2 text-[11px] w-full"><RotateCw className="w-3 h-3" /> إعادة المحاولة</button>
      )}
      {phase === 'error' && v.cancelled && (
        <button onClick={onRetry} className="mt-2 btn btn-secondary !py-1 !px-2 text-[11px] w-full"><RotateCw className="w-3 h-3" /> إعادة الرفع</button>
      )}
    </div>
  );
}

// text chip sitting on a path
function Chip({ x, y, h, phase, children, tip, dx = 0 }) {
  const cls = {
    error: 'text-rose-200 bg-rose-500/15 border-rose-500/40 wf-chip-error',
    retrying: 'text-amber-200 bg-amber-500/10 border-amber-500/40',
    stalled: 'text-amber-200 bg-amber-500/10 border-amber-500/40',
    sending: 'text-sky-200 bg-sky-500/10 border-sky-500/30',
    processing: 'text-violet-200 bg-violet-500/10 border-violet-400/30',
    done: 'text-emerald-200 bg-emerald-500/10 border-emerald-500/30',
    waiting: 'text-zinc-400 bg-panel/90 border-border',
  }[phase] || 'text-zinc-400 bg-panel/90 border-border';
  return (
    <div dir="rtl" className={`absolute -translate-x-1/2 -translate-y-1/2 text-center text-[11px] leading-snug rounded-lg border px-2 py-1 backdrop-blur-sm ${cls}`}
      style={{ left: `${((x + dx) / W) * 100}%`, top: `${(y / h) * 100}%`, maxWidth: '10.5rem', minWidth: '5.5rem' }} title={tip || undefined} data-chip={phase}>
      {children}
    </div>
  );
}

function Diagram({ job, onRetry, onCopy, reduced }) {
  const sum = jobSummary(job);
  const viaServer = !!job.viaServer;
  const H = viaServer ? 510 : 420;
  const compY = viaServer ? 468 : 392;
  const serverY = 300;
  const rv = viaServer ? relayView(job) : null;
  const srcY = viaServer ? serverY - 34 : compY - 52;
  const srcXs = [372, 400, 428];

  return (
    <div className="relative w-full select-none" style={{ aspectRatio: `${W} / ${H}` }} dir="ltr">
      <svg className="absolute inset-0 w-full h-full" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" style={{ overflow: 'visible' }}>
        <defs>
          <filter id="wfGlow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="2.5" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
        </defs>
        {viaServer && <FlowPath id="wf-relay" d={pathD(400, compY - 52, 400, serverY + 34)} phase={rv.phase} speed={rv.speed || 0} reduced={reduced} />}
        {sum.views.map((v, i) => {
          const idx = Math.min(i, 2);
          const upstreamOk = !viaServer || rv.phase === 'done';
          const phase = viaServer && !upstreamOk && v.phase !== 'error' ? 'idle' : v.phase;
          return <FlowPath key={v.host} id={`wf-${v.host}`} d={pathD(srcXs[idx], srcY, HOST_X[idx], HOST_BOTTOM)} phase={phase} speed={v.speed} reduced={reduced} />;
        })}
      </svg>

      {sum.views.map((v, i) => {
        const idx = Math.min(i, 2);
        const mid = bez(srcXs[idx], srcY, HOST_X[idx], HOST_BOTTOM, 0.5);
        const dx = (idx - 1) * 26;
        const upstreamOk = !viaServer || rv.phase === 'done';
        const label = viaServer && !upstreamOk && v.phase !== 'error' ? null : v.label;
        return label ? (
          <Chip key={`c-${v.host}`} x={mid.x} y={mid.y} h={H} phase={v.phase} tip={v.tip} dx={dx}>
            <div>{label}</div>
            {v.speed > 0 && v.phase === 'sending' && <div className="text-[10px] opacity-70" dir="ltr">{fmtSpeed(v.speed)}</div>}
          </Chip>
        ) : null;
      })}
      {viaServer && (() => {
        const mid = bez(400, compY - 52, 400, serverY + 34, 0.5);
        return (
          <Chip x={mid.x} y={mid.y} h={H} phase={rv.phase} tip={rv.tip} dx={110}>
            <div>{rv.label}</div>
            {rv.speed > 0 && <div className="text-[10px] opacity-70" dir="ltr">{fmtSpeed(rv.speed)}</div>}
          </Chip>
        );
      })()}

      {sum.views.map((v, i) => (
        <HostCard key={v.host} v={v} style={{ left: `${(HOST_X[Math.min(i, 2)] / W) * 100}%`, bottom: `${((H - HOST_BOTTOM) / H) * 100}%`, width: '30%', minWidth: '9.5rem' }}
          onCopy={onCopy} onRetry={() => onRetry(v.host)} />
      ))}

      {viaServer && (
        <div className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center" style={{ left: '50%', top: `${(serverY / H) * 100}%` }}>
          <div className={`w-24 h-16 rounded-xl border bg-card flex items-center justify-center ${rv.phase === 'done' ? 'border-emerald-500/40' : rv.phase === 'error' ? 'border-rose-500/50' : 'border-sky-500/30'}`}>
            <Server className={`w-8 h-8 ${rv.phase === 'done' ? 'text-emerald-300' : rv.phase === 'error' ? 'text-rose-300' : 'text-sky-300'}`} />
          </div>
          <div className="mt-1 text-[11px] text-zinc-400" dir="rtl">سيرفر Despair</div>
        </div>
      )}

      <div className="absolute -translate-x-1/2 -translate-y-1/2 flex flex-col items-center" style={{ left: '50%', top: `${(compY / H) * 100}%` }}>
        <div className="w-24 h-[72px] rounded-xl border border-border bg-card flex items-center justify-center">
          <Monitor className="w-10 h-10 text-zinc-300" strokeWidth={1.5} />
        </div>
        <div className="mt-1 text-[11px] text-zinc-400" dir="rtl">جهازك</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
function QueueRow({ job, selected, onSelect }) {
  const s = jobSummary(job);
  return (
    <button onClick={onSelect} className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-right transition-colors border ${selected ? 'bg-[#151b26] border-accent/50' : 'bg-card border-border hover:bg-[#151b26]'}`} data-queue-row>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-white truncate">{job.animeTitle || job.animeId} <span className="text-zinc-500 font-normal">· حلقة {job.episodeNumber}</span></div>
        <div className="text-[10px] text-zinc-500 truncate" dir="ltr">{job.fileName}</div>
      </div>
      {job.viaServer && <span title="عبر السيرفر"><Server className="w-3.5 h-3.5 text-sky-400/80" /></span>}
      <div className="flex items-center gap-1" dir="ltr">
        {s.views.map((v) => <span key={v.host} title={`${HOST_META[v.host]?.label}: ${v.label}`} className="w-2.5 h-2.5 rounded-full" style={{ background: TONE[v.phase] || TONE.idle, opacity: v.phase === 'waiting' ? 0.5 : 1 }} />)}
      </div>
      <span className="w-14 text-left text-[11px] tabular-nums text-zinc-300" dir="ltr">{s.done ? '100%' : s.failed && !s.active ? 'فشل' : `${s.overall}%`}</span>
    </button>
  );
}

export default function WorkflowTab() {
  const { jobs, retryHost } = useOps();
  const { push } = useToast();
  const reduced = useReducedMotion();
  const [picked, setPicked] = useState(null);

  const sorted = useMemo(() => [...jobs].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))), [jobs]);
  const active = sorted.filter((j) => jobSummary(j).active);
  // follow what is really moving (newest first), else the next one waiting in the queue, else the newest finished one;
  // a click on a queue row pins that episode.
  const transferring = sorted.filter((j) => j.hosts.some((h) => ['uploading', 'processing'].includes(h.status) && h.stage !== 'waiting') || (j.viaServer && j.relay && j.relay.stage === 'sending'));
  const waiting = sorted.filter((j) => active.includes(j) && !transferring.includes(j));
  const current = (picked && sorted.find((j) => j.id === picked)) || transferring[0] || waiting[waiting.length - 1] || sorted[0] || null;

  const copy = (text) => { navigator.clipboard.writeText(text); push('تم نسخ الرابط', 'success'); };
  const others = sorted.filter((j) => !current || j.id !== current.id).slice(0, 30);

  if (!current) {
    return (
      <div className="max-w-4xl">
        <h2 className="text-lg font-bold text-white mb-5">مسار الرفع المباشر</h2>
        <div className="card p-10 text-center text-sm text-zinc-500"><Workflow className="w-8 h-8 mx-auto mb-3 text-zinc-600" />لا توجد عمليات رفع حاليًا. ابدأ رفع حلقة من تاب الرفع وسيظهر مسارها هنا.</div>
      </div>
    );
  }
  const sum = jobSummary(current);
  const fileSize = current.fileSize || (current.hosts.find((h) => h.total) || {}).total || 0;

  return (
    <div className="max-w-4xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-white">مسار الرفع المباشر</h2>
        {active.length > 0 && <span className="text-xs text-zinc-400">{active.length} قيد التنفيذ</span>}
      </div>

      <div className="card p-5">
        <div className="flex items-center justify-between gap-3 mb-4" dir="rtl">
          <div className="min-w-0">
            <div className="text-sm font-bold text-white flex items-center gap-2 flex-wrap">
              {current.animeTitle || current.animeId} <span className="text-zinc-500 font-normal">· حلقة {current.episodeNumber}</span>
              {current.viaServer && <span className="badge badge-uploading"><Server className="w-3 h-3" /> عبر السيرفر</span>}
              {sum.done && <span className="badge badge-done"><Check className="w-3 h-3" /> اكتملت</span>}
            </div>
            <div className="text-[11px] text-zinc-500 truncate" dir="ltr">{current.fileName}{fileSize ? ` · ${fmtBytes(fileSize)}` : ''}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {sum.done && (
              <button onClick={() => window.api.openEpisodeOnSite({ animeId: current.animeId, episodeNumber: current.episodeNumber })} className="btn btn-secondary !py-1.5 text-xs"><ExternalLink className="w-3.5 h-3.5" /> فتح على الموقع</button>
            )}
            {sum.active && <button onClick={() => window.api.cancelJob(current.id)} className="btn btn-danger !py-1.5 text-xs"><X className="w-3.5 h-3.5" /> إلغاء</button>}
          </div>
        </div>

        <Diagram job={current} reduced={reduced} onCopy={copy} onRetry={(host) => retryHost(current.id, host)} />
      </div>

      {others.length > 0 && (
        <div className="mt-5">
          <div className="text-xs text-zinc-500 mb-2">الطابور والحلقات الأخيرة</div>
          <div className="space-y-1.5">
            {others.map((j) => <QueueRow key={j.id} job={j} selected={false} onSelect={() => setPicked(j.id)} />)}
          </div>
        </div>
      )}
    </div>
  );
}
