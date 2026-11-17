import { InMemoryAppRepository, emptyLearningState } from '../lib/server/memory-repository';
import { openSqliteDatabase } from '../lib/server/sqlite/database';
import { SqliteLearningStateRepository } from '../lib/server/sqlite/repository';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Learner, Material, MaterialAnalysis, KnowledgePoint } from '../lib/domain/model';

jest.mock('@/lib/server/runtime', () => ({
  getRuntime: () => (globalThis as any).__resolveRuntime,
  getDemoLearner: async () => (globalThis as any).__resolveLearner,
}));

import { POST } from '../app/api/materials/[id]/analysis/resolve/route';

function setup(disambiguate: jest.Mock, candidates?: Extract<MaterialAnalysis,{status:'analyzed'}>['candidates']) {
  const learner: Learner = { id:'learner',currentVocabulary:null,dailyTaskCapacity:5,timezone:'UTC',createdAt:'now',updatedAt:'now' };
  const material: Material = { id:'material',learnerId:learner.id,title:'t',filename:'t.txt',format:'txt',mimeType:'text/plain',checksum:'sum',storageKey:null,extractedText:'run fast',extractionMetadata:{},createdAt:'now' };
  const analysis: Extract<MaterialAnalysis,{status:'analyzed'}> = {
    id:'analysis-v1',materialId:material.id,analyzerVersion:'test',createdAt:'now',status:'analyzed',items:[],unmatchedItems:[],errors:[],completedAt:'now',
    candidates:candidates ?? [{lemma:'run',candidates:[{id:'sense-run',pos:'verb',gloss:'move quickly'}],occurrences:[{rawForm:'run',sentence:'I run fast.',context:[]}],status:'pending'}],
  };
  const repository=new InMemoryAppRepository(emptyLearningState());
  const initial=repository.load();repository.save({...initial.state,learners:[learner],materials:[material]},initial.revision);
  return repository.saveMaterialWithAnalysis(material,analysis).then(()=>{
    (globalThis as any).__resolveLearner=learner;
    (globalThis as any).__resolveRuntime={repository,ready:Promise.resolve(),llmConfigured:true,senseDisambiguator:{disambiguate},translateSenseMeaning:async()=> '跑',pronunciationLookup:async()=>null};
    return {repository,material,analysis};
  });
}

