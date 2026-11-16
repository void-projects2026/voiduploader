import React, { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import { useSession } from '../context/SessionContext.jsx';

export default function Login() {
  const { login } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    const result = await login(email, password);
    setBusy(false);
    if (!result.success) setError(result.error || 'فشل تسجيل الدخول');
  };

  return (
    <div className="h-screen flex items-center justify-center">
      <form onSubmit={submit} className="card w-[360px] p-8 space-y-4">
        <div className="flex flex-col items-center gap-2 mb-2">
          <div className="w-11 h-11 rounded-xl bg-accent/15 flex items-center justify-center">
            <Download className="w-5 h-5 text-accent" />
          </div>
          <h1 className="text-base font-bold text-white">Despair Downloader</h1>
          <p className="text-xs text-zinc-500">تسجيل دخول بحساب الأدمن / مساعد الأدمن</p>
        </div>

        <div>
          <label className="label">الايميل</label>
          <input className="input" type="email" dir="ltr" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" autoFocus />
        </div>
        <div>
          <label className="label">كلمة السر</label>
          <input className="input" type="password" dir="ltr" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>

        {error && <p className="text-xs text-rose-400 bg-rose-500/10 rounded-lg px-3 py-2">{error}</p>}

        <button type="submit" disabled={busy || !email || !password} className="btn btn-primary w-full">
          {busy && <Loader2 className="w-4 h-4 animate-spin" />}
          تسجيل الدخول
        </button>
      </form>
    </div>
  );
}
