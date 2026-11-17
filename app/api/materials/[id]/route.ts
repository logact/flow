import { NextResponse } from 'next/server';
import { knowledgePointName } from '@/lib/domain/functions';
import { getDemoLearner, getRuntime } from '@/lib/server/runtime';
import { queuePronunciationEnrichment } from '@/lib/server/pronunciation-enrichment';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runtime = getRuntime(); await runtime.ready;
  const learner = await getDemoLearner();
  const state = runtime.repository.load().state;
  const material = state.materials.find(item => item.id === id && item.learnerId === learner.id);
  if (!material) return NextResponse.json({ reason: 'material_not_found' }, { status: 404 });
  const materialView = { id: material.id, title: material.title, filename: material.filename, format: material.format, createdAt: material.createdAt, archivedAt: material.archivedAt ?? null };
  const analysis = state.materialAnalyses.filter(item => item.materialId === id).at(-1);
  if (!analysis) return NextResponse.json({ material: materialView, analysis: null });
  if (analysis.status === 'analyzed') queuePronunciationEnrichment(runtime, analysis.items.filter(({ knowledgePoint }) => knowledgePoint.pronunciationStatus === 'pending' || knowledgePoint.pronunciationStatus === 'processing' || knowledgePoint.pronunciationStatus === undefined).map(({ knowledgePoint }) => knowledgePoint.id));
  return NextResponse.json({ material: materialView, analysis: {
    id: analysis.id, status: analysis.status, createdAt: analysis.createdAt,
    progress: analysis.status === 'analyzed' ? null : analysis.progress ?? null, errors: analysis.errors,
    items: analysis.items.map(item => ({ knowledgePointId: item.knowledgePoint.id, lemma: knowledgePointName(item.knowledgePoint), definition: item.knowledgePoint.sense.definition, chineseMeaning: item.knowledgePoint.sense.chineseMeaning ?? null, chineseMeaningStatus: item.knowledgePoint.sense.chineseMeaningStatus ?? (item.knowledgePoint.sense.chineseMeaning ? 'complete' : 'pending'), chineseMeaningError: item.knowledgePoint.sense.chineseMeaningError ?? null, partOfSpeech: item.knowledgePoint.sense.partOfSpeech, occurrenceCount: item.occurrences.length })),
    candidates: analysis.status === 'analyzed' ? analysis.candidates ?? [] : [],
  } });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json().catch(() => null) as { archived?: unknown } | null;
  if (typeof body?.archived !== 'boolean') return NextResponse.json({ reason: 'invalid_input', message: 'archived 必须是布尔值' }, { status: 400 });
  const runtime = getRuntime(); await runtime.ready;
  const learner = await getDemoLearner();
  const { state, revision } = runtime.repository.load();
  const material = state.materials.find(item => item.id === id && item.learnerId === learner.id);
  if (!material) return NextResponse.json({ reason: 'material_not_found' }, { status: 404 });
  const updated = { ...material, archivedAt: body.archived ? new Date().toISOString() : null };
  runtime.repository.save({ ...state, materials: state.materials.map(item => item.id === id ? updated : item) }, revision);
  return NextResponse.json({ material: { id: updated.id, archivedAt: updated.archivedAt } });
}
