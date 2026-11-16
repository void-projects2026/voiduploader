import React, { useCallback, useEffect, useState } from 'react';
import { FolderOpen, FolderInput, Trash2, UploadCloud, FileVideo, Loader2, HardDrive } from 'lucide-react';
import { useToast } from '../context/ToastContext.jsx';
import { useTool } from '../context/ToolContext.jsx';
import LibraryUploadModal from './LibraryUploadModal.jsx';

function fmtSize(n) {
  const mb = n / 1048576;
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
}

export default function LibraryTab() {
  const { confirm, push } = useToast();
  const { libraryTick } = useTool();
  const [lib, setLib] = useState(null);
  const [uploadFor, setUploadFor] = useState(null);

  const load = useCallback(() => window.api.listLibrary().then(setLib), []);
  useEffect(() => { load(); }, [load, libraryTick]);

  const deleteAnime = async (a) => {
    if (!(await confirm(`مسح فولدر «${a.name}» بكل حلقاته (${a.episodes.length}) من الجهاز؟`, { yes: 'مسح', no: 'إلغاء' }))) return;
    await window.api.deleteLibraryAnime(a.name);
    push('تم المسح', 'success');
  };
  const deleteEp = async (e) => {
    if (!(await confirm(`مسح «${e.name}» من الجهاز؟`, { yes: 'مسح', no: 'إلغاء' }))) return;
    await window.api.deleteLibraryFile(e.path);
  };

  if (!lib) return <Loader2 className="w-4 h-4 animate-spin text-zinc-500" />;

  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-bold text-white mb-2">تحميلاتي</h2>
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        <span className="text-[11px] text-zinc-500 truncate" dir="ltr">{lib.root}</span>
        <button onClick={() => window.api.openLibraryRoot()} className="btn btn-secondary !py-1 text-xs"><FolderOpen className="w-3.5 h-3.5" /> فتح الفولدر</button>
        <button onClick={async () => { const p = await window.api.changeLibraryRoot(); if (p) push('تم تغيير مكان التحميلات (الحلقات القديمة تفضل في مكانها)', 'info'); }} className="btn btn-secondary !py-1 text-xs"><FolderInput className="w-3.5 h-3.5" /> تغيير المكان</button>
      </div>

      {lib.animes.length === 0 && (
        <div className="card p-8 text-center text-sm text-zinc-500">
          <HardDrive className="w-8 h-8 mx-auto mb-2 text-zinc-600" />
          لا توجد تحميلات بعد. حمّل حلقات من تاب «التحميل».
        </div>
      )}

      {lib.animes.map((a) => (
        <div key={a.path} className="card p-4 mb-3">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-white truncate">{a.name}</div>
              <div className="text-[11px] text-zinc-500">{a.episodes.length} ملف • {fmtSize(a.totalSize)}</div>
            </div>
            <button onClick={() => setUploadFor(a)} className="btn btn-primary !py-1 text-xs"><UploadCloud className="w-3.5 h-3.5" /> رفع للموقع</button>
            <button onClick={() => window.api.openLibraryAnime(a.name)} className="btn btn-secondary !py-1 text-xs"><FolderOpen className="w-3.5 h-3.5" /> فتح</button>
            <button onClick={() => deleteAnime(a)} className="btn btn-danger !py-1 text-xs"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
          <div className="divide-y divide-border">
            {a.episodes.map((e) => (
              <div key={e.path} className="flex items-center gap-2.5 py-1.5 text-xs">
                <FileVideo className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="w-14 text-zinc-300 shrink-0">{e.episode ? `حلقة ${e.episode}` : '—'}</span>
                <span className="flex-1 truncate text-zinc-500" dir="ltr">{e.name}</span>
                {e.partial && <span className="badge badge-pending">غير مكتمل</span>}
                <span className="text-zinc-500 w-16 text-left" dir="ltr">{fmtSize(e.size)}</span>
                <button onClick={() => window.api.showLibraryFile(e.path)} className="text-zinc-500 hover:text-zinc-200" title="إظهار في المستكشف"><FolderOpen className="w-3.5 h-3.5" /></button>
                <button onClick={() => deleteEp(e)} className="text-zinc-500 hover:text-rose-400" title="مسح"><Trash2 className="w-3.5 h-3.5" /></button>
              </div>
            ))}
          </div>
        </div>
      ))}

      {uploadFor && <LibraryUploadModal anime={uploadFor} onClose={() => setUploadFor(null)} />}
    </div>
  );
}
