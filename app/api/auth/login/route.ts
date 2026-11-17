import { NextResponse } from 'next/server';
import { AUTH_COOKIE, verifyLoginCode } from '@/lib/server/auth';
import { createLearnerUseCase } from '@/lib/application/learner-settings';
import { getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const body = await request.json() as { email?: unknown; code?: unknown };
    const result = verifyLoginCode(body.email, body.code);
    const runtime = getRuntime();
    await runtime.ready;
    if (!runtime.repository.load().state.learners.some(learner => learner.id === result.user.learnerId)) {
      createLearnerUseCase(runtime.repository, { id: result.user.learnerId, timezone: 'Asia/Shanghai', dailyTaskCapacity: 12, now: new Date().toISOString() });
    }
    const response = NextResponse.json({ user: result.user });
    // 生产当前以裸 HTTP 提供服务：按 NODE_ENV 加 Secure 会导致浏览器拒收 cookie，登录态丢失。
    const secure = new URL(request.url).protocol === 'https:';
    response.cookies.set(AUTH_COOKIE, result.token, {
      httpOnly: true, secure, sameSite: 'lax',
      path: '/', expires: new Date(result.expiresAt),
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : '登录失败';
    const status = message.includes('SECRET') ? 503 : 401;
    return NextResponse.json({ reason: 'login_failed', message }, { status });
  }
}