async function request(analysisId:string,operationId:string,lemmas=['run']) {
  return POST(new Request('http://localhost/api/materials/material/analysis/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({analysisId,operationId,lemmas})}),{params:Promise.resolve({id:'material'})});
}
const nameOf=(point:KnowledgePoint)=> 'lemma' in point ? point.lemma : point.name;

describe('material candidate resolution endpoint',()=>{
  afterEach(()=>{delete (globalThis as any).__resolveRuntime;delete (globalThis as any).__resolveLearner;});

  test('persists each resolved result with its status and replays the same operation without another provider call',async()=>{
    const disambiguate=jest.fn(async(items:Array<{key:string}>)=>items.map(item=>({key:item.key,senseId:'sense-run'})));
    const {repository}=await setup(disambiguate);
    const first=await request('analysis-v1','op-1');
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({status:'resolved',operationId:'op-1'});
    const saved=repository.load().state.materialAnalyses[0] as Extract<MaterialAnalysis,{status:'analyzed'}>;
    expect(saved.candidates?.[0].status).toBe('resolved');
    expect(saved.items.map(item=>nameOf(item.knowledgePoint))).toContain('run');
    const replay=await request('analysis-v1','op-1');
    expect(await replay.json()).toMatchObject({status:'complete',operationId:'op-1'});
    expect(disambiguate).toHaveBeenCalledTimes(1);
  });

  test('rejects stale analysis versions and lets a new operation retry failed candidates',async()=>{
    const disambiguate=jest.fn()
      .mockRejectedValueOnce(new Error('provider unavailable'))
      .mockImplementationOnce(async(items:Array<{key:string}>)=>items.map(item=>({key:item.key,senseId:'sense-run'})));
    const {repository}=await setup(disambiguate);
    expect((await request('old-analysis','stale-op')).status).toBe(409);
    const failed=await request('analysis-v1','op-fail');
    expect(await failed.json()).toMatchObject({status:'partial',failedLemmas:['run']});
    const saved=repository.load().state.materialAnalyses[0] as Extract<MaterialAnalysis,{status:'analyzed'}>;
    expect(saved.candidates?.[0].status).toBe('failed');
    const replay=await request('analysis-v1','op-fail');
    expect(await replay.json()).toMatchObject({status:'failed'});
    expect(disambiguate).toHaveBeenCalledTimes(1);
    const retry=await request('analysis-v1','op-retry');
    expect(await retry.json()).toMatchObject({status:'resolved'});
    expect(disambiguate).toHaveBeenCalledTimes(2);
  });

  test('persists partial success and keeps it when another candidate fails and is retried later',async()=>{
    const disambiguate=jest.fn()
      .mockRejectedValueOnce(new Error('temporary provider error'))
      .mockImplementationOnce(async(items:Array<{key:string}>)=>items.map(item=>({key:item.key,senseId:'sense-walk'})))
      .mockImplementationOnce(async(items:Array<{key:string}>)=>items.map(item=>({key:item.key,senseId:'sense-run'})));
    const candidates=[
      {lemma:'run',candidates:[{id:'sense-run',pos:'verb',gloss:'move quickly'}],occurrences:[{rawForm:'run',sentence:'I run fast.',context:[]}],status:'pending' as const},
      {lemma:'walk',candidates:[{id:'sense-walk',pos:'verb',gloss:'move on foot'}],occurrences:[{rawForm:'walk',sentence:'We walk home.',context:[]}],status:'pending' as const},
    ];
    const {repository}=await setup(disambiguate,candidates);
    const partial=await request('analysis-v1','op-batch',['run','walk']);
    expect(await partial.json()).toMatchObject({status:'partial',failedLemmas:['run']});
    let saved=repository.load().state.materialAnalyses[0] as Extract<MaterialAnalysis,{status:'analyzed'}>;
    expect(saved.items.map(item=>nameOf(item.knowledgePoint))).toEqual(['walk']);
    expect(saved.candidates?.map(item=>item.status)).toEqual(['failed','resolved']);
    expect(await (await request('analysis-v1','op-run-retry',['run'])).json()).toMatchObject({status:'resolved'});
    saved=repository.load().state.materialAnalyses[0] as Extract<MaterialAnalysis,{status:'analyzed'}>;
    expect(new Set(saved.items.map(item=>nameOf(item.knowledgePoint)))).toEqual(new Set(['run','walk']));
    expect(saved.candidates?.every(item=>item.status==='resolved')).toBe(true);
    expect(disambiguate).toHaveBeenCalledTimes(3);
  });

  test('resolves and persists candidate results through SQLite',async()=>{
    const learner:Learner={id:'learner',currentVocabulary:null,dailyTaskCapacity:5,timezone:'UTC',createdAt:'now',updatedAt:'now'};
    const material:Material={id:'material',learnerId:learner.id,title:'t',filename:'t.txt',format:'txt',mimeType:'text/plain',checksum:'sum',storageKey:null,extractedText:'run',extractionMetadata:{},createdAt:'now'};
    const analysis:Extract<MaterialAnalysis,{status:'analyzed'}>={id:'analysis-v1',materialId:material.id,analyzerVersion:'test',createdAt:'now',status:'analyzed',items:[],unmatchedItems:[],errors:[],completedAt:'now',candidates:[{lemma:'run',candidates:[{id:'sense-run',pos:'verb',gloss:'move quickly'}],occurrences:[{rawForm:'run',sentence:'I run.',context:[]}],status:'pending'}]};
    const {connection}=openSqliteDatabase(':memory:');
    try{
      const repository=new SqliteLearningStateRepository(connection);const initial=repository.load();repository.save({...initial.state,learners:[learner],materials:[material]},initial.revision);await repository.saveMaterialWithAnalysis(material,analysis);
      (globalThis as any).__resolveLearner=learner;
      (globalThis as any).__resolveRuntime={repository,ready:Promise.resolve(),llmConfigured:true,senseDisambiguator:{disambiguate:async(items:Array<{key:string}>)=>items.map(item=>({key:item.key,senseId:'sense-run'}))},translateSenseMeaning:async()=> '跑',pronunciationLookup:async()=>null};
      expect(await (await request('analysis-v1','sqlite-op')).json()).toMatchObject({status:'resolved'});
      const latest=repository.load().state.materialAnalyses[0] as Extract<MaterialAnalysis,{status:'analyzed'}>;
      expect(latest.candidates?.[0].status).toBe('resolved');
      expect(latest.items.map(item=>nameOf(item.knowledgePoint))).toEqual(['run']);
      await new Promise((resolve)=>setTimeout(resolve,0));
    }finally{connection.close();}
  });

  test('reclaims expired processing state after a simulated process restart',async()=>{
    const directory=mkdtempSync(path.join(tmpdir(),'flow-resolution-recovery-'));const filename=path.join(directory,'flow.sqlite');
    const learner:Learner={id:'learner',currentVocabulary:null,dailyTaskCapacity:5,timezone:'UTC',createdAt:'now',updatedAt:'now'};
    const material:Material={id:'material',learnerId:learner.id,title:'t',filename:'t.txt',format:'txt',mimeType:'text/plain',checksum:'sum',storageKey:null,extractedText:'run',extractionMetadata:{},createdAt:'now'};
    const analysis:Extract<MaterialAnalysis,{status:'analyzed'}>={id:'analysis-v1',materialId:material.id,analyzerVersion:'test',createdAt:'now',status:'analyzed',items:[],unmatchedItems:[],errors:[],completedAt:'now',candidates:[{lemma:'run',candidates:[{id:'sense-run',pos:'verb',gloss:'move quickly'}],occurrences:[{rawForm:'run',sentence:'I run.',context:[]}],status:'pending'}]};
    let opened=openSqliteDatabase(filename);
    try{
      const repository=new SqliteLearningStateRepository(opened.connection);const initial=repository.load();repository.save({...initial.state,learners:[learner],materials:[material]},initial.revision);await repository.saveMaterialWithAnalysis(material,analysis);
      const crashedAt=new Date(Date.now()-20*60*1000).toISOString();
      expect(await repository.startAnalysisResolution('material','analysis-v1','crashed-op',['run'],crashedAt,60_000)).toBe('started');
      expect(await repository.claimAnalysisCandidate('material','analysis-v1','run','crashed-op',crashedAt,60_000)).toBe(true);
      await repository.saveMaterialAnalysis('material',{...analysis,candidates:analysis.candidates?.map(item=>({...item,status:'processing' as const}))});
      opened.connection.close();
      opened=openSqliteDatabase(filename);
      const restartedRepository=new SqliteLearningStateRepository(opened.connection);
      const disambiguate=jest.fn(async(items:Array<{key:string}>)=>items.map(item=>({key:item.key,senseId:'sense-run'})));
      (globalThis as any).__resolveLearner=learner;
      (globalThis as any).__resolveRuntime={repository:restartedRepository,ready:Promise.resolve(),llmConfigured:true,senseDisambiguator:{disambiguate},translateSenseMeaning:async()=> '跑',pronunciationLookup:async()=>null};
      expect(await (await request('analysis-v1','recovery-op')).json()).toMatchObject({status:'resolved'});
      expect(disambiguate).toHaveBeenCalledTimes(1);
      const recovered=restartedRepository.load().state.materialAnalyses[0] as Extract<MaterialAnalysis,{status:'analyzed'}>;
      expect(recovered.candidates?.[0].status).toBe('resolved');
      expect(recovered.items.map(item=>nameOf(item.knowledgePoint))).toEqual(['run']);
      await new Promise((resolve)=>setTimeout(resolve,0));
    }finally{opened.connection.close();rmSync(directory,{recursive:true,force:true});}
  });
});
