import { NextResponse } from 'next/server';
import { analyzeMaterial } from '@/lib/domain/functions';
import type { MaterialAnalysisCandidate } from '@/lib/domain/model';
import { getRuntime } from '@/lib/server/runtime';

export const dynamic = 'force-dynamic';
const resolvingMaterials = new Set<string>();

/** Explicitly resolve selected locally generated candidates; GET pages never invoke the model. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { lemmas?: unknown } | null;
  if (!Array.isArray(body?.lemmas) || body.lemmas.some((lemma) => typeof lemma !== 'string')) {
    return NextResponse.json({ reason: 'invalid_input', message: 'lemmas must be a string array' }, { status: 400 });
  }
  const runtime = getRuntime();
  await runtime.ready;
  const { state } = runtime.repository.load();
  const material = state.materials.find((item) => item.id === id);
  const analysis = state.materialAnalyses.filter((item) => item.materialId === id).at(-1);
  if (!material || !analysis) return NextResponse.json({ reason: 'analysis_not_found' }, { status: 404 });
  if (analysis.status !== 'analyzed') return NextResponse.json({ reason: 'analysis_not_ready' }, { status: 409 });
  if (!runtime.llmConfigured) return NextResponse.json({ reason: 'llm_not_configured' }, { status: 503 });

  if (resolvingMaterials.has(id)) return NextResponse.json({ reason: 'resolution_in_progress' }, { status: 409 });
  resolvingMaterials.add(id);
  try {
  const requested = new Set(body.lemmas as string[]);
  const candidates: MaterialAnalysisCandidate[] = analysis.candidates ?? [];
  const candidateLemmas = new Set(candidates.map((candidate) => candidate.lemma));
  if ([...requested].some((lemma) => !candidateLemmas.has(lemma))) {
    return NextResponse.json({ reason: 'candidate_not_in_analysis' }, { status: 400 });
  }
  const updated = candidates.map((candidate) => requested.has(candidate.lemma)
    && (candidate.status === 'pending' || candidate.status === 'failed' || candidate.status === 'processing')
    ? { ...candidate, status: 'processing' as const, error: undefined }
    : candidate);
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
  const failures: string[] = [];
  for (const candidate of updated.filter((item) => item.status === 'processing')) {
    const items = candidate.occurrences.map((occurrence, index) => ({
      key: `${candidate.lemma}:${index}`, lemma: candidate.lemma,
      sentence: occurrence.sentence, context: occurrence.context,
      candidates: candidate.candidates,
    }));
    try {
      const picks = await runtime.senseDisambiguator.disambiguate(items);
      const valid = picks.filter((pick) => items.some((item) => item.key === pick.key && item.candidates.some((sense) => sense.id === pick.senseId)));
      const counts = new Map<string, number>();
      for (const pick of valid) counts.set(pick.senseId, (counts.get(pick.senseId) ?? 0) + 1);
      const senseId = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
      const sense = candidate.candidates.find((item) => item.id === senseId);
      if (!sense) throw new Error('No valid sense returned');
      const translated = await runtime.translateSenseMeaning(sense.id, sense.gloss);
      assignments.push({ lemma: candidate.lemma, senseId: sense.id, partOfSpeech: sense.pos, definition: sense.gloss, chineseMeaning: translated, occurrences: candidate.occurrences });
      const target = updated.find((item) => item.lemma === candidate.lemma)!;
      target.status = 'resolved';
      await runtime.repository.saveMaterialAnalysis(id, { ...analysis, candidates: updated });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(candidate.lemma);
      const target = updated.find((item) => item.lemma === candidate.lemma)!;
      target.status = 'failed';
      target.error = message;
      await runtime.repository.saveMaterialAnalysis(id, { ...analysis, candidates: updated });
    }
  }
  const next = analyzeMaterial({ analysisId: analysis.id, material, analyzerVersion: analysis.analyzerVersion, now: new Date().toISOString(), assignments, excludedTerms: analysis.unmatchedItems.filter((item): item is typeof item & { lemma: string } => Boolean(item.lemma)).map((item) => ({ lemma: item.lemma, reason: item.reason, occurrences: item.occurrences })) });
  next.candidates = updated;
  await runtime.repository.saveMaterialWithAnalysis(material, next);
  return NextResponse.json({ status: failures.length ? 'partial' : 'resolved', resolvedCount: updated.filter((item) => item.status === 'resolved').length, failedLemmas: failures, candidates: updated });
  } finally {
    resolvingMaterials.delete(id);
  }
}
