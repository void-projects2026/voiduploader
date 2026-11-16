import React, { useState } from 'react';
import { X, UploadCloud, Loader2 } from 'lucide-react';
import { useToast } from '../context/ToastContext.jsx';
import { useWork } from '../context/WorkContext.jsx';
import { WorkPicker, HostChecklist, HOSTS } from './UploadTab.jsx';

// Uploads episodes straight from a "تحميلاتي" folder to the site's hosts.
export default function LibraryUploadModal({ anime, onClose }) {
  const { selectedWork } = useWork();
  const { push, confirm } = useToast();
  const files = anime.episodes.filter((e) => !e.partial && e.episode);
  const [hosts, setHosts] = useState(['earnvid', 'doodstream', 'voe']);
  const [chosen, setChosen] = useState(new Set(files.map((f) => f.path)));
  const [busy, setBusy] = useState(false);

  const toggle = (p) => setChosen((s) => { const x = new Set(s); x.has(p) ? x.delete(p) : x.add(p); return x; });

  const upload = async () => {
    if (!selectedWork) return push('اختر العمل على الموقع أولاً', 'error');
    if (!hosts.length) return push('اختر استضافة واحدة على الأقل', 'error');
    const todo = files.filter((f) => chosen.has(f.path));
    if (!todo.length) return push('اختر حلقة واحدة على الأقل', 'error');

    setBusy(true);
    let queued = 0;
    for (const file of todo) {
      const check = await window.api.checkEpisode({ animeId: selectedWork.id, episodeNumber: file.episode });
      let effective = hosts;
      if (check.success && check.exists) {
        const already = hosts.filter((h) => check.hostsPresent[h]);
        if (already.length) {
          const ok = await confirm(`الحلقة ${file.episode} موجودة على: ${already.map((h) => HOSTS.find((x) => x.id === h).label).join('، ')}`);
          if (!ok) effective = hosts.filter((h) => !already.includes(h));
        }
      }
      if (!effective.length) continue;
      const res = await window.api.queueEpisodeUpload({
        animeId: selectedWork.id,
        animeTitle: selectedWork.title,
        episodeNumber: file.episode,
        filePath: file.path,
        hosts: effective,
      });
      if (res.success) queued += 1;
      else push(res.error || `فشل رفع الحلقة ${file.episode}`, 'error');
    }
    setBusy(false);
    if (queued) {
      push(`بدأ رفع ${queued} حلقة -- بعد النجاح هيتسأل لو عايز تمسحها من التحميلات`, 'success');
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[150] bg-black/60 flex items-center justify-center p-6">
      <div className="card w-full max-w-lg p-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center mb-4">
          <h3 className="text-sm font-bold text-white">رفع «{anime.name}» للموقع</h3>
          <button onClick={onClose} className="ms-auto text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
        </div>
        <WorkPicker />
        <label className="label">الاستضافات</label>
        <HostChecklist hosts={hosts} setHosts={setHosts} />
        <label className="label">الحلقات</label>
        <div className="max-h-52 overflow-y-auto border border-border rounded-lg mb-4">
          {files.length === 0 && <div className="p-3 text-xs text-zinc-500">لا توجد حلقات مكتملة قابلة للرفع.</div>}
          {files.map((f) => (
            <label key={f.path} className="flex items-center gap-2 px-3 py-1.5 text-xs text-zinc-300 border-b border-border last:border-0 cursor-pointer">
              <input type="checkbox" checked={chosen.has(f.path)} onChange={() => toggle(f.path)} />
              حلقة {f.episode}
            </label>
          ))}
        </div>
        <button onClick={upload} disabled={busy || !files.length} className="btn btn-primary w-full">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />} رفع ({chosen.size})
        </button>
      </div>
    </div>
  );
}
