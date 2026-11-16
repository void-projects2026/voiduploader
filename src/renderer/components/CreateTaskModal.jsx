import React, { useEffect, useMemo, useState } from 'react';
import { X, Search, Loader2, Plus, ArrowRight, CheckCircle2, Sparkles, Trash2 } from 'lucide-react';
import { useToast } from '../context/ToastContext.jsx';
import { useSchedule } from '../context/ScheduleContext.jsx';
import { compressRanges } from '../format.js';

const QUALITIES = ['1080p', '720p', '480p'];

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

const Cover = ({ url, className = 'w-9 h-12' }) => (
  <img src={url} alt="" className={`${className} rounded-md object-cover bg-panel shrink-0`} onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
);

// ---------------------------------------------------------------- step 1 ---
function WorkStep({ onPick }) {
  const { works, worksLoading, refreshWorks } = useSchedule();
  const { push } = useToast();
  const [tab, setTab] = useState('site');
  const [filter, setFilter] = useState('');
  const [aq, setAq] = useState('');
  const [aResults, setAResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState(null);
  const [titleAr, setTitleAr] = useState('');
  const [tr, setTr] = useState(null); // translated preview
  const [creating, setCreating] = useState(false);

  useEffect(() => { if (!works) refreshWorks(); }, [works, refreshWorks]);

  const siteList = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (works || []).filter((w) => !q || `${w.title} ${w.titleEn}`.toLowerCase().includes(q)).slice(0, 60);
  }, [works, filter]);

  const existingFor = (r) => (works || []).find((w) => w.anilistId && Number(w.anilistId) === Number(r.anilistId));

  const searchAniList = async () => {
    if (!aq.trim()) return;
    setSearching(true);
    const res = await window.api.anilistSearch(aq.trim());
    setSearching(false);
    if (!res.success) return push(res.error || 'فشل البحث في AniList', 'error');
    setAResults(res.results || []);
  };

  const pickAniList = async (r) => {
    const exists = existingFor(r);
    if (exists) return; // blocked: the work is already on the site
    setPicked(r);
    setTitleAr(r.titleRomaji || r.titleEnglish || '');
    setTr(null);
    const t = await window.api.anilistTranslatePreview({ descriptionEn: r.descriptionEn, genres: r.genres, tags: r.tags });
    if (t.success) setTr(t);
  };

  const create = async () => {
    if (!titleAr.trim()) return push('أدخل الاسم بالعربي', 'error');
    setCreating(true);
    const res = await window.api.anilistCreate({
      anilistId: picked.anilistId,
      titleAr: titleAr.trim(),
      titleRomaji: picked.titleRomaji,
      titleEnglish: picked.titleEnglish,
      coverUrl: picked.coverUrl,
      descriptionEn: picked.descriptionEn,
      synopsisAr: tr?.synopsisAr || picked.descriptionEn,
      genres: tr?.genresAr?.length ? tr.genresAr : picked.genres || [],
      tags: tr?.tagsAr?.length ? tr.tagsAr : picked.tags || [],
      status: picked.status,
      episodesCount: 0, // no auto VIP episodes (owner default)
      releaseYear: picked.releaseYear,
      studio: picked.studio,
      format: picked.format,
    });
    setCreating(false);
    if (!res.success) return push(res.error || 'فشل إنشاء العمل', 'error');
    push(`تم إنشاء «${titleAr.trim()}» على الموقع`, 'success');
    await refreshWorks();
    onPick({ id: res.id, title: titleAr.trim(), titleEn: picked.titleEnglish || picked.titleRomaji || '', coverUrl: picked.coverUrl, total: picked.episodesCount || 0, missing: [] });
  };

  return (
    <div>
      <div className="flex gap-2 mb-4">
        {[['site', 'من الموقع'], ['anilist', 'إنشاء من AniList']].map(([id, label]) => (
          <button key={id} onClick={() => { setTab(id); setPicked(null); }} className={`px-3 py-1.5 rounded-lg text-xs border ${tab === id ? 'border-accent bg-accent/10 text-white' : 'border-border text-zinc-400'}`}>{label}</button>
        ))}
      </div>

      {tab === 'site' && (
        <>
          <input className="input mb-3" placeholder="بحث في أعمال الموقع..." value={filter} onChange={(e) => setFilter(e.target.value)} />
          {worksLoading && !works && <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />}
          <div className="max-h-72 overflow-y-auto space-y-1.5">
            {siteList.map((w) => (
              <button key={w.id} onClick={() => onPick(w)} className="w-full flex items-center gap-2.5 text-right p-2 rounded-lg border border-border hover:border-accent/60 hover:bg-panel">
                <Cover url={w.coverUrl} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-zinc-100 truncate">{w.title}</div>
                  <div className="text-[11px] text-zinc-500">{w.missing.length ? `ناقص ${w.missing.length} من ${w.total}` : 'مكتمل'}</div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {tab === 'anilist' && !picked && (
        <>
          <div className="flex gap-2 mb-3">
            <input className="input flex-1" dir="ltr" placeholder="Naruto, One Piece..." value={aq} onChange={(e) => setAq(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && searchAniList()} />
            <button onClick={searchAniList} disabled={searching} className="btn btn-primary">{searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}</button>
          </div>
          <div className="max-h-72 overflow-y-auto space-y-1.5">
            {aResults.map((r) => {
              const ex = existingFor(r);
              return (
                <div key={r.anilistId} className="flex items-center gap-2.5 p-2 rounded-lg border border-border">
                  <Cover url={r.coverUrl} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-zinc-100 truncate">{r.titleRomaji || r.titleEnglish}</div>
                    <div className="text-[11px] text-zinc-500">{r.releaseYear || '؟'} · {r.episodesCount || '؟'} حلقة</div>
                  </div>
                  {ex ? (
                    <button onClick={() => onPick(ex)} className="btn btn-secondary !py-1 text-xs" title="هذا العمل موجود على الموقع بالفعل، ولا يمكن إنشاؤه مرة أخرى">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" /> موجود — اختياره
                    </button>
                  ) : (
                    <button onClick={() => pickAniList(r)} className="btn btn-secondary !py-1 text-xs"><Sparkles className="w-3.5 h-3.5" /> إنشاء</button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {tab === 'anilist' && picked && (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <Cover url={picked.coverUrl} className="w-12 h-16" />
            <div className="text-sm text-white">{picked.titleRomaji}</div>
          </div>
          <div>
            <label className="label">الاسم بالعربي</label>
            <input className="input" value={titleAr} onChange={(e) => setTitleAr(e.target.value)} />
          </div>
          <p className="text-[11px] text-zinc-500 flex items-center gap-1.5">
            {tr ? <><CheckCircle2 className="w-3 h-3 text-emerald-400" /> تمت ترجمة القصة والتصنيفات تلقائيًا</> : <><Loader2 className="w-3 h-3 animate-spin" /> جارِ الترجمة...</>}
          </p>
          <div className="flex gap-2">
            <button onClick={create} disabled={creating} className="btn btn-primary">{creating && <Loader2 className="w-4 h-4 animate-spin" />} إنشاء العمل على الموقع</button>
            <button onClick={() => setPicked(null)} className="btn btn-secondary">رجوع</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- step 2 ---
function SourceStep({ work, providers, defaultProvider, onAdd, onBack }) {
  const { push } = useToast();
  const [provider, setProvider] = useState(defaultProvider);
  const [query, setQuery] = useState(work.titleEn || work.title);
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [anime, setAnime] = useState(null);
  const [episodes, setEpisodes] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [range, setRange] = useState('');
  const [quality, setQuality] = useState('1080p');
  const missingNums = useMemo(() => new Set((work.missing || []).map((m) => m.n)), [work]);

  const search = async (e) => {
    e?.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    setAnime(null);
    const res = await window.api.toolSearch({ provider, query: query.trim() });
    setSearching(false);
    if (!res.success) return push(res.error || 'فشل البحث', 'error');
    setResults(res.results);
  };

  const pick = async (a) => {
    setAnime(a);
    setEpisodes(null);
    setSelected(new Set());
    const res = await window.api.toolEpisodes({ provider, animeId: a.id });
    if (!res.success) { push(res.error || 'فشل جلب الحلقات', 'error'); setEpisodes([]); return; }
    setEpisodes([...res.episodes].sort((x, y) => Number(x.display_num) - Number(y.display_num)));
  };

  const toggle = (n) => setSelected((s) => { const x = new Set(s); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const byDisplay = new Map((episodes || []).map((e) => [Number(e.display_num), e]));
  const selectDisplays = (set) => setSelected(new Set([...set].map((d) => byDisplay.get(d)?.number).filter(Boolean)));

  const add = () => {
    const chosen = episodes.filter((e) => selected.has(e.number));
    onAdd({
      workId: work.id,
      workTitle: work.title,
      workTitleEn: work.titleEn || '',
      coverUrl: work.coverUrl,
      provider,
      quality,
      anime: { id: anime.id, title: anime.title_en || anime.title_ar || work.title, type: anime.type || 'SERIES' },
      episodes: chosen.map((e) => ({ number: String(e.number), display: Number(e.display_num) })),
    });
  };

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <button onClick={onBack} className="text-zinc-400 hover:text-white"><ArrowRight className="w-4 h-4" /></button>
        <Cover url={work.coverUrl} />
        <div className="min-w-0">
          <div className="text-sm font-bold text-white truncate">{work.title}</div>
          <div className="text-[11px] text-zinc-500">{work.missing?.length ? `ناقص على الموقع: ${compressRanges(work.missing.map((m) => m.n))}` : 'لا توجد حلقات ناقصة معروفة'}</div>
        </div>
      </div>

      {!anime ? (
        <>
          <form onSubmit={search} className="flex items-end gap-2 mb-3 flex-wrap">
            <div className="w-40">
              <label className="label">المصدر</label>
              <select className="input" value={provider} onChange={(e) => { setProvider(e.target.value); setResults(null); }}>
                {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="flex-1 min-w-[10rem]">
              <label className="label">البحث بالأداة</label>
              <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <button type="submit" disabled={searching} className="btn btn-primary">{searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}</button>
          </form>
          <div className="max-h-64 overflow-y-auto space-y-1.5">
            {results && results.length === 0 && <div className="text-xs text-zinc-500">لا نتائج. جرّب اسمًا أو مصدرًا آخر.</div>}
            {(results || []).map((r) => (
              <button key={r.id} onClick={() => pick(r)} className="w-full flex items-center gap-2.5 text-right p-2 rounded-lg border border-border hover:border-accent/60 hover:bg-panel">
                <Cover url={r.thumbnail} />
                <div className="min-w-0">
                  <div className="text-sm text-zinc-100 truncate">{r.title_en || r.title_ar}</div>
                  <div className="text-[11px] text-zinc-500">{[r.type, r.episodes !== 'N/A' && `${r.episodes} حلقة`].filter(Boolean).join(' • ')}</div>
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="text-xs text-zinc-300 mb-2 flex items-center gap-2">
            <b>{anime.title_en || anime.title_ar}</b>
            <button onClick={() => setAnime(null)} className="text-accent hover:underline">تغيير</button>
          </div>
          {!episodes ? <Loader2 className="w-4 h-4 animate-spin text-zinc-500" /> : (
            <>
              <div className="flex items-end gap-2 flex-wrap mb-3">
                <div className="w-36">
                  <label className="label">نطاق (1-12, 15)</label>
                  <input className="input" value={range} onChange={(e) => setRange(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && selectDisplays(parseRange(range, 9999))} />
                </div>
                <button onClick={() => selectDisplays(parseRange(range, 9999))} className="btn btn-secondary">تحديد</button>
                <button onClick={() => selectDisplays(missingNums)} disabled={!missingNums.size} className="btn btn-secondary">الناقصة فقط</button>
                <button onClick={() => setSelected(new Set(episodes.map((e) => e.number)))} className="btn btn-secondary">الكل</button>
                <button onClick={() => setSelected(new Set())} className="btn btn-secondary">مسح</button>
                <div className="w-24">
                  <label className="label">الجودة</label>
                  <select className="input" value={quality} onChange={(e) => setQuality(e.target.value)}>{QUALITIES.map((q) => <option key={q}>{q}</option>)}</select>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto mb-4">
                {episodes.map((e) => {
                  const miss = missingNums.has(Number(e.display_num));
                  return (
                    <button key={e.number} onClick={() => toggle(e.number)} title={miss ? 'ناقصة على الموقع' : 'موجودة على الموقع'}
                      className={`min-w-[2.5rem] px-2 py-1 rounded-md text-xs border ${selected.has(e.number) ? 'border-accent bg-accent/15 text-white' : miss ? 'border-amber-500/40 text-amber-300' : 'border-border text-zinc-500'}`}>
                      {e.display_num}
                    </button>
                  );
                })}
              </div>
              <button onClick={add} disabled={!selected.size} className="btn btn-primary"><Plus className="w-4 h-4" /> إضافة للمهمة ({selected.size} حلقة)</button>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- step 3 ---
function OptionsStep({ items, setItems, providers, opts, setOpts, onCreate, busy }) {
  const [name, setName] = useState('');
  const [mode, setMode] = useState('now');
  const [startAt, setStartAt] = useState('');
  const set = (k, v) => setOpts((o) => ({ ...o, [k]: v }));
  const primary = opts.sources[0];
  const fallback = opts.sources[1] || '';
  const setSources = (p, f) => set('sources', [p, f].filter(Boolean));

  return (
    <div className="space-y-4">
      <div>
        <label className="label">أعمال المهمة</label>
        <div className="space-y-1.5">
          {items.map((it, i) => (
            <div key={i} className="flex items-center gap-2 p-2 rounded-lg border border-border text-xs">
              <Cover url={it.coverUrl} className="w-7 h-10" />
              <div className="min-w-0 flex-1">
                <div className="text-zinc-100 truncate">{it.workTitle}</div>
                <div className="text-zinc-500">{it.provider} • {it.quality} • حلقات: {compressRanges(it.episodes.map((e) => e.display))}</div>
              </div>
              <button onClick={() => setItems(items.filter((_, j) => j !== i))} className="text-zinc-500 hover:text-rose-400"><Trash2 className="w-3.5 h-3.5" /></button>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label">المصدر</label>
          <select className="input" value={primary} onChange={(e) => setSources(e.target.value, fallback === e.target.value ? '' : fallback)}>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">المصدر الاحتياطي</label>
          <select className="input" value={fallback} onChange={(e) => setSources(primary, e.target.value)}>
            <option value="">بدون</option>
            {providers.filter((p) => p.id !== primary).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">فترة التوقف بين الحلقات (ثانية)</label>
          <input className="input" type="number" min="0" value={opts.pauseSec} onChange={(e) => set('pauseSec', Number(e.target.value))} />
        </div>
        <div>
          <label className="label">اسم المهمة (اختياري)</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
      </div>

      <label className="flex items-start gap-2 text-xs text-zinc-300 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={opts.skipOnFail} onChange={(e) => set('skipOnFail', e.target.checked)} />
        <span>تخطي الفشل الجزئي تلقائيًا: لو سيرفر أو اتنين فشلوا والحلقة اترفعت على واحد على الأقل تكمّل المهمة. لو ألغيته، المهمة بتوقف وبتسألك (تخطي / إيقاف) عند أي فشل. فشل الحلقة بالكامل بيسألك في الحالتين.</span>
      </label>

      <div className="flex items-center gap-2 text-xs text-zinc-300 flex-wrap">
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={opts.deleteEnabled} onChange={(e) => set('deleteEnabled', e.target.checked)} />
          مسح الحلقة تلقائيًا بعد تأكيد رفعها على
        </label>
        <input className="input !w-16 !py-1" type="number" min="1" max="3" value={opts.deleteAfterHosts} disabled={!opts.deleteEnabled} onChange={(e) => set('deleteAfterHosts', Number(e.target.value))} />
        <span>استضافة</span>
      </div>

      <div>
        <label className="label">التشغيل</label>
        <div className="flex gap-2 flex-wrap items-center text-xs">
          {[['now', 'ابدأ الآن'], ['at', 'جدولة لوقت'], ['save', 'حفظ فقط']].map(([id, label]) => (
            <button key={id} onClick={() => setMode(id)} className={`px-3 py-1.5 rounded-lg border ${mode === id ? 'border-accent bg-accent/10 text-white' : 'border-border text-zinc-400'}`}>{label}</button>
          ))}
          {mode === 'at' && <input type="datetime-local" className="input !w-56 !py-1.5" value={startAt} onChange={(e) => setStartAt(e.target.value)} />}
        </div>
      </div>

      <button
        onClick={() => onCreate({ name, mode, startAt: startAt ? new Date(startAt).toISOString() : null })}
        disabled={busy || !items.length || (mode === 'at' && !startAt)}
        className="btn btn-primary w-full"
      >
        {busy && <Loader2 className="w-4 h-4 animate-spin" />} إنشاء المهمة
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ modal ---
export default function CreateTaskModal({ initialWork, onClose }) {
  const { push } = useToast();
  const [step, setStep] = useState(initialWork ? 'source' : 'work');
  const [work, setWork] = useState(initialWork || null);
  const [items, setItems] = useState([]);
  const [providers, setProviders] = useState([]);
  const [busy, setBusy] = useState(false);
  const [opts, setOpts] = useState({ skipOnFail: true, deleteEnabled: true, deleteAfterHosts: 1, sources: ['anime_slayer', 'anime3rb'], pauseSec: 5 });

  useEffect(() => {
    window.api.toolProviders().then((res) => {
      if (!res.success) { push(res.error || 'الأداة غير جاهزة', 'error'); return; }
      setProviders(res.providers);
      const ids = res.providers.map((p) => p.id);
      setOpts((o) => ({ ...o, sources: o.sources.filter((s) => ids.includes(s)).length ? o.sources.filter((s) => ids.includes(s)) : [ids[0]] }));
    });
  }, [push]);

  const addItem = (item) => {
    if (items.some((i) => i.workId === item.workId)) return push('هذا العمل مضاف بالفعل لهذه المهمة', 'error');
    setItems([...items, item]);
    setStep('added');
  };

  const create = async ({ name, mode, startAt }) => {
    setBusy(true);
    const res = await window.api.schedCreate({ name, mode, startAt, items, options: opts });
    setBusy(false);
    if (!res.success) return push(res.error || 'فشل إنشاء المهمة', 'error');
    push('تم إنشاء المهمة', 'success');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[150] bg-black/60 flex items-center justify-center p-6">
      <div className="card w-full max-w-xl p-5 max-h-[92vh] overflow-y-auto">
        <div className="flex items-center mb-4">
          <h3 className="text-sm font-bold text-white">
            مهمة جديدة {items.length > 0 && <span className="text-zinc-500 font-normal">({items.length} عمل)</span>}
          </h3>
          <button onClick={onClose} className="ms-auto text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
        </div>

        {step === 'work' && <WorkStep onPick={(w) => { setWork(w); setStep('source'); }} />}
        {step === 'source' && work && providers.length > 0 && (
          <SourceStep work={work} providers={providers} defaultProvider={opts.sources[0]} onAdd={addItem} onBack={() => setStep(items.length ? 'added' : 'work')} />
        )}
        {step === 'source' && providers.length === 0 && <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />}
        {step === 'added' && (
          <div className="text-center py-6">
            <CheckCircle2 className="w-8 h-8 text-emerald-400 mx-auto mb-2" />
            <p className="text-sm text-zinc-200 mb-4">تمت إضافة «{items[items.length - 1]?.workTitle}»</p>
            <div className="flex gap-2 justify-center">
              <button onClick={() => setStep('work')} className="btn btn-secondary"><Plus className="w-4 h-4" /> إضافة عمل آخر</button>
              <button onClick={() => setStep('options')} className="btn btn-primary">التالي: الإعدادات</button>
            </div>
          </div>
        )}
        {step === 'options' && <OptionsStep items={items} setItems={setItems} providers={providers} opts={opts} setOpts={setOpts} onCreate={create} busy={busy} />}
      </div>
    </div>
  );
}
