import React, { useEffect, useRef, useState } from 'react';
import { Search, FileVideo, FolderOpen, Loader2, CheckCircle2, XCircle, UploadCloud } from 'lucide-react';
import { useToast } from '../context/ToastContext.jsx';
import { useWork } from '../context/WorkContext.jsx';

const HOSTS = [
  { id: 'earnvid', label: 'EarnVid' },
  { id: 'doodstream', label: 'Doodstream' },
  { id: 'voe', label: 'Voe' },
];

function WorkPicker() {
  const { selectedWork, setSelectedWork } = useWork();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!query.trim()) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      const res = await window.api.searchAnimeWorks(query.trim());
      setSearching(false);
      if (res.success) { setResults(res.works || []); setOpen(true); }
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  return (
    <div className="relative mb-5">
      <label className="label">العمل</label>
      <div className="relative">
        <Search className="w-4 h-4 text-zinc-500 absolute right-3 top-1/2 -translate-y-1/2" />
        <input
          className="input !pr-9"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          placeholder={selectedWork ? selectedWork.title : 'بحث عن عمل موجود...'}
        />
        {searching && <Loader2 className="w-4 h-4 animate-spin text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />}
      </div>

      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1.5 w-full card max-h-64 overflow-y-auto shadow-xl shadow-black/40">
          {results.map((w) => (
            <button
              key={w.id}
              onClick={() => {
                setSelectedWork({ id: w.id, title: w.title_ar || w.title || w.title_en || w.id });
                setQuery('');
                setResults([]);
                setOpen(false);
              }}
              className="w-full text-right px-3.5 py-2.5 text-sm text-zinc-200 hover:bg-panel border-b border-border last:border-0"
            >
              {w.title_ar || w.title || w.title_en} <span className="text-zinc-500 text-[11px]">({w.id})</span>
            </button>
          ))}
        </div>
      )}

      {selectedWork && (
        <div className="mt-2 inline-flex items-center gap-2 text-xs text-emerald-400 bg-emerald-500/10 px-3 py-1.5 rounded-lg">
          <CheckCircle2 className="w-3.5 h-3.5" /> {selectedWork.title}
        </div>
      )}
    </div>
  );
}

