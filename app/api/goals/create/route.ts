import { NextResponse } from 'next/server';
import { createHash } from 'node:crypto';
import type { FluencyScores, GoalKnowledgePointSelection } from '@/lib/domain/model';
import { createGoalFromMaterialsUseCase } from '@/lib/application/create-goal-from-materials';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';
import { POST as resolveMaterialCandidates } from '@/app/api/materials/[id]/analysis/resolve/route';

export const dynamic = 'force-dynamic';

const recentRequests = new Map<string, { expiresAt: number; promise: Promise<unknown> }>();
function conflictsFor(runtime: ReturnType<typeof getRuntime>, materialIds: string[]) {
  const state = runtime.repository.load().state;
  return materialIds.flatMap(materialId => {
    const material = state.materials.find(item => item.id === materialId);
    const goals = state.goalMaterials.filter(link => link.materialId === materialId).map(link => state.goals.find(goal => goal.id === link.goalId)).filter(Boolean);
    return goals.length ? [{ materialId, materialTitle: material?.title ?? materialId, goals: goals.map(goal => ({ id: goal!.id, title: goal!.title })) }] : [];
  });
}
export async function GET(request: Request) {
  const runtime = getRuntime(); await runtime.ready;
  const ids = new URL(request.url).searchParams.getAll('materialId');
  return NextResponse.json({ conflicts: conflictsFor(runtime, ids) });
}

/** 创建目标的 S05/S06 编排入口，支持多材料并以稳定 goalId 安全重试。 */
export async function POST(request: Request) {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const body = (await request.json().catch(() => null)) as {
    requestId?: string;
    confirmedMaterialConflicts?: boolean;
    title?: string;
    targetFluency?: FluencyScores;
    materials?: Array<{ materialId: string; analysisId: string }>;
    selections?: Array<{ knowledgePointId: string; selection: GoalKnowledgePointSelection }>;
    selectedCandidates?: Array<{ materialId: string; lemma: string }>;
  } | null;
  if (!body || typeof body.requestId !== 'string' || !body.requestId.trim()
    || typeof body.title !== 'string' || !body.title.trim()
    || !body.targetFluency || !Array.isArray(body.materials)
    || !Array.isArray(body.selections)) {
    return NextResponse.json({ reason: 'invalid_input' }, { status: 400 });
  }

  const validBody = body as {
    requestId: string; confirmedMaterialConflicts?: boolean; title: string;
    targetFluency: FluencyScores; materials: Array<{materialId:string;analysisId:string}>;
    selections: Array<{knowledgePointId:string;selection:GoalKnowledgePointSelection}>;
    selectedCandidates?: Array<{materialId:string;lemma:string}>;
  };

  for (const [key, value] of recentRequests) if (value.expiresAt < Date.now()) recentRequests.delete(key);
  const requestKey = `${learner.id}:${validBody.requestId}`;
  const previous = recentRequests.get(requestKey);
  if (previous) {
    const cached = await previous.promise;
    if (typeof cached === 'object' && cached !== null && 'status' in cached) {
      const failure = cached as { reason: string; status: number };
      return NextResponse.json({ reason: failure.reason }, { status: failure.status });
    }
    return NextResponse.json(cached);
  }
  const conflicts = conflictsFor(runtime, validBody.materials.map(item => item.materialId));
  if (conflicts.length && validBody.confirmedMaterialConflicts !== true) return NextResponse.json({ reason: 'material_conflicts', conflicts }, { status: 409 });

  const promise = (async () => {
  const selectedMaterialIds = new Set(validBody.materials.map((item) => item.materialId));
  const selectedCandidates = validBody.selectedCandidates ?? [];
  if (selectedCandidates.some((candidate) => !selectedMaterialIds.has(candidate.materialId) || !candidate.lemma.trim())) {
    return { reason: 'candidate_not_in_selected_materials', status: 400 };
  }
  const grouped = new Map<string, string[]>();
  for (const candidate of selectedCandidates) {
    const lemmas = grouped.get(candidate.materialId) ?? [];
    if (!lemmas.includes(candidate.lemma)) lemmas.push(candidate.lemma);
    grouped.set(candidate.materialId, lemmas);
  }
  for (const [materialId, lemmas] of grouped) {
    const currentState = runtime.repository.load().state;
    const ownedMaterial = currentState.materials.find((item) => item.id === materialId && item.learnerId === learner.id);
    const currentAnalysis = currentState.materialAnalyses.filter((item) => item.materialId === materialId).at(-1);
    const requestedAnalysisId = validBody.materials.find((item) => item.materialId === materialId)?.analysisId;
    if (!ownedMaterial || !currentAnalysis || currentAnalysis.id !== requestedAnalysisId) {
      return { reason: 'candidate_not_in_selected_analysis', status: 409 };
    }
    const response = await resolveMaterialCandidates(new Request(new URL(`/api/materials/${materialId}/analysis/resolve`, request.url), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lemmas }),
    }), { params: Promise.resolve({ id: materialId }) });
    if (!response.ok) {
      const failure = await response.json().catch(() => ({})) as { reason?: string };
      return { reason: failure.reason ?? 'candidate_resolution_failed', status: response.status };
    }
    const state = runtime.repository.load().state;
    const analysis = state.materialAnalyses.filter((item) => item.materialId === materialId).at(-1);
    if (!analysis || analysis.status !== 'analyzed') return { reason: 'analysis_not_ready', status: 409 };
    for (const lemma of lemmas) {
      if (analysis.candidates?.find((candidate) => candidate.lemma === lemma)?.status === 'failed') {
        return { reason: 'candidate_resolution_failed', status: 502 };
      }
      for (const item of analysis.items) {
        if ('lemma' in item.knowledgePoint && item.knowledgePoint.lemma === lemma) {
          validBody.selections.push({ knowledgePointId: item.knowledgePoint.id, selection: 'included' });
        }
      }
    }
  }
  const result = await createGoalFromMaterialsUseCase(
    { repository: runtime.repository, vocabularyIndex: runtime.vocabularyIndex },
    {
      // Stable across process restarts: retrying the same learner/requestId
      // reuses the same goal instead of relying only on recentRequests memory.
      goalId: `goal:${createHash('sha256').update(`${learner.id}:${validBody.requestId}`).digest('hex').slice(0, 32)}`,
      learnerId: learner.id,
      title: validBody.title.trim(),
      targetFluency: validBody.targetFluency,
      materials: validBody.materials,
      selections: validBody.selections,
      now: new Date().toISOString(),
    },
  );
  if (!result.ok) {
    const status = result.reason === 'learner_not_found' ? 404 : 400;
    return { reason: result.reason, status };
  }
  return {
    goal: result.goal,
    candidateCount: result.candidateCount,
    initializedCount: result.initializedCount,
  };
  })();
  recentRequests.set(requestKey, { expiresAt: Date.now() + 10 * 60_000, promise });
  const result = await promise;
  if ('status' in result) return NextResponse.json({ reason: result.reason }, { status: result.status });
  return NextResponse.json(result);
}
