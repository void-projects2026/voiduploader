import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { useSchedule } from '../context/ScheduleContext.jsx';

// The scheduler paused on a failure: skip the episode or stop the whole task.
export default function ScheduleDecisionPrompt() {
  const { tasks } = useSchedule();
  const task = tasks.find((t) => t.status === 'waiting_decision' && t.pendingDecision);
  if (!task) return null;
  const d = task.pendingDecision;
  const decide = (choice) => window.api.schedDecide({ id: task.id, choice });

  return (
    <div className="fixed inset-0 z-[320] bg-black/60 flex items-center justify-center p-6">
      <div className="card w-full max-w-md p-5 border-amber-500/40">
        <div className="flex items-center gap-2 mb-2">
          <AlertTriangle className="w-4 h-4 text-amber-400" />
          <h3 className="text-sm font-bold text-white">المهمة «{task.name}» متوقفة مؤقتًا</h3>
        </div>
        <p className="text-xs text-zinc-300 mb-1">{d.title} — حلقة {d.ep}</p>
        <p className="text-[11px] text-rose-300 mb-4 leading-5 break-words" dir="auto">{d.reason}</p>
        <div className="flex gap-2 justify-end">
          <button onClick={() => decide('stop')} className="btn btn-danger">إيقاف العملية</button>
          <button onClick={() => decide('skip')} className="btn btn-primary">تخطي ومتابعة</button>
        </div>
      </div>
    </div>
  );
}
