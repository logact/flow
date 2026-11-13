'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

/** 非 Feed 页面的统一外壳：顶部返回栏 + 可滚动内容区 + 底部导航。 */
export function PageShell({ title, children }: { title: string; children: ReactNode }) {
  const router = useRouter();
  return (
    <div className="doc-shell">
      <header className="doc-topbar">
        <button className="text-button" onClick={() => router.back()} aria-label="返回">← 返回</button>
        <h1>{title}</h1>
        <button className="text-button" onClick={() => router.push('/')}>首页</button>
      </header>
      <main className="doc-body">{children}</main>
      <nav className="bottom-nav" aria-label="主导航">
        <button className="nav-item" onClick={() => router.push('/')}>首页</button>
        <button className="nav-item" onClick={() => router.push('/materials')}>词库</button>
        <button className="create-button" onClick={() => router.push('/materials')} aria-label="导入学习材料"><span>＋</span></button>
        <button className="nav-item" onClick={() => router.push('/goals')}>目标</button>
        <button className="nav-item" onClick={() => router.push('/me')}>我</button>
      </nav>
    </div>
  );
}
