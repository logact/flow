import { InMemoryAppRepository, emptyLearningState } from '../lib/server/memory-repository';
import type { Learner, Material, KnowledgePoint, MaterialAnalysis, PronunciationMetadata } from '../lib/domain/model';

jest.mock('@/lib/application/material-import', () => ({
  importMaterialUseCase: (...args: unknown[]) => (globalThis as any).__flowImportMaterial(...args),
}));
jest.mock('@/lib/server/runtime', () => ({
  getRuntime: () => (globalThis as any).__flowRuntime,
  getDemoLearner: async () => (globalThis as any).__flowLearner,
}));

import { POST } from '../app/api/materials/[id]/analysis/route';

describe('material analysis pronunciation trigger', () => {
  test('starts pronunciation lookup after save without waiting for the dictionary', async () => {
    const learner: Learner = { id:'learner',currentVocabulary:null,dailyTaskCapacity:5,timezone:'UTC',createdAt:'now',updatedAt:'now' };
    const material: Material = { id:'material',learnerId:learner.id,title:'t',filename:'t.txt',format:'txt',mimeType:'text/plain',checksum:'sum',storageKey:null,extractedText:'run',extractionMetadata:{},createdAt:'now' };
    const point: KnowledgePoint = { id:'kp-run',kind:'word',lemma:'run',wordFamily:'run',sense:{id:'sense-run',definition:'move fast',chineseMeaning:null,partOfSpeech:'verb',explanation:null},pronunciationStatus:'pending',pronunciation:null };
    const analysis: Extract<MaterialAnalysis,{status:'analyzed'}> = { id:'analysis',materialId:material.id,analyzerVersion:'test',createdAt:'now',status:'analyzed',items:[{knowledgePoint:point,occurrences:[]}],unmatchedItems:[],errors:[],completedAt:'now' };
    const repository = new InMemoryAppRepository(emptyLearningState());
    const initial=repository.load();
    repository.save({...initial.state,learners:[learner],materials:[material]},initial.revision);
    let finish!: (value: PronunciationMetadata | null) => void;
    const lookup=jest.fn(() => new Promise<PronunciationMetadata|null>((resolve)=>{finish=resolve;}));
    (globalThis as any).__flowRuntime={repository,ready:Promise.resolve(),llmConfigured:false,pronunciationLookup:lookup};
    (globalThis as any).__flowLearner=learner;
    (globalThis as any).__flowImportMaterial=async (deps:{repository:typeof repository},input:{analysisId:string})=>{
      const imported={...analysis,id:input.analysisId};
      await deps.repository.saveMaterialWithAnalysis(material,imported);
      return {ok:true,material,analysis:imported};
    };
    let timeout:ReturnType<typeof setTimeout>|undefined;
    try {
      const response=await Promise.race([
        POST(new Request('http://localhost/api/materials/material/analysis',{method:'POST'}),{params:Promise.resolve({id:material.id})}),
        new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('analysis response waited on pronunciation')),750);}),
      ]);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({status:'analyzed'});
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(repository.load().state.materialAnalyses.at(-1)?.status).toBe('analyzed');
      finish({ipa:'/rʌn/',audioUrl:null,source:'test',sourceUrl:'https://example.test',queriedAt:new Date().toISOString()});
      await new Promise((resolve)=>setTimeout(resolve,0));
      expect(repository.load().state.knowledgePoints[0].pronunciationStatus).toBe('complete');
    } finally {
      if(timeout) clearTimeout(timeout);
      finish?.(null);
      delete (globalThis as any).__flowRuntime;
      delete (globalThis as any).__flowLearner;
      delete (globalThis as any).__flowImportMaterial;
    }
  });

  test('dictionary no-match leaves the saved analysis and knowledge point successful',async()=>{
    const learner:Learner={id:'learner-2',currentVocabulary:null,dailyTaskCapacity:5,timezone:'UTC',createdAt:'now',updatedAt:'now'};
    const material:Material={id:'material-2',learnerId:learner.id,title:'t',filename:'t.txt',format:'txt',mimeType:'text/plain',checksum:'sum',storageKey:null,extractedText:'walk',extractionMetadata:{},createdAt:'now'};
    const point:KnowledgePoint={id:'kp-walk',kind:'word',lemma:'walk',wordFamily:'walk',sense:{id:'sense-walk',definition:'move on foot',chineseMeaning:null,partOfSpeech:'verb',explanation:null},pronunciationStatus:'pending',pronunciation:null};
    const analysis:Extract<MaterialAnalysis,{status:'analyzed'}>={id:'analysis-2',materialId:material.id,analyzerVersion:'test',createdAt:'now',status:'analyzed',items:[{knowledgePoint:point,occurrences:[]}],unmatchedItems:[],errors:[],completedAt:'now'};
    const repository=new InMemoryAppRepository(emptyLearningState());const initial=repository.load();repository.save({...initial.state,learners:[learner],materials:[material]},initial.revision);
    const lookup=jest.fn(async()=>null);
    (globalThis as any).__flowRuntime={repository,ready:Promise.resolve(),llmConfigured:false,pronunciationLookup:lookup};
    (globalThis as any).__flowLearner=learner;
    (globalThis as any).__flowImportMaterial=async(deps:{repository:typeof repository},input:{analysisId:string})=>{const imported={...analysis,id:input.analysisId};await deps.repository.saveMaterialWithAnalysis(material,imported);return {ok:true,material,analysis:imported};};
    try{
      const response=await POST(new Request('http://localhost/api/materials/material-2/analysis',{method:'POST'}),{params:Promise.resolve({id:material.id})});
      expect(await response.json()).toMatchObject({status:'analyzed'});
      await new Promise(resolve=>setTimeout(resolve,0));
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(repository.load().state.materialAnalyses.at(-1)?.status).toBe('analyzed');
      expect(repository.load().state.knowledgePoints[0]).toMatchObject({id:point.id,pronunciationStatus:'failed',pronunciation:null});
    }finally{
      delete (globalThis as any).__flowRuntime;delete (globalThis as any).__flowLearner;delete (globalThis as any).__flowImportMaterial;
    }
  });
});
