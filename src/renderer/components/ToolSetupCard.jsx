import React from 'react';
import { Loader2, Wrench, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { useTool } from '../context/ToolContext.jsx';

const STEP_LABEL = { python: 'بايثون', tool: 'أداة التحميل', deps: 'المتطلبات', verify: 'الفحص', done: 'جاهز' };

export default function ToolSetupCard() {
  const { status, setup, setupBusy, setupLog, setupError } = useTool();
  if (!status) return null;

  if (!status.ready) {
    return (
      <div className="card p-5 mb-5">
        <div className="flex items-center gap-2 mb-1">
          <Wrench className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-bold text-white">تجهيز أداة التحميل</h3>
        </div>
        <p className="text-[11px] text-zinc-500 mb-4 leading-5">
          خطوة لمرة واحدة: التطبيق هيستخدم بايثون المثبّت عندك لو موجود (أو ينزّل نسخة مدمجة لو مش موجود)، وينزّل الأداة والمتطلبات تلقائيًا.
        </p>
        <button onClick={() => setup()} disabled={setupBusy} className="btn btn-primary">
          {setupBusy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wrench className="w-4 h-4" />} {setupBusy ? 'جارِ التجهيز...' : 'تجهيز الآن'}
        </button>
        {setupBusy && setupLog && (
          <div className="mt-3 text-xs text-zinc-400">
            <b className="text-zinc-200">{STEP_LABEL[setupLog.step] || setupLog.step}</b>
            {Number.isFinite(setupLog.pct) && ` ${setupLog.pct}%`} — <span dir="ltr" className="text-zinc-500">{setupLog.message}</span>
          </div>
        )}
        {setupError && (
          <div className="mt-3 text-xs text-rose-400 flex items-start gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> <span dir="auto">{setupError}</span></div>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 mb-4 text-[11px] text-zinc-500">
      <span className="inline-flex items-center gap-1 text-emerald-400"><CheckCircle2 className="w-3.5 h-3.5" /> الأداة جاهزة</span>
      {status.toolManaged && (
        <button onClick={() => setup({ forceTool: true })} disabled={setupBusy} className="inline-flex items-center gap-1 hover:text-zinc-300">
          {setupBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />} تحديث الأداة (لو المزوّدين بطلوا يشتغلوا)
        </button>
      )}
    </div>
  );
}
