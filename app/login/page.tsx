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

  return <main className="login-page">
    <div className="login-layout">
      <section className="login-intro" aria-label="Flow 产品介绍">
        <a className="login-brand" href="/" aria-label="Flow 首页">fl<span>o</span>w<span className="login-brand-dot">.</span></a>
        <div className="login-intro-copy">
          <p className="login-eyebrow">A SMALL STEP, EVERY DAY</p>
          <h1>让学习<br />自然发生<span>。</span></h1>
          <p className="login-lead">把词汇放进真实语境，用每天一点点的练习，慢慢积累理解与表达的力量。</p>
          <div className="login-steps" aria-label="学习流程">
            <div><span>01</span><p><strong>遇见</strong><small>在语境里认识新词</small></p></div>
            <i aria-hidden="true" />
            <div><span>02</span><p><strong>理解</strong><small>连接意义与表达</small></p></div>
            <i aria-hidden="true" />
            <div><span>03</span><p><strong>记住</strong><small>通过复习留在脑海</small></p></div>
          </div>
        </div>
        <p className="login-footnote">学习不必着急，今天开始就很好。</p>
        <div className="login-orbit login-orbit-one" /><div className="login-orbit login-orbit-two" />
      </section>
      <section className="login-form-side"><form className="login-card" onSubmit={login}>
    <p className="login-form-kicker">FLOW ACCOUNT</p><h2>欢迎回来</h2>
    <p className="login-form-description">输入邮箱，我们会发送一次性验证码。</p>
    <label className="login-label">邮箱地址<input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></label>
    <div className="login-code-row"><label className="login-label">验证码<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={event => setCode(event.target.value)} placeholder="6 位验证码" /></label><button className="login-send-code" type="button" disabled={busy} onClick={() => void sendCode()}>{busy ? '请稍候…' : sent ? '重新发送' : '发送验证码'}</button></div>
    {sent && <p className="doc-muted">验证码已发送，10 分钟内有效。</p>}{error && <p className="doc-error" role="alert">{error}</p>}
    <button className="primary-button login-submit" type="submit" disabled={busy || !sent}>{busy ? '正在登录…' : '登录'}</button>
      </form><p className="login-privacy">登录即表示你可以继续自己的学习旅程。</p></section>
    </div>
  </main>;
}
