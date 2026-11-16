import React, { useEffect, useMemo, useState } from 'react';
import { Search, Loader2, Download, X, RotateCw, Trash2, ArrowRight, CheckSquare } from 'lucide-react';
import { useToast } from '../context/ToastContext.jsx';
import { useTool } from '../context/ToolContext.jsx';
import ToolSetupCard from './ToolSetupCard.jsx';

const QUALITIES = ['1080p', '720p', '480p'];

function fmtSize(n) {
  if (!n) return '';
  const mb = n / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

function parseRange(text, max) {
  const out = new Set();
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b) && i <= max; i += 1) out.add(i);
  }
  return out;
}

function EpisodePicker({ provider, anime, onBack }) {
  const { push } = useToast();
  const [episodes, setEpisodes] = useState(null);
  const [selected, setSelected] = useState(new Set()); // of episode.number
  const [range, setRange] = useState('');
  const [quality, setQuality] = useState('1080p');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.api.getToolSettings().then((s) => setQuality(s.quality));
    window.api.toolEpisodes({ provider, animeId: anime.id }).then((res) => {
      if (!res.success) { push(res.error || 'فشل جلب الحلقات', 'error'); setEpisodes([]); return; }
      const list = [...res.episodes].sort((a, b) => Number(a.display_num) - Number(b.display_num));
      setEpisodes(list);
    });
  }, [provider, anime.id, push]);

  const byDisplay = useMemo(() => new Map((episodes || []).map((e) => [Number(e.display_num), e.number])), [episodes]);
  const toggle = (n) => setSelected((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const applyRange = () => {
    const nums = parseRange(range, Math.max(0, ...byDisplay.keys()));
    setSelected(new Set([...nums].map((d) => byDisplay.get(d)).filter(Boolean)));
  };

  const start = async () => {
    setBusy(true);
    await window.api.setToolSettings({ quality });
    const res = await window.api.startDownload({
      provider,
      anime: { id: anime.id, title: anime.title_en || anime.title_ar || anime.id, type: anime.type, cover: anime.thumbnail },
      episodes: [...selected],
      quality,
    });
    setBusy(false);
    if (!res.success) return push(res.error || 'فشل بدء التحميل', 'error');
    push(`بدأ تحميل ${selected.size} حلقة`, 'success');
    setSelected(new Set());
  };

  return (
    <div className="card p-5 mb-5">
      <div className="flex items-center gap-3 mb-4">
        <button onClick={onBack} className="text-zinc-400 hover:text-white"><ArrowRight className="w-4 h-4" /></button>
        <img src={anime.thumbnail} alt="" className="w-9 h-12 rounded-md object-cover bg-panel" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
        <div className="min-w-0">
          <div className="text-sm font-bold text-white truncate">{anime.title_en || anime.title_ar}</div>
          <div className="text-[11px] text-zinc-500">{episodes ? `${episodes.length} حلقة` : 'جارِ التحميل...'}</div>
        </div>
      </div>

      {!episodes ? (
        <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />
      ) : (
        <>
          <div className="flex items-end gap-3 flex-wrap mb-3">
            <div className="w-40">
              <label className="label">نطاق (مثال: 1-12, 15)</label>
              <input className="input" value={range} onChange={(e) => setRange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applyRange()} />
            </div>
            <button onClick={applyRange} className="btn btn-secondary">تحديد</button>
            <button onClick={() => setSelected(new Set(episodes.map((e) => e.number)))} className="btn btn-secondary"><CheckSquare className="w-4 h-4" /> الكل</button>
            <button onClick={() => setSelected(new Set())} className="btn btn-secondary">مسح</button>
            <div className="w-28">
              <label className="label">الجودة</label>
              <select className="input" value={quality} onChange={(e) => setQuality(e.target.value)}>
                {QUALITIES.map((q) => <option key={q}>{q}</option>)}
              </select>
            </div>
            <button onClick={start} disabled={busy || !selected.size} className="btn btn-primary">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />} تحميل ({selected.size})
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto">
            {episodes.map((e) => (
              <button
                key={e.number}
                onClick={() => toggle(e.number)}
                title={e.title || ''}
                className={`min-w-[2.5rem] px-2 py-1 rounded-md text-xs border transition-colors ${selected.has(e.number) ? 'border-accent bg-accent/15 text-white' : 'border-border text-zinc-400 hover:text-zinc-200'}`}
              >
                {e.display_num}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SearchPanel() {
  const { push } = useToast();
  const [providers, setProviders] = useState([]);
  const [provider, setProvider] = useState('anime3rb');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState(null);

  useEffect(() => {
    window.api.toolProviders().then((res) => {
      if (res.success) { setProviders(res.providers); setProvider(res.active || 'anime3rb'); }
    });
  }, []);

  const search = async (e) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setPicked(null);
    const res = await window.api.toolSearch({ provider, query: query.trim() });
    setSearching(false);
    if (!res.success) return push(res.error || 'فشل البحث', 'error');
    setResults(res.results);
  };

  if (picked) return <EpisodePicker provider={provider} anime={picked} onBack={() => setPicked(null)} />;

  return (
    <div className="card p-5 mb-5">
      <form onSubmit={search} className="flex items-end gap-3 flex-wrap">
        <div className="w-44">
          <label className="label">المزوّد</label>
          <select className="input" value={provider} onChange={(e) => { setProvider(e.target.value); setResults(null); }}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="flex-1 min-w-[12rem]">
          <label className="label">اسم الأنمي</label>
          <div className="relative">
            <Search className="w-4 h-4 text-zinc-500 absolute right-3 top-1/2 -translate-y-1/2" />
            <input className="input !pr-9" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ابحث بالإنجليزي أو العربي..." />
          </div>
        </div>
        <button type="submit" disabled={searching} className="btn btn-primary">
          {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} بحث
        </button>
      </form>

      {results && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-2 max-h-96 overflow-y-auto">
          {results.length === 0 && <div className="text-xs text-zinc-500 col-span-full">لا نتائج. جرّب مزوّد آخر أو اسم مختلف.</div>}
          {results.map((r) => (
            <button key={r.id} onClick={() => setPicked(r)} className="flex items-center gap-2.5 text-right p-2 rounded-lg border border-border hover:border-accent/60 hover:bg-panel">
              <img src={r.thumbnail} alt="" className="w-10 h-14 rounded-md object-cover shrink-0 bg-panel" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
              <div className="min-w-0">
                <div className="text-sm text-zinc-100 truncate">{r.title_en || r.title_ar}</div>
                <div className="text-[11px] text-zinc-500 truncate">{[r.type, r.episodes !== 'N/A' && `${r.episodes} حلقة`, r.status !== 'N/A' && r.status].filter(Boolean).join(' • ')}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const STATE_BADGE = { queued: 'badge-pending', resolving: 'badge-pending', downloading: 'badge-uploading', done: 'badge-done', error: 'badge-error' };
const STATE_LABEL = { queued: 'في الانتظار', resolving: 'جارِ جلب الرابط', downloading: 'جارِ التحميل', done: 'تم', error: 'فشل' };
const TASK_LABEL = { running: 'جارِ التحميل', done: 'انتهى', error: 'خطأ', cancelled: 'أُلغي', interrupted: 'توقف' };

function TaskCard({ t }) {
  const eps = Object.entries(t.episodes).sort((a, b) => Number(a[0]) - Number(b[0]));
  const finished = t.status !== 'running';
  const hasTodo = eps.some(([, e]) => e.status !== 'done');
  return (
    <div className="card p-4 mb-3">
      <div className="flex items-center gap-3 mb-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-white truncate">{t.animeTitle}</div>
          <div className="text-[11px] text-zinc-500">{t.quality} • {TASK_LABEL[t.status] || t.status}{t.error ? ` — ${t.error}` : ''}</div>
        </div>
        {!finished && <button onClick={() => window.api.cancelDownload(t.id)} className="btn btn-danger !py-1 text-xs"><X className="w-3.5 h-3.5" /> إلغاء</button>}
        {finished && hasTodo && <button onClick={() => window.api.retryDownload(t.id)} className="btn btn-secondary !py-1 text-xs"><RotateCw className="w-3.5 h-3.5" /> إعادة المحاولة</button>}
      </div>
      <div className="space-y-1.5">
        {eps.map(([n, e]) => {
          const pct = e.total ? Math.min(100, Math.round((e.done / e.total) * 100)) : 0;
          return (
            <div key={n} className="flex items-center gap-2.5 text-xs">
              <span className="w-14 text-zinc-300">حلقة {n}</span>
              <div className="flex-1 h-1.5 rounded bg-panel overflow-hidden">
                <div className={`h-full ${e.status === 'error' ? 'bg-rose-500' : e.status === 'done' ? 'bg-emerald-500' : 'bg-accent'}`} style={{ width: `${e.status === 'done' ? 100 : pct}%` }} />
              </div>
              <span className="w-24 text-zinc-500 text-left" dir="ltr">{e.status === 'downloading' && e.total ? `${pct}% ${fmtSize(e.total)}` : ''}</span>
              <span className={`badge ${STATE_BADGE[e.status] || 'badge-pending'}`} title={e.error || ''}>{STATE_LABEL[e.status] || e.status}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ToolTab() {
  const { status, tasks } = useTool();
  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-bold text-white mb-5">التحميل</h2>
      <ToolSetupCard />
      {status?.ready && <SearchPanel />}
      {tasks.length > 0 && (
        <>
          <div className="flex items-center mb-2">
            <h3 className="text-sm font-bold text-white">عمليات التحميل</h3>
            <button onClick={() => window.api.clearFinishedDownloads()} className="ms-auto text-[11px] text-zinc-500 hover:text-zinc-300 inline-flex items-center gap-1"><Trash2 className="w-3 h-3" /> مسح المنتهية</button>
          </div>
          {tasks.map((t) => <TaskCard key={t.id} t={t} />)}
        </>
      )}
    </div>
  );
}
