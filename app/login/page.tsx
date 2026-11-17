'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function sendCode() {
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? '验证码发送失败');
      setSent(true);
    } catch (err) { setError(err instanceof Error ? err.message : '验证码发送失败'); }
    finally { setBusy(false); }
  }

  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, code }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? '登录失败');
      const next = new URLSearchParams(window.location.search).get('next');
      router.replace(next?.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (err) { setError(err instanceof Error ? err.message : '登录失败'); }
    finally { setBusy(false); }
  }

  return <main className="login-page"><form className="doc-card login-card" onSubmit={login}>
    <p className="word-kicker">FLOW ACCOUNT</p><h1>邮箱登录</h1>
    <p className="doc-muted">输入邮箱，我们会发送一次性验证码。</p>
    <label className="login-label">邮箱地址<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></label>
    <div className="login-code-row"><label className="login-label">验证码<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value)} placeholder="6 位验证码" /></label><button className="doc-secondary-button" type="button" disabled={busy || !email} onClick={() => void sendCode()}>{busy ? '请稍候…' : sent ? '重新发送' : '发送验证码'}</button></div>
    {sent && <p className="doc-muted">验证码已发送，10 分钟内有效。</p>}{error && <p className="doc-error" role="alert">{error}</p>}
    <button className="primary-button login-submit" type="submit" disabled={busy || !sent}>{busy ? '正在登录…' : '登录'}</button>
  </form></main>;
}
