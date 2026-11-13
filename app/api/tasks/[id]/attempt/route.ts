import { NextResponse } from 'next/server';
import { receiveTaskAttempt } from '@/lib/application/receive-task-attempt';
import { settleAndRefreshPlan } from '@/lib/application/settle-and-refresh-plan';
import { ConcurrencyConflictError } from '@/lib/application/repository';
import type { AttemptValidity, TaskSubmission } from '@/lib/domain/model';
import { getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';

/**
 * 提交任务作答（S10 接收 → R2 评判结算 + 刷新计划）。
 * 请求体：{ submission, validity: { elapsedMs, interrupted }, attemptId? }
 * attemptId 作为幂等键，重试时保持不变即可安全重放。
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const runtime = getRuntime();
  await runtime.ready;
  const { id: taskId } = await params;
  const body = (await request.json().catch(() => null)) as {
    submission?: TaskSubmission;
    validity?: AttemptValidity;
    attemptId?: string;
  } | null;
  if (!body?.submission || !body.validity || !(body.validity.elapsedMs > 0)) {
    return NextResponse.json(
      { reason: 'invalid_input', message: '需要 submission 与 validity.elapsedMs > 0' },
      { status: 400 },
    );
  }

  const now = new Date().toISOString();
  const attemptId = body.attemptId?.trim() || crypto.randomUUID();

  try {
    let effectiveAttemptId = attemptId;
    try {
      const attempt = receiveTaskAttempt(runtime.repository, {
        attemptId,
        taskId,
        submission: body.submission,
        validity: { elapsedMs: Math.round(body.validity.elapsedMs), interrupted: Boolean(body.validity.interrupted) },
        receivedAt: now,
      });
      if (attempt.status !== 'received' && attempt.status !== 'judging') {
        return NextResponse.json({ attemptId: attempt.id, status: attempt.status, statusReason: attempt.statusReason });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // 任务已有作答（例如上次评判失败后保留的 judging 记录）：续用原作答完成评判，
      // 原始答案不会被替换，符合 S10/S11 的保留语义。
      const existing = message.includes('Attempt ID and task ID must be unique')
        ? runtime.repository.load().state.attempts.find((item) => item.taskId === taskId)
        : undefined;
      if (!existing) {
        return NextResponse.json({ reason: 'invalid_input', message }, { status: 400 });
      }
      effectiveAttemptId = existing.id;
      if (existing.status === 'settled') {
        return NextResponse.json({
          attemptId: existing.id,
          status: existing.status,
          feedback: existing.judgement.feedback,
          judgement: { judgedBy: existing.judgement.judgedBy, dimensions: existing.judgement.dimensions },
          settlement: { settledAt: existing.settlement.settledAt, fluencyChanges: existing.settlement.fluencyChanges },
          refresh: { reason: 'already_settled' },
        });
      }
      if (existing.status !== 'received' && existing.status !== 'judging') {
        return NextResponse.json({ attemptId: existing.id, status: existing.status, statusReason: existing.statusReason });
      }
    }

    // AI 评判可能因模型输出瑕疵（如 taskId 抄写偏差）失败；作答保留在 judging 状态，
    // 按应用层约定由调用方重试，这里最多重试 2 次。
    let settled: Awaited<ReturnType<typeof settleAndRefreshPlan>> | undefined;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3 && !settled; attempt++) {
      try {
        settled = await settleAndRefreshPlan(
          {
            repository: runtime.repository,
            aiJudge: runtime.aiJudge,
            taskRepository: runtime.repository,
            aiProvider: runtime.taskGenerationProvider,
          },
          { attemptId: effectiveAttemptId, judgedAt: now, now },
        );
      } catch (error) {
        lastError = error;
      }
    }
    if (!settled) throw lastError;

    const state = runtime.repository.load().state;
    const settledAttempt = state.attempts.find((item) => item.id === effectiveAttemptId);
    return NextResponse.json({
      attemptId: effectiveAttemptId,
      status: settledAttempt?.status ?? 'settled',
      feedback: settled.feedback,
      judgement: settledAttempt && settledAttempt.status === 'settled'
        ? {
            judgedBy: settledAttempt.judgement.judgedBy,
            dimensions: settledAttempt.judgement.dimensions,
          }
        : null,
      settlement: {
        settledAt: settled.settlement.settledAt,
        fluencyChanges: settled.settlement.fluencyChanges,
      },
      refresh: settled.refresh.ok ? { plan: settled.refresh.plan, tasks: settled.refresh.tasks } : { reason: settled.refresh.reason },
    });
  } catch (error) {
    if (error instanceof ConcurrencyConflictError) {
      return NextResponse.json({ reason: 'concurrency_conflict' }, { status: 409 });
    }
    return NextResponse.json(
      { reason: 'judge_failed', message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
