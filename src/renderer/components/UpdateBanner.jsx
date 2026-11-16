import React, { useEffect, useState } from 'react';
import { DownloadCloud, RefreshCw } from 'lucide-react';

export default function UpdateBanner() {
  const [state, setState] = useState(null); // { status, percent?, version? }

  useEffect(() => {
    window.api.onUpdateStatus?.(setState);
  }, []);

  if (!state || state.status === 'up-to-date' || state.status === 'checking' || state.status === 'error') return null;

  return (
    <div className="fixed top-0 inset-x-0 z-[150] bg-accent text-white text-xs px-4 py-2 flex items-center justify-center gap-2">
      {state.status === 'available' && <><DownloadCloud className="w-3.5 h-3.5" /> يتم تحميل تحديث جديد (v{state.version})...</>}
      {state.status === 'downloading' && <><DownloadCloud className="w-3.5 h-3.5" /> جارِ تحميل التحديث... {state.percent || 0}%</>}
      {state.status === 'ready' && (
        <button onClick={() => window.api.installUpdate()} className="flex items-center gap-1.5 font-semibold hover:underline">
          <RefreshCw className="w-3.5 h-3.5" /> تحديث جديد (v{state.version}) جاهز -- اضغط لإعادة التشغيل والتثبيت
        </button>
      )}
    </div>
  );
}
