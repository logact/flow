import type { FlowRuntime } from './runtime';
import type { KnowledgePoint } from '../domain/model';

const active = new Set<string>();
const MAX_CONCURRENT_LOOKUPS = 3;
let runningLookups = 0;
const waitingLookups: Array<() => void> = [];

function acquireLookupSlot(): boolean {
  if (runningLookups >= MAX_CONCURRENT_LOOKUPS) return false;
  runningLookups += 1;
  return true;
}

async function waitForLookupSlot(): Promise<void> {
  await new Promise<void>((resolve) => waitingLookups.push(resolve));
}

function releaseLookupSlot(): void {
  const next = waitingLookups.shift();
  if (next) next();
  else runningLookups = Math.max(0, runningLookups - 1);
}

function savePoint(runtime: FlowRuntime, pointId: string, update: (point: KnowledgePoint) => KnowledgePoint): KnowledgePoint | null {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = runtime.repository.load();
    const point = snapshot.state.knowledgePoints.find((item) => item.id === pointId);
    if (!point) return null;
    try {
      runtime.repository.save({
        ...snapshot.state,
        knowledgePoints: snapshot.state.knowledgePoints.map((item) => item.id === pointId ? update(item) : item),
      }, snapshot.revision);
      return point;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }
  return null;
}

export async function lookupPronunciationNow(runtime: FlowRuntime, id: string): Promise<{ pronunciation: Awaited<ReturnType<FlowRuntime['pronunciationLookup']>>; status: 'complete' | 'failed' | 'processing' }> {
  const current=runtime.repository.load().state.knowledgePoints.find((item)=>item.id===id);
  if(current?.pronunciationStatus==='complete')return {pronunciation:current.pronunciation??null,status:'complete'};
  if (active.has(id)) return { pronunciation: null, status: 'processing' };
  active.add(id);
  const operationId = crypto.randomUUID();
  let claimed = false;
  let acquired = false;
  try {
    acquired = acquireLookupSlot();
    if(!acquired){await waitForLookupSlot();acquired=true;}
    const claim = runtime.repository.claimPronunciation?.(id, operationId, new Date().toISOString(), 30 * 1000);
    claimed = claim === undefined ? true : typeof claim === 'boolean' ? claim : await claim;
    if (!claimed) return { pronunciation: null, status: 'processing' };
    const point = savePoint(runtime, id, (item) => ({ ...item, pronunciationStatus: 'processing' }));
    if (!point || (point.kind !== 'word' && point.kind !== 'phrase')) return { pronunciation: null, status: 'failed' };
    const pronunciation = await runtime.pronunciationLookup(point.lemma, point.sense.partOfSpeech);
    const status = pronunciation ? 'complete' : 'failed';
    savePoint(runtime, id, (item) => ({ ...item, pronunciation: pronunciation ?? item.pronunciation ?? null, pronunciationStatus: status }));
    try { await runtime.repository.finishPronunciation?.(id, operationId, status, new Date().toISOString()); } catch { /* The persisted point status remains authoritative. */ }
    return { pronunciation, status };
  } catch {
    try { savePoint(runtime, id, (item) => ({ ...item, pronunciationStatus: 'failed' })); } catch { /* Lease expiry allows recovery. */ }
    if (claimed) { try { await runtime.repository.finishPronunciation?.(id, operationId, 'failed', new Date().toISOString()); } catch { /* Lease expiry allows recovery. */ } }
    return { pronunciation: null, status: 'failed' };
  } finally {
    active.delete(id);
    if (acquired) releaseLookupSlot();
  }
}

/** Detached, per-knowledge-point pronunciation enrichment. Analysis never waits for this work. */
export function queuePronunciationEnrichment(runtime: FlowRuntime, pointIds: string[]): void {
  for (const id of new Set(pointIds)) {
    if (active.has(id)) continue;
    let snapshot: ReturnType<FlowRuntime['repository']['load']>;
    try { snapshot = runtime.repository.load(); } catch { continue; }
    const point = snapshot.state.knowledgePoints.find((item) => item.id === id);
    if (!point || (point.kind !== 'word' && point.kind !== 'phrase') || point.pronunciationStatus === 'complete' || point.pronunciation || point.pronunciationStatus === 'failed') continue;
    void lookupPronunciationNow(runtime, id).catch(() => undefined);
  }
}
