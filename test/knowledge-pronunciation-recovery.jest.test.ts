import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyLearningState } from '../lib/server/memory-repository';
import { openSqliteDatabase } from '../lib/server/sqlite/database';
import { SqliteLearningStateRepository } from '../lib/server/sqlite/repository';
import type { Learner, KnowledgePoint, PronunciationMetadata } from '../lib/domain/model';

jest.mock('@/lib/server/runtime', () => ({ getRuntime: () => (globalThis as any).__pronunciationRuntime }));
import { GET } from '../app/api/knowledge/[id]/route';

describe('pronunciation recovery after restart',()=>{
  afterEach(()=>{delete (globalThis as any).__pronunciationRuntime;});

  test('detail GET resumes expired persisted work without changing analysis state',async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),'flow-pronunciation-recovery-'));const filename=path.join(directory,'flow.sqlite');
    const learner:Learner={id:'learner',currentVocabulary:null,dailyTaskCapacity:5,timezone:'UTC',createdAt:'now',updatedAt:'now'};
    const point:KnowledgePoint={id:'kp-run',kind:'word',lemma:'run',wordFamily:'run',sense:{id:'sense-run',definition:'move quickly',chineseMeaning:null,partOfSpeech:'verb',explanation:null},pronunciationStatus:'processing',pronunciation:null};
    let opened=openSqliteDatabase(filename);
    try{
      const repository=new SqliteLearningStateRepository(opened.connection);const snapshot=repository.load();repository.save({...snapshot.state,learners:[learner],knowledgePoints:[point]},snapshot.revision);
      const expiredAt=new Date(Date.now()-5*60*1000).toISOString();
      expect(repository.claimPronunciation(point.id,'interrupted-op',expiredAt,30_000)).toBe(true);
      opened.connection.close();opened=openSqliteDatabase(filename);
      const restarted=new SqliteLearningStateRepository(opened.connection);
      let finish!:(value:PronunciationMetadata|null)=>void;
      const lookup=jest.fn(()=>new Promise<PronunciationMetadata|null>(resolve=>{finish=resolve;}));
      (globalThis as any).__pronunciationRuntime={repository:restarted,ready:Promise.resolve(),pronunciationLookup:lookup};
      const response=await GET(new Request('http://localhost/api/knowledge/kp-run'),{params:Promise.resolve({id:point.id})});
      expect((await response.json()).item).toMatchObject({pronunciationStatus:'processing'});
      expect(lookup).toHaveBeenCalledTimes(1);
      const metadata:PronunciationMetadata={ipa:'/rʌn/',audioUrl:null,source:'test',sourceUrl:'https://example.test',queriedAt:new Date().toISOString()};
      finish(metadata);await new Promise(resolve=>setTimeout(resolve,0));
      expect(restarted.load().state.knowledgePoints[0]).toMatchObject({pronunciationStatus:'complete',pronunciation:metadata});
      expect(restarted.load().state.materialAnalyses).toEqual([]);
    }finally{opened.connection.close();rmSync(directory,{recursive:true,force:true});}
  });
});
