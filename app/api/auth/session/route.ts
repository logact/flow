import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { AUTH_COOKIE, getAuthenticatedUser } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export async function GET() {
  const cookieStore = await cookies();
  const user = getAuthenticatedUser(cookieStore.get(AUTH_COOKIE)?.value);
  return user ? NextResponse.json({ user }) : NextResponse.json({ user: null }, { status: 401 });
}
