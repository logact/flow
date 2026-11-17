import { NextRequest, NextResponse } from 'next/server';
import { AUTH_COOKIE, getAuthenticatedUser } from './lib/server/auth';

const PUBLIC_PATHS = new Set(['/login']);

export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (PUBLIC_PATHS.has(path) || path.startsWith('/api/auth/')) return NextResponse.next();
  const user = getAuthenticatedUser(request.cookies.get(AUTH_COOKIE)?.value);
  if (path.startsWith('/api/')) {
    if (!user) return NextResponse.json({ reason: 'unauthorized', message: '请先登录' }, { status: 401 });
    return NextResponse.next();
  }
  if (!user) {
    const url = new URL('/login', request.url);
    url.searchParams.set('next', `${path}${request.nextUrl.search}`);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
