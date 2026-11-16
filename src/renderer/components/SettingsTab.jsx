import React, { useEffect, useState } from 'react';
import { useToast } from '../context/ToastContext.jsx';
import { useSession } from '../context/SessionContext.jsx';

export default function SettingsTab() {
  const { push } = useToast();
  const { profile } = useSession();
  const [concurrency, setConcurrency] = useState(3);
  const [version, setVersion] = useState('');

  useEffect(() => {
    window.api.getConfig().then((cfg) => setConcurrency(cfg.concurrency || 3));
    window.api.getAppVersion?.().then(setVersion);
  }, []);

  const save = async () => {
    await window.api.setConfig({ concurrency: Number(concurrency) || 3 });
    push('تم الحفظ', 'success');
  };

  return (
    <div className="max-w-md">
      <h2 className="text-lg font-bold text-white mb-5">الإعدادات</h2>

      <div className="card p-4 mb-5">
        <div className="text-sm font-semibold text-white">{profile?.username}</div>
        <div className="text-xs text-zinc-500">{profile?.isAdmin ? 'أدمن' : 'مساعد أدمن'}</div>
      </div>

      <div className="mb-5">
        <label className="label">الحد الأقصى للرفع المتوازي</label>
        <input className="input" type="number" min="1" max="10" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} />
        <p className="text-[11px] text-zinc-500 mt-1.5">عدد ملفات/استضافات الرفع التي تعمل في نفس الوقت عبر كل الحلقات.</p>
      </div>

      <button onClick={save} className="btn btn-primary">حفظ</button>

      <div className="mt-8 pt-4 border-t border-border flex items-center justify-between">
        {version && <p className="text-[11px] text-zinc-600">الإصدار: {version}</p>}
        <button onClick={() => { window.api.checkForUpdate(); push('جارِ التحقق من وجود تحديث...', 'info'); }} className="btn btn-secondary text-xs">تحقق من التحديثات</button>
      </div>
    </div>
  );
}
