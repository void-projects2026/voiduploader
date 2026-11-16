import React, { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';

// Shown after uploads finish (at least one host succeeded): offers to delete
// the local copies. Declining keeps them in "تحميلاتي".
export default function DeletePrompt() {
  const [items, setItems] = useState(null);

  useEffect(() => {
    window.api.libraryReady();
    window.api.onDeletePrompt((d) => setItems(d.items));
  }, []);

  if (!items) return null;
  const jobIds = items.map((i) => i.jobId);
  const resolve = async (doDelete) => {
    setItems(null);
    await window.api.resolveDeletePrompt({ jobIds, doDelete });
  };

  return (
    <div className="fixed inset-0 z-[300] bg-black/60 flex items-center justify-center p-6">
      <div className="card w-full max-w-md p-5">
        <div className="flex items-center gap-2 mb-2">
          <Trash2 className="w-4 h-4 text-rose-400" />
          <h3 className="text-sm font-bold text-white">هل تريد مسح {items.length} حلقة؟</h3>
        </div>
        <p className="text-[11px] text-zinc-500 mb-3 leading-5">تم رفعها بنجاح على استضافة واحدة على الأقل. لو رفضت هتفضل في «تحميلاتي».</p>
        <div className="max-h-40 overflow-y-auto border border-border rounded-lg mb-4 divide-y divide-border">
          {items.map((i) => (
            <div key={i.jobId} className="px-3 py-1.5 text-xs text-zinc-300 truncate">{i.animeTitle} — حلقة {i.episodeNumber}</div>
          ))}
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={() => resolve(false)} className="btn btn-secondary">لا، احتفظ بها</button>
          <button onClick={() => resolve(true)} className="btn btn-primary">نعم، امسح</button>
        </div>
      </div>
    </div>
  );
}