function HostChecklist({ hosts, setHosts }) {
  const toggle = (id) => setHosts((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]));
  return (
    <div className="flex gap-3 mb-5">
      {HOSTS.map((h) => (
        <label key={h.id} className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer transition-colors ${hosts.includes(h.id) ? 'border-accent bg-accent/10 text-white' : 'border-border text-zinc-400'}`}>
          <input type="checkbox" className="hidden" checked={hosts.includes(h.id)} onChange={() => toggle(h.id)} />
          {h.label}
        </label>
      ))}
    </div>
  );
}

function SingleEpisode({ hosts }) {
  const { selectedWork } = useWork();
  const { push, confirm } = useToast();
  const [episodeNumber, setEpisodeNumber] = useState('');
  const [filePath, setFilePath] = useState(null);
  const [checking, setChecking] = useState(false);
  const [presence, setPresence] = useState(null); // { earnvid: bool, ... }
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    setPresence(null);
    if (!selectedWork || !episodeNumber) return;
    debounceRef.current = setTimeout(async () => {
      setChecking(true);
      const res = await window.api.checkEpisode({ animeId: selectedWork.id, episodeNumber: Number(episodeNumber) });
      setChecking(false);
      if (res.success) setPresence(res.exists ? res.hostsPresent : {});
    }, 350);
    return () => clearTimeout(debounceRef.current);
  }, [selectedWork, episodeNumber]);

  const pickFile = async () => {
    const path = await window.api.pickFile();
    if (path) setFilePath(path);
  };

  const upload = async () => {
    if (!selectedWork) return push('اختر عملاً أولاً', 'error');
    if (!episodeNumber) return push('أدخل رقم الحلقة', 'error');
    if (!filePath) return push('اختر ملف الفيديو', 'error');
    if (!hosts.length) return push('اختر استضافة واحدة على الأقل', 'error');

    let effective = hosts;
    const already = presence ? hosts.filter((h) => presence[h]) : [];
    if (already.length) {
      const ok = await confirm(`الحلقة ${episodeNumber} موجودة على: ${already.map((h) => HOSTS.find((x) => x.id === h).label).join('، ')}`);
      if (!ok) effective = hosts.filter((h) => !already.includes(h));
    }
    if (!effective.length) return;

    setBusy(true);
    const result = await window.api.queueEpisodeUpload({
      animeId: selectedWork.id,
      animeTitle: selectedWork.title,
      episodeNumber: Number(episodeNumber),
      filePath,
      hosts: effective,
    });
    setBusy(false);
    if (!result.success) return push(result.error || 'فشل بدء الرفع', 'error');
    push(`بدأ رفع الحلقة ${episodeNumber} -- تابع في تاب العمليات`, 'success');
    setEpisodeNumber('');
    setFilePath(null);
    setPresence(null);
  };

  return (
    <div className="card p-5 mb-6">
      <h3 className="text-sm font-bold text-white mb-4">رفع حلقة واحدة</h3>
      <div className="flex items-end gap-3 flex-wrap">
        <div className="w-28">
          <label className="label">رقم الحلقة</label>
          <input className="input" type="number" min="1" value={episodeNumber} onChange={(e) => setEpisodeNumber(e.target.value)} />
        </div>
        <button onClick={pickFile} className="btn btn-secondary">
          <FileVideo className="w-4 h-4" /> {filePath ? filePath.split(/[\\/]/).pop() : 'اختيار ملف'}
        </button>
        <button onClick={upload} disabled={busy} className="btn btn-primary">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />} رفع
        </button>
        {checking && <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />}
      </div>

      {presence && (
        <div className="flex gap-2 mt-3">
          {hosts.map((h) => (
            <span key={h} className={`badge ${presence[h] ? 'badge-done' : 'badge-pending'}`}>
              {presence[h] ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
              {HOSTS.find((x) => x.id === h)?.label}: {presence[h] ? 'موجودة' : 'غير موجودة'}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function BulkFolder({ hosts }) {
  const { selectedWork } = useWork();
  const { push, confirm } = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);

  const pickFolder = async () => {
    const res = await window.api.pickAndScanFolder();
    if (res) setFiles(res.files);
  };

  const matched = files.filter((f) => f.guessedEpisode && (!from || f.guessedEpisode >= Number(from)) && (!to || f.guessedEpisode <= Number(to)));

  const uploadAll = async () => {
    if (!selectedWork) return push('اختر عملاً أولاً', 'error');
    if (!hosts.length) return push('اختر استضافة واحدة على الأقل', 'error');
    if (!matched.length) return push('لا توجد ملفات مطابقة للنطاق', 'error');

    setBusy(true);
    for (const file of matched) {
      const check = await window.api.checkEpisode({ animeId: selectedWork.id, episodeNumber: file.guessedEpisode });
      let effective = hosts;
      if (check.success && check.exists) {
        const already = hosts.filter((h) => check.hostsPresent[h]);
        if (already.length) {
          const ok = await confirm(`الحلقة ${file.guessedEpisode} موجودة على: ${already.map((h) => HOSTS.find((x) => x.id === h).label).join('، ')}`);
          if (!ok) effective = hosts.filter((h) => !already.includes(h));
        }
      }
      if (!effective.length) continue;
      await window.api.queueEpisodeUpload({
        animeId: selectedWork.id,
        animeTitle: selectedWork.title,
        episodeNumber: file.guessedEpisode,
        filePath: file.path,
        hosts: effective,
      });
    }
    setBusy(false);
    push(`بدأ رفع ${matched.length} حلقة -- تابع في تاب العمليات`, 'success');
  };

  return (
    <div className="card p-5">
      <h3 className="text-sm font-bold text-white mb-4">رفع متعدد (فولدر)</h3>
      <div className="flex items-end gap-3 flex-wrap mb-3">
        <div className="w-24"><label className="label">من حلقة</label><input className="input" type="number" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
        <div className="w-24"><label className="label">إلى حلقة</label><input className="input" type="number" value={to} onChange={(e) => setTo(e.target.value)} /></div>
        <button onClick={pickFolder} className="btn btn-secondary"><FolderOpen className="w-4 h-4" /> اختيار فولدر</button>
        <button onClick={uploadAll} disabled={busy || !matched.length} className="btn btn-primary">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />} رفع الكل ({matched.length})
        </button>
      </div>
      {matched.length > 0 && (
        <div className="max-h-40 overflow-y-auto text-xs text-zinc-400 space-y-1 border-t border-border pt-2">
          {matched.map((f) => <div key={f.path}>حلقة {f.guessedEpisode}: {f.name}</div>)}
        </div>
      )}
    </div>
  );
}

export default function UploadTab() {
  const [hosts, setHosts] = useState(['earnvid', 'doodstream', 'voe']);
  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-bold text-white mb-5">الرفع</h2>
      <WorkPicker />
      <label className="label">الاستضافات</label>
      <HostChecklist hosts={hosts} setHosts={setHosts} />
      <SingleEpisode hosts={hosts} />
      <BulkFolder hosts={hosts} />
    </div>
  );
}
