import { NextResponse } from 'next/server';
import { analyzeMaterial } from '@/lib/domain/functions';
import type { MaterialAnalysisCandidate } from '@/lib/domain/model';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';
import { queuePronunciationEnrichment } from '@/lib/server/pronunciation-enrichment';

export const dynamic = 'force-dynamic';
export const maxDuration = 360;

/** Explicitly resolve selected locally generated candidates; GET pages never invoke the model. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { lemmas?: unknown; analysisId?: unknown; operationId?: unknown } | null;
  if (!Array.isArray(body?.lemmas) || body.lemmas.some((lemma) => typeof lemma !== 'string')
    || typeof body.analysisId !== 'string' || !body.analysisId.trim()
    || typeof body.operationId !== 'string' || !body.operationId.trim() || body.operationId.length > 200) {
    return NextResponse.json({ reason: 'invalid_input', message: 'lemmas, analysisId, and operationId are required' }, { status: 400 });
  }
  const runtime = getRuntime();
  await runtime.ready;
  const learner = await getDemoLearner();
  const { state } = runtime.repository.load();
  const material = state.materials.find((item) => item.id === id && item.learnerId === learner.id);
  const analysis = state.materialAnalyses.filter((item) => item.materialId === id).at(-1);
  if (!material || !analysis) return NextResponse.json({ reason: 'analysis_not_found' }, { status: 404 });
  if (analysis.id !== body.analysisId) return NextResponse.json({ reason: 'analysis_version_conflict', latestAnalysisId: analysis.id }, { status: 409 });
  if (analysis.status !== 'analyzed') return NextResponse.json({ reason: 'analysis_not_ready' }, { status: 409 });
  if (!runtime.llmConfigured) return NextResponse.json({ reason: 'llm_not_configured' }, { status: 503 });

  const requested = new Set(body.lemmas as string[]);
  const candidates: MaterialAnalysisCandidate[] = analysis.candidates ?? [];
  const candidateLemmas = new Set(candidates.map((candidate) => candidate.lemma));
  if ([...requested].some((lemma) => !candidateLemmas.has(lemma))) {
    return NextResponse.json({ reason: 'candidate_not_in_analysis' }, { status: 400 });
  }
  const selected = candidates.filter((candidate) => requested.has(candidate.lemma)
    && (candidate.status === 'pending' || candidate.status === 'failed' || candidate.status === 'processing'));
  const operationId = body.operationId;
  const operationStatus = await runtime.repository.startAnalysisResolution?.(id, analysis.id, operationId, [...requested], new Date().toISOString(), 10 * 60 * 1000) ?? 'started';
  if (operationStatus === 'conflict') return NextResponse.json({ reason: 'operation_id_reused', operationId }, { status: 409 });
  if (operationStatus !== 'started') {
    const latest = runtime.repository.load().state.materialAnalyses.filter((item) => item.materialId === id).at(-1);
    return NextResponse.json({ status: operationStatus, operationId, candidates: latest?.status === 'analyzed' ? latest.candidates ?? [] : analysis.candidates ?? [] });
  }
  const claimed = new Set<string>();
  for (const candidate of selected) {
    const didClaim = runtime.repository.claimAnalysisCandidate
      ? await runtime.repository.claimAnalysisCandidate(id, analysis.id, candidate.lemma, operationId, new Date().toISOString(), 9 * 60 * 1000)
      : true;
    if (didClaim) claimed.add(candidate.lemma);
  }
  const updated = candidates.map((candidate) => claimed.has(candidate.lemma)
    ? { ...candidate, status: 'processing' as const, error: undefined }
    : candidate);
  const busyLemmas = selected.filter((candidate) => !claimed.has(candidate.lemma)).map((candidate) => candidate.lemma);
  if (updated.some((candidate) => candidate.status === 'processing')) {
    // Persist work intent before any provider call. A lost request can be
    // inspected after restart and explicitly retried by submitting its lemma.
    await runtime.repository.saveMaterialAnalysis(id, { ...analysis, candidates: updated });
  }
  const assignments = analysis.items.filter((item) => 'lemma' in item.knowledgePoint).map((item) => ({
    lemma: 'lemma' in item.knowledgePoint ? item.knowledgePoint.lemma : '',
    senseId: item.knowledgePoint.sense.id,
    partOfSpeech: item.knowledgePoint.sense.partOfSpeech,
    definition: item.knowledgePoint.sense.definition,
    chineseMeaning: item.knowledgePoint.sense.chineseMeaning,
    occurrences: item.occurrences,
  }));
  let workingAnalysis = analysis;
  const failures: string[] = [];
  for (const candidate of updated.filter((item) => claimed.has(item.lemma))) {
    const items = candidate.occurrences.map((occurrence, index) => ({
      key: `${candidate.lemma}:${index}`, lemma: candidate.lemma,
      sentence: occurrence.sentence, context: occurrence.context,
      candidates: candidate.candidates,
    }));
    let assignment: typeof assignments[number] | null = null;
    try {
      const picks = await runtime.senseDisambiguator.disambiguate(items);
      const valid = picks.filter((pick) => items.some((item) => item.key === pick.key && item.candidates.some((sense) => sense.id === pick.senseId)));
      const counts = new Map<string, number>();
      for (const pick of valid) counts.set(pick.senseId, (counts.get(pick.senseId) ?? 0) + 1);
      const senseId = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      const sense = candidate.candidates.find((item) => item.id === senseId);
      if (!sense) throw new Error('No valid sense returned');
      assignment = { lemma: candidate.lemma, senseId: sense.id, partOfSpeech: sense.pos, definition: sense.gloss, chineseMeaning: null, occurrences: candidate.occurrences };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(candidate.lemma);
      const target = updated.find((item) => item.lemma === candidate.lemma)!;
      target.status = 'failed';
      target.error = message;
      workingAnalysis = { ...workingAnalysis, candidates: updated };
      await runtime.repository.saveMaterialAnalysis(id, workingAnalysis);
      await runtime.repository.finishAnalysisCandidate?.(id, analysis.id, candidate.lemma, operationId, 'failed', new Date().toISOString());
      continue;
    }
    if (assignment) assignments.push(assignment);
    const target = updated.find((item) => item.lemma === candidate.lemma)!;
    target.status = 'resolved';
    const resolved = analyzeMaterial({ analysisId: analysis.id, material, analyzerVersion: analysis.analyzerVersion, now: new Date().toISOString(), assignments, excludedTerms: analysis.unmatchedItems.filter((item): item is typeof item & { lemma: string } => Boolean(item.lemma)).map((item) => ({ lemma: item.lemma, reason: item.reason, occurrences: item.occurrences })) });
    resolved.createdAt = analysis.createdAt;
    resolved.completedAt = analysis.completedAt;
    resolved.candidates = updated;
    await runtime.repository.saveMaterialWithAnalysis(material, resolved);
    workingAnalysis = resolved;
    await runtime.repository.finishAnalysisCandidate?.(id, analysis.id, candidate.lemma, operationId, 'resolved', new Date().toISOString());
    const resolvedItem = resolved.items.find((item) => 'lemma' in item.knowledgePoint && item.knowledgePoint.lemma === candidate.lemma);
    if (resolvedItem && !resolvedItem.knowledgePoint.sense.chineseMeaning?.trim()) {
      const meaningOperationId = crypto.randomUUID();
      const meaningClaimed = await runtime.repository.claimChineseMeaning?.(resolvedItem.knowledgePoint.id, meaningOperationId, new Date().toISOString(), 10 * 60 * 1000) ?? true;
      if (!meaningClaimed) continue;
      const latestBeforeMeaning = runtime.repository.load().state.materialAnalyses.filter(item => item.materialId === id).at(-1);
      const meaningBase = latestBeforeMeaning?.status === 'analyzed' ? latestBeforeMeaning : resolved;
      const latestPoint = meaningBase.items.find(item => item.knowledgePoint.id === resolvedItem.knowledgePoint.id)?.knowledgePoint ?? resolvedItem.knowledgePoint;
      const point = { ...latestPoint, sense: { ...latestPoint.sense, chineseMeaningStatus: 'processing' as const, chineseMeaningError: null } };
      const processing = { ...meaningBase, items: meaningBase.items.map(item => item.knowledgePoint.id === point.id ? { ...item, knowledgePoint: point } : item) };
      await runtime.repository.saveMaterialWithAnalysis(material, processing);
      let completed = false;
      try {
        const meaning = await runtime.translateSenseMeaning(point.sense.id, point.sense.definition);
        if (!meaning?.trim()) throw new Error('中文释义服务未返回结果');
        const enriched = { ...point, sense: { ...point.sense, chineseMeaning: meaning.trim(), chineseMeaningStatus: 'complete' as const, chineseMeaningError: null } };
        const latest = runtime.repository.load().state.materialAnalyses.filter(item => item.materialId === id).at(-1);
        const base = latest?.status === 'analyzed' ? latest : processing;
        workingAnalysis = { ...base, items: base.items.map(item => item.knowledgePoint.id === point.id ? { ...item, knowledgePoint: enriched } : item) };
        completed = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const failed = { ...point, sense: { ...point.sense, chineseMeaningStatus: 'failed' as const, chineseMeaningError: message } };
        const latest = runtime.repository.load().state.materialAnalyses.filter(item => item.materialId === id).at(-1);
        const base = latest?.status === 'analyzed' ? latest : processing;
        workingAnalysis = { ...base, items: base.items.map(item => item.knowledgePoint.id === point.id ? { ...item, knowledgePoint: failed } : item) };
      }
      await runtime.repository.saveMaterialWithAnalysis(material, workingAnalysis);
      await runtime.repository.finishChineseMeaning?.(point.id, meaningOperationId, completed ? 'complete' : 'failed', new Date().toISOString());
    }
  }
  const next = analyzeMaterial({ analysisId: analysis.id, material, analyzerVersion: analysis.analyzerVersion, now: new Date().toISOString(), assignments, excludedTerms: analysis.unmatchedItems.filter((item): item is typeof item & { lemma: string } => Boolean(item.lemma)).map((item) => ({ lemma: item.lemma, reason: item.reason, occurrences: item.occurrences })) });
  next.createdAt = analysis.createdAt;
  next.completedAt = analysis.completedAt;
  next.candidates = updated;
  const latestPersisted = runtime.repository.load().state.materialAnalyses.filter(item => item.materialId === id).at(-1);
  const enrichedById = new Map((latestPersisted?.status === 'analyzed' ? latestPersisted.items : workingAnalysis.items).map(item => [item.knowledgePoint.id, item.knowledgePoint]));
  next.items = next.items.map(item => {
    const existing = enrichedById.get(item.knowledgePoint.id);
    return existing ? { ...item, knowledgePoint: { ...item.knowledgePoint, sense: existing.sense, pronunciation: existing.pronunciation, pronunciationStatus: existing.pronunciationStatus } } : item;
  });
  await runtime.repository.saveMaterialWithAnalysis(material, next);
  queuePronunciationEnrichment(runtime, next.items.map((item) => item.knowledgePoint.id));
  const resolutionStatus = failures.length || busyLemmas.length ? 'failed' : 'complete';
  await runtime.repository.finishAnalysisResolution?.(analysis.id, operationId, resolutionStatus, new Date().toISOString());
  return NextResponse.json({ status: failures.length ? 'partial' : busyLemmas.length ? 'processing' : 'resolved', resolvedCount: updated.filter((item) => item.status === 'resolved').length, failedLemmas: failures, processingLemmas: busyLemmas, operationId, candidates: updated });
}
