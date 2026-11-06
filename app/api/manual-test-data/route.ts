import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { MANUAL_TEST_SCENARIOS, resetManualTestFixture, type ManualTestScenario } from '@/lib/manual-test-fixtures';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function enabled() {
  return process.env.NODE_ENV === 'development' && process.env.FLOW_MANUAL_TEST_MODE === '1';
}

export async function GET() {
  if (!enabled()) return new NextResponse(null, { status: 404 });
  return NextResponse.json({ scenarios: MANUAL_TEST_SCENARIOS });
}

export async function POST(request: Request) {
  if (!enabled()) return new NextResponse(null, { status: 404 });
  try {
    const body = await request.json() as { scenario?: unknown };
    if (typeof body.scenario !== 'string' ||
        !MANUAL_TEST_SCENARIOS.some((item) => item.id === body.scenario)) {
      return NextResponse.json({ error: '请选择有效的测试场景' }, { status: 400 });
    }
    const fixture = resetManualTestFixture(getDb(), body.scenario as ManualTestScenario);
    return NextResponse.json({ ok: true, fixture });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
