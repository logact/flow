import { NextResponse } from 'next/server';
import { sendLoginCode } from '@/lib/server/auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { email?: unknown };
    await sendLoginCode(body.email);
    return NextResponse.json({ sent: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : '验证码发送失败';
    const status = message.includes('频繁') ? 429 : message.includes('SMTP') || message.includes('SECRET') ? 503 : 400;
    return NextResponse.json({ reason: 'code_send_failed', message }, { status });
  }
}
