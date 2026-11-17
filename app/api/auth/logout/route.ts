import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { AUTH_COOKIE, revokeSession } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export async function POST() {
  const cookieStore = await cookies();
  revokeSession(cookieStore.get(AUTH_COOKIE)?.value);
  const response = NextResponse.json({ loggedOut: true });
  response.cookies.set(AUTH_COOKIE, '', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 0 });
  return response;
}
