import React, { useState } from 'react';
import { Search, Loader2, Sparkles } from 'lucide-react';
import { useToast } from '../context/ToastContext.jsx';
import { useWork } from '../context/WorkContext.jsx';

export default function AnimeTab() {
  const { push } = useToast();
  const { setSelectedWork } = useWork();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [picked, setPicked] = useState(null);
  const [translating, setTranslating] = useState(false);
  const [creating, setCreating] = useState(false);

  // editable review fields, populated after translate-preview
  const [titleAr, setTitleAr] = useState('');
  const [synopsisAr, setSynopsisAr] = useState('');
  const [genres, setGenres] = useState([]);
  const [tags, setTags] = useState([]);
  // Owner decision (matches the website admin panel's own AniList modal):
  // off by default. When off, episodesCount is sent as 0 so the server
  // creates zero auto-generated VIP episodes; the admin opts in per-work.
  const [syncVip, setSyncVip] = useState(false);

  const doSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    const res = await window.api.anilistSearch(query.trim());
    setSearching(false);
    if (!res.success) return push(res.error || 'فشل البحث في AniList', 'error');
    setResults(res.results || []);
  };

  const pick = async (r) => {
    setPicked(r);
    setTitleAr(r.titleRomaji || r.titleEnglish || '');
    setSynopsisAr(r.descriptionEn);
    setGenres(r.genres || []);
    setTags(r.tags || []);
    setSyncVip(false);
    setTranslating(true);
    const t = await window.api.anilistTranslatePreview({ descriptionEn: r.descriptionEn, genres: r.genres, tags: r.tags });
    setTranslating(false);
    if (t.success) {
      setSynopsisAr(t.synopsisAr || r.descriptionEn);
      if (t.genresAr?.length) setGenres(t.genresAr);
      if (t.tagsAr?.length) setTags(t.tagsAr);
    } else {
      push(t.error || 'فشلت الترجمة -- يمكنك التعديل يدويًا', 'error');
    }
  };

  const confirmCreate = async () => {
    if (!picked || !titleAr.trim()) return push('أدخل الاسم بالعربي', 'error');
    setCreating(true);
    const res = await window.api.anilistCreate({
      anilistId: picked.anilistId,
      titleAr: titleAr.trim(),
      titleRomaji: picked.titleRomaji,
      titleEnglish: picked.titleEnglish,
      coverUrl: picked.coverUrl,
      descriptionEn: picked.descriptionEn,
      synopsisAr,
      genres,
      tags,
      status: picked.status,
      episodesCount: syncVip ? picked.episodesCount : 0,
      releaseYear: picked.releaseYear,
      studio: picked.studio,
      format: picked.format,
    });
    setCreating(false);
    if (!res.success) return push(res.error || 'فشل الإنشاء', 'error');
    setSelectedWork({ id: res.id, title: titleAr.trim(), coverUrl: picked.coverUrl });
    push(`تم إنشاء "${titleAr.trim()}" بنجاح (${res.episodesCreated || 0} حلقة VIP تلقائية)`, 'success');
    setPicked(null);
    setResults([]);
    setQuery('');
  };

  if (picked) {
    return (
      <div className="max-w-2xl">
        <h2 className="text-lg font-bold text-white mb-1">مراجعة قبل الإنشاء</h2>
        <p className="text-xs text-zinc-500 mb-5">راجع وعدّل البيانات المترجمة قبل التأكيد.</p>

        <div className="card p-4 flex items-center gap-3 mb-5">
          <img src={picked.coverUrl} alt="" className="w-14 h-20 rounded-lg object-cover bg-panel shrink-0" />
          <div className="min-w-0">
            <div className="text-sm font-bold text-white truncate">{picked.titleRomaji}</div>
            <div className="text-[11px] text-zinc-500">{picked.releaseYear || '؟'} · {picked.episodesCount || '؟'} حلقة · {picked.studio}</div>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="label">الاسم بالعربي</label>
            <input className="input" value={titleAr} onChange={(e) => setTitleAr(e.target.value)} />
          </div>
          <div>
            <label className="label flex items-center gap-1.5">
              القصة (مترجمة) {translating && <Loader2 className="w-3 h-3 animate-spin" />}
            </label>
            <textarea className="input" rows={5} value={synopsisAr} onChange={(e) => setSynopsisAr(e.target.value)} />
          </div>
          <div>
            <label className="label">التصنيفات</label>
            <input className="input" value={genres.join('، ')} onChange={(e) => setGenres(e.target.value.split('،').map((s) => s.trim()).filter(Boolean))} />
          </div>
          <div>
            <label className="label">الوسوم</label>
            <input className="input" value={tags.join('، ')} onChange={(e) => setTags(e.target.value.split('،').map((s) => s.trim()).filter(Boolean))} />
          </div>
          <label className="flex items-center gap-2 text-xs text-zinc-300 cursor-pointer select-none">
            <input type="checkbox" checked={syncVip} onChange={(e) => setSyncVip(e.target.checked)} className="accent-accent" />
            مزامنة تلقائية مع سيرفر VIP (إنشاء حلقات VIP تلقائيًا الآن) -- متوقف افتراضيًا
          </label>
          <div className="flex gap-2 pt-2">
            <button onClick={confirmCreate} disabled={creating || translating} className="btn btn-primary">
              {creating && <Loader2 className="w-4 h-4 animate-spin" />} تأكيد الإنشاء
            </button>
            <button onClick={() => setPicked(null)} className="btn btn-secondary">إلغاء</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-bold text-white mb-1 flex items-center gap-2"><Sparkles className="w-4 h-4 text-accent" /> إنشاء عمل من AniList</h2>
      <p className="text-xs text-zinc-500 mb-5">البحث عن عمل موجود للرفع عليه موجود في تاب "الرفع".</p>

      <div className="flex gap-2 mb-4">
        <input
          className="input flex-1"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
          placeholder="Naruto, One Piece..."
          dir="ltr"
        />
        <button onClick={doSearch} disabled={searching} className="btn btn-primary shrink-0">
          {searching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />} بحث
        </button>
      </div>

      <div className="space-y-2">
        {results.map((r) => (
          <button
            key={r.anilistId}
            onClick={() => pick(r)}
            className="w-full flex items-center gap-3 p-2.5 rounded-xl bg-panel border border-border hover:border-accent/50 text-right transition-colors"
          >
            <img src={r.coverUrl} alt="" className="w-12 h-16 rounded-lg object-cover shrink-0 bg-card" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-bold text-white truncate">{r.titleRomaji || r.titleEnglish}</div>
              <div className="text-[10px] text-zinc-500 truncate">{r.releaseYear || '؟'} · {r.episodesCount || '؟'} حلقة · {(r.genres || []).join('، ')}</div>
            </div>
          </button>
        ))}
        {results.length === 0 && !searching && query && (
          <p className="text-xs text-zinc-500 text-center py-6">لا توجد نتائج</p>
        )}
      </div>
    </div>
  );
}
