import { lookupPronunciationNow, queuePronunciationEnrichment } from '../lib/server/pronunciation-enrichment';
import type { FlowRuntime } from '../lib/server/runtime';
import type { KnowledgePoint, PronunciationMetadata } from '../lib/domain/model';

const point: KnowledgePoint = {
  id: 'kp-word', kind: 'word', lemma: 'resilient', wordFamily: 'resilient',
  sense: { id: 'sense-1', definition: 'able to recover', chineseMeaning: null, partOfSpeech: 'adjective', explanation: null },
  pronunciationStatus: 'pending', pronunciation: null,
};

function runtime(lookup: FlowRuntime['pronunciationLookup'], points:KnowledgePoint[]=[point]): FlowRuntime {
  let snapshot: any = { state: { knowledgePoints: points }, revision: 0 };
  return {
    repository: {
      load: () => snapshot,
      save: (state: any, expected: number) => {
        if (snapshot.revision !== expected) throw new Error('revision conflict');
        snapshot = { state, revision: expected + 1 };
        return snapshot;
      },
    },
    pronunciationLookup: lookup,
  } as unknown as FlowRuntime;
}

describe('detached pronunciation enrichment', () => {
  test('starts without waiting, deduplicates in-process, and persists success', async () => {
    let finish!: (value: Awaited<ReturnType<FlowRuntime['pronunciationLookup']>>) => void;
    const lookup = jest.fn(() => new Promise<Awaited<ReturnType<FlowRuntime['pronunciationLookup']>>>((resolve) => { finish = resolve; }));
    const app = runtime(lookup);
    queuePronunciationEnrichment(app, ['kp-word']);
    queuePronunciationEnrichment(app, ['kp-word']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(app.repository.load().state.knowledgePoints[0].pronunciationStatus).toBe('processing');
    finish({ ipa: '/rɪˈzɪliənt/', audioUrl: null, source: 'test', sourceUrl: 'https://example.test', queriedAt: new Date().toISOString() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.repository.load().state.knowledgePoints[0].pronunciationStatus).toBe('complete');
  });

  test('persists lookup failures without changing analysis state', async () => {
    const app = runtime(async () => { throw new Error('dictionary offline'); });
    queuePronunciationEnrichment(app, ['kp-word']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(app.repository.load().state.knowledgePoints[0].pronunciationStatus).toBe('failed');
  });

  test('keeps no-match failures retryable and preserves pronunciation data', async () => {
    const metadata = { ipa: '/rɪˈzɪliənt/', audioUrl: null, source: 'test', sourceUrl: 'https://example.test', queriedAt: new Date().toISOString() };
    const lookup = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(metadata);
    const app = runtime(lookup);
    expect(await lookupPronunciationNow(app, 'kp-word')).toMatchObject({ status: 'failed', pronunciation: null });
    expect(await lookupPronunciationNow(app, 'kp-word')).toMatchObject({ status: 'complete', pronunciation: metadata });
    expect(app.repository.load().state.knowledgePoints[0]).toMatchObject({ pronunciationStatus: 'complete', pronunciation: metadata });
  });

  test('limits automatic dictionary concurrency to three knowledge points', async () => {
    const points=[point,...Array.from({length:4},(_,index)=>({...point,id:`kp-${index}`,lemma:`word-${index}`}))];
    let running=0;let maximum=0;const completions:Array<(value:PronunciationMetadata|null)=>void>=[];
    const lookup=jest.fn(()=>new Promise<PronunciationMetadata|null>((resolve)=>{running+=1;maximum=Math.max(maximum,running);completions.push(value=>{running-=1;resolve(value);});}));
    const app=runtime(lookup,points);
    queuePronunciationEnrichment(app,points.map(item=>item.id));
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(maximum).toBe(3);
    completions[0](null);
    await new Promise((resolve)=>setTimeout(resolve,0));
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(maximum).toBe(3);
    for(const complete of completions.slice(1))complete(null);
    await new Promise((resolve)=>setTimeout(resolve,0));
  });
});
