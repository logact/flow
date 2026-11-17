'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';

export function AuthControl() {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState<string | null>(null);
  useEffect(() => {
    if (pathname === '/login') return;
    void fetch('/api/auth/session', { cache: 'no-store' }).then(response => response.ok ? response.json() : null).then(data => setEmail(data?.user?.email ?? null)).catch(() => setEmail(null));
  }, [pathname]);
  if (!email) return null;
  return <button className="auth-control" type="button" onClick={async () => { await fetch('/api/auth/logout', { method: 'POST' }); router.replace('/login'); }}>退出登录</button>;
}
