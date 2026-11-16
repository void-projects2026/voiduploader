import React from 'react';
import { Clapperboard, UploadCloud, ListChecks, Settings, LogOut, Download, DownloadCloud, HardDrive } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';
import { useOps } from '../context/OpsContext.jsx';

const ITEMS = [
  { id: 'anime', label: 'الأنمي', icon: Clapperboard },
  { id: 'upload', label: 'الرفع', icon: UploadCloud },
  { id: 'tool', label: 'التحميل', icon: DownloadCloud },
  { id: 'library', label: 'تحميلاتي', icon: HardDrive },
  { id: 'ops', label: 'العمليات', icon: ListChecks },
  { id: 'settings', label: 'الإعدادات', icon: Settings },
];

export default function Sidebar({ active, onChange }) {
  const { profile, logout } = useSession();
  const { jobs } = useOps();
  const activeCount = jobs.filter((j) => j.hosts.some((h) => h.status === 'uploading' || h.status === 'waiting')).length;

  return (
    <aside className="w-56 bg-panel border-l border-border flex flex-col">
      <div className="px-5 py-4 border-b border-border flex items-center gap-2">
        <div className="w-7 h-7 rounded-lg bg-accent/15 flex items-center justify-center">
          <Download className="w-3.5 h-3.5 text-accent" />
        </div>
        <span className="font-bold text-sm text-white">Anime Upload</span>
      </div>

      <div className="px-5 py-3 border-b border-border">
        <div className="text-sm font-semibold text-white truncate">{profile?.username}</div>
        <div className="text-[11px] text-zinc-500">{profile?.isAdmin ? 'أدمن' : 'مساعد أدمن'}</div>
      </div>

      <nav className="flex-1 py-2">
        {ITEMS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => onChange(id)}
            className={`w-full flex items-center gap-2.5 px-5 py-2.5 text-sm transition-colors border-r-[3px] ${
              active === id ? 'bg-[#151b26] border-accent text-white' : 'border-transparent text-zinc-400 hover:bg-[#151b26] hover:text-zinc-200'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
            {id === 'ops' && activeCount > 0 && (
              <span className="ms-auto text-[10px] font-bold bg-accent text-white rounded-full w-5 h-5 flex items-center justify-center">{activeCount}</span>
            )}
          </button>
        ))}
      </nav>

      <button onClick={logout} className="flex items-center gap-2 px-5 py-3.5 text-xs text-rose-400 hover:bg-rose-500/10 border-t border-border">
        <LogOut className="w-3.5 h-3.5" /> تسجيل خروج
      </button>
    </aside>
  );
}
