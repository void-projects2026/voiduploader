import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { CheckCircle2, XCircle, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

export function useToast() {
  return useContext(ToastContext);
}

const ICONS = {
  success: <CheckCircle2 className="w-4 h-4 text-emerald-400" />,
  error: <XCircle className="w-4 h-4 text-rose-400" />,
  info: <Info className="w-4 h-4 text-sky-400" />,
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback((message, type = 'info', opts = {}) => {
    const id = ++idRef.current;
    setToasts((t) => [...t, { id, message, type, confirm: opts.confirm }]);
    if (!opts.confirm) {
      setTimeout(() => dismiss(id), opts.duration || 4500);
    }
    return id;
  }, [dismiss]);

  // Promise-based confirm, replacing window.confirm with a styled toast
  // that resolves true/false - used by the upload tab's "already exists,
  // replace?" check.
  const confirm = useCallback((message) => {
    return new Promise((resolve) => {
      const id = ++idRef.current;
      setToasts((t) => [
        ...t,
        {
          id,
          message,
          type: 'info',
          confirm: true,
          onYes: () => { dismiss(id); resolve(true); },
          onNo: () => { dismiss(id); resolve(false); },
        },
      ]);
    });
  }, [dismiss]);

  return (
    <ToastContext.Provider value={{ push, confirm }}>
      {children}
      <div className="fixed bottom-4 left-4 z-[200] flex flex-col gap-2 w-80">
        {toasts.map((t) => (
          <div key={t.id} className="card p-3 shadow-lg shadow-black/40 flex items-start gap-2 animate-in">
            {ICONS[t.type]}
            <div className="flex-1 text-xs text-zinc-200 leading-5">{t.message}</div>
            {t.confirm ? (
              <div className="flex gap-1.5 shrink-0">
                <button onClick={t.onYes} className="btn btn-primary !px-2 !py-1 text-[11px]">استبدال</button>
                <button onClick={t.onNo} className="btn btn-secondary !px-2 !py-1 text-[11px]">تخطي</button>
              </div>
            ) : (
              <button onClick={() => dismiss(t.id)} className="text-zinc-500 hover:text-zinc-300"><X className="w-3.5 h-3.5" /></button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
