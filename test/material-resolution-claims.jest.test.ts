import { emptyLearningState, InMemoryAppRepository } from '../lib/server/memory-repository';

describe('memory operation coordination contract', () => {
  test('material analysis persistence also upserts its knowledge points for pronunciation jobs', async () => {
    const repository = new InMemoryAppRepository(emptyLearningState());
    const material:any={id:'m',learnerId:'l',title:'t',filename:'t.txt',format:'txt',mimeType:'text/plain',checksum:'x',storageKey:null,extractedText:'run',extractionMetadata:{},createdAt:'now'};
    const point:any={id:'kp-run',kind:'word',lemma:'run',wordFamily:'run',sense:{id:'s',definition:'move fast',partOfSpeech:'verb',explanation:null}};
    const analysis:any={id:'a',materialId:'m',analyzerVersion:'test',createdAt:'now',status:'analyzed',items:[{knowledgePoint:point,occurrences:[]}],unmatchedItems:[],errors:[],completedAt:'now',candidates:[]};
    await repository.saveMaterialWithAnalysis(material,analysis);
    expect(repository.load().state.knowledgePoints).toEqual([point]);
    await repository.saveMaterialWithAnalysis(material,{...analysis,items:[{knowledgePoint:{...point,pronunciationStatus:'complete'},occurrences:[]}]});
    expect(repository.load().state.knowledgePoints).toHaveLength(1);
    expect(repository.load().state.knowledgePoints[0].pronunciationStatus).toBe('complete');
  });

  test('serializes analysis operations, binds operation IDs to selected lemmas, and replays terminal state', async () => {
    const repository = new InMemoryAppRepository(emptyLearningState());
    const at = '2026-11-17T00:00:00.000Z';
    expect(await repository.startAnalysisResolution('m', 'a', 'op-1', ['run', 'walk'], at, 60_000)).toBe('started');
    expect(await repository.startAnalysisResolution('m', 'a', 'op-2', ['run'], at, 60_000)).toBe('processing');
    expect(await repository.startAnalysisResolution('m', 'a', 'op-1', ['walk', 'run'], at, 60_000)).toBe('processing');
    expect(await repository.startAnalysisResolution('m', 'a', 'op-1', ['run'], at, 60_000)).toBe('conflict');
    await repository.finishAnalysisResolution('a', 'op-1', 'complete', at);
    expect(await repository.startAnalysisResolution('m', 'a', 'op-1', ['run', 'walk'], at, 60_000)).toBe('complete');
    expect(await repository.startAnalysisResolution('m', 'a', 'op-3', ['run'], at, 60_000)).toBe('started');
  });

  test('candidate claims only reopen after failure or an expired processing lease', async () => {
    const repository = new InMemoryAppRepository(emptyLearningState());
    const at = '2026-11-17T00:00:00.000Z';
    expect(await repository.claimAnalysisCandidate('m', 'a', 'run', 'op-1', at, 1_000)).toBe(true);
    expect(await repository.claimAnalysisCandidate('m', 'a', 'run', 'op-2', at, 1_000)).toBe(false);
    expect(await repository.claimAnalysisCandidate('m', 'a', 'run', 'op-1', '2026-11-17T00:00:02.000Z', 1_000)).toBe(true);
    await repository.finishAnalysisCandidate('m', 'a', 'run', 'op-1', 'failed', at);
    expect(await repository.claimAnalysisCandidate('m', 'a', 'run', 'op-2', at, 1_000)).toBe(true);
    await repository.finishAnalysisCandidate('m', 'a', 'run', 'op-2', 'resolved', at);
    expect(await repository.claimAnalysisCandidate('m', 'a', 'run', 'op-3', '2026-11-17T00:00:02.000Z', 1_000)).toBe(false);
  });
});
