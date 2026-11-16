import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyLearningState } from '../lib/server/memory-repository';
import { ConcurrencyConflictError } from '../lib/application/repository';
import { openSqliteDatabase } from '../lib/server/sqlite/database';
import { SqliteLearningStateRepository } from '../lib/server/sqlite/repository';

describe('SQLite learning state repository', () => {
  test('starts with a complete empty state and revision zero, and initializes idempotently', () => {
    const { connection } = openSqliteDatabase(':memory:');
    try {
      const repository = new SqliteLearningStateRepository(connection);
      const empty = emptyLearningState();
      expect(repository.load()).toEqual({ state: empty, revision: 0 });
      const migrationCount = (connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as {count:number}).count;
      const second = openSqliteDatabase(':memory:');
      try {
        expect((second.connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as {count:number}).count).toBe(migrationCount);
        expect(new SqliteLearningStateRepository(second.connection).load()).toEqual({state:empty,revision:0});
      } finally { second.connection.close(); }
      expect((connection.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as {count:number}).count).toBe(migrationCount);
    } finally { connection.close(); }
  });

  test('rejects invalid JSON in a domain row with a clear error', () => {
    const { connection } = openSqliteDatabase(':memory:');
    try {
      connection.prepare("INSERT INTO learners(id,data) VALUES ('broken','{')").run();
      expect(() => new SqliteLearningStateRepository(connection).load()).toThrow('Invalid JSON in SQLite domain row');
    } finally { connection.close(); }
  });

  test('same revision can be committed only once and a conflict preserves stored state', () => {
    const { connection } = openSqliteDatabase(':memory:');
    try {
      const repository = new SqliteLearningStateRepository(connection);
      const initial = repository.load();
      const learner = { id:'once', currentVocabulary:null, timezone:'UTC', dailyTaskCapacity:1, createdAt:'now', updatedAt:'now' };
      repository.save({ ...initial.state, learners:[learner] }, 0);
      expect(() => repository.save(initial.state, 0)).toThrow(ConcurrencyConflictError);
      expect(repository.load()).toEqual({ state:{ ...initial.state, learners:[learner] }, revision:1 });
    } finally { connection.close(); }
  });

  test('round-trips analysis item and occurrence ordering, and removes parent relations', () => {
    const { connection } = openSqliteDatabase(':memory:');
    try {
      const repository = new SqliteLearningStateRepository(connection);
      const initial = repository.load();
      const learner = { id:'ordered-owner', currentVocabulary:null, timezone:'UTC', dailyTaskCapacity:1, createdAt:'now', updatedAt:'now' };
      const material = { id:'ordered-material', learnerId:learner.id, title:'t', filename:'t', format:'txt', mimeType:'text/plain', checksum:'x', storageKey:null, extractedText:'', extractionMetadata:{}, createdAt:'now' };
      const kp1 = { id:'kp1', kind:'word', lemma:'one', wordFamily:'one', sense:{id:'s1',definition:'one',partOfSpeech:null,explanation:null} };
      const kp2 = { ...kp1, id:'kp2', lemma:'two', wordFamily:'two', sense:{...kp1.sense,id:'s2',definition:'two'} };
      const pending = { id:'ordered-analysis', materialId:material.id, analyzerVersion:'v1', createdAt:'now', status:'pending', items:[], unmatchedItems:[], errors:[], completedAt:null };
      repository.save({ ...initial.state, learners:[learner], materials:[material], knowledgePoints:[kp1,kp2], materialAnalyses:[pending] } as any, 0);
      const analyzed = {...pending, status:'analyzed', completedAt:'later', items:[{knowledgePoint:kp2,occurrences:[{start:20,end:22,text:'b'},{start:23,end:25,text:'c'}]},{knowledgePoint:kp1,occurrences:[{start:1,end:3,text:'a'}]}], unmatchedItems:[{text:'unknown',occurrences:[{start:30,end:37,text:'unknown'}]}]};
      repository.save({...repository.load().state,materialAnalyses:[analyzed]} as any,1);
      expect(repository.load().state.materialAnalyses[0]).toEqual(analyzed);
      const beforeDelete=repository.load();
      repository.save({...beforeDelete.state,materialAnalyses:[]} as any,beforeDelete.revision);
      expect(repository.load().state.materialAnalyses).toEqual([]);
      expect((connection.prepare('SELECT COUNT(*) AS count FROM material_analysis_occurrences').get() as {count:number}).count).toBe(0);
    } finally { connection.close(); }
  });

  test('round-trips study-plan task order and safely reorders unique positions', () => {
    const { connection } = openSqliteDatabase(':memory:');
    try {
      const repository = new SqliteLearningStateRepository(connection);
      const empty=repository.load();
      const learner={id:'plan-learner',currentVocabulary:null,timezone:'UTC',dailyTaskCapacity:2,createdAt:'now',updatedAt:'now'};
      const goal={id:'plan-goal',learnerId:learner.id,title:'g',targetFluency:{R:1,P:1},status:'active',createdAt:'now',updatedAt:'now'};
      const plan={id:'plan',learnerId:learner.id,date:'today',taskIds:['task-a','task-b']};
      const tasks=[{id:'task-a',learnerId:learner.id,goalId:goal.id},{id:'task-b',learnerId:learner.id,goalId:goal.id}];
      repository.save({...empty.state,learners:[learner],goals:[goal],studyPlans:[plan],tasks} as any,0);
      expect(repository.load().state.studyPlans[0].taskIds).toEqual(['task-a','task-b']);
      repository.save({...repository.load().state,studyPlans:[{...plan,taskIds:['task-b','task-a']}]} as any,1);
      expect(repository.load().state.studyPlans[0].taskIds).toEqual(['task-b','task-a']);
      expect(connection.prepare('SELECT task_id,position FROM study_plan_tasks ORDER BY position').all()).toEqual([{task_id:'task-b',position:0},{task_id:'task-a',position:1}]);
    } finally { connection.close(); }
  });

  test('study-plan task links are removed with their plan while referenced tasks are protected', () => {
    const {connection}=openSqliteDatabase(':memory:');
    try {
      const repository=new SqliteLearningStateRepository(connection);const empty=repository.load();
      const learner={id:'fk-learner',currentVocabulary:null,timezone:'UTC',dailyTaskCapacity:1,createdAt:'now',updatedAt:'now'};
      const goal={id:'fk-goal',learnerId:learner.id,title:'g',targetFluency:{R:1,P:1},status:'active',createdAt:'now',updatedAt:'now'};
      const task={id:'fk-task',learnerId:learner.id,goalId:goal.id};const plan={id:'fk-plan',learnerId:learner.id,date:'today',taskIds:[task.id]};
      repository.save({...empty.state,learners:[learner],goals:[goal],tasks:[task],studyPlans:[plan]} as any,0);
      expect(()=>connection.prepare("DELETE FROM learning_tasks WHERE id='fk-task'").run()).toThrow();
      const saved=repository.load();repository.save({...saved.state,studyPlans:[]},saved.revision);
      expect((connection.prepare('SELECT COUNT(*) AS count FROM study_plan_tasks').get() as {count:number}).count).toBe(0);
      expect(connection.prepare("SELECT id FROM learning_tasks WHERE id='fk-task'").get()).toEqual({id:'fk-task'});
    } finally {connection.close();}
  });

  test('aggregate save inserts, updates and deletes records with one revision per commit', () => {
    const {connection}=openSqliteDatabase(':memory:');
    try {
      const repository=new SqliteLearningStateRepository(connection);const initial=repository.load();
      const learner={id:'crud-learner',currentVocabulary:null,timezone:'UTC',dailyTaskCapacity:1,createdAt:'now',updatedAt:'now'};
      const first=repository.save({...initial.state,learners:[learner]},0);
      expect(first.revision).toBe(1);
      const changed={...learner,timezone:'Asia/Shanghai'};
      const second=repository.save({...first.state,learners:[changed]},1);
      expect(second.revision).toBe(2);expect(second.state.learners).toEqual([changed]);
      const third=repository.save({...second.state,learners:[]},2);
      expect(third.revision).toBe(3);expect(third.state.learners).toEqual([]);expect(repository.load()).toEqual(third);
    } finally {connection.close();}
  });

  test('material ports insert and update records while rejecting missing parents and immutable analyzed edits', async () => {
    const {connection}=openSqliteDatabase(':memory:');
    try {
      const repository=new SqliteLearningStateRepository(connection);const initial=repository.load();
      const learner={id:'material-port-learner',currentVocabulary:null,timezone:'UTC',dailyTaskCapacity:1,createdAt:'now',updatedAt:'now'};
      const material={id:'material-port',learnerId:learner.id,title:'original',filename:'m.txt',format:'txt' as const,mimeType:'text/plain',checksum:'x',storageKey:null,extractedText:'text',extractionMetadata:{},createdAt:'now'};
      repository.save({...initial.state,learners:[learner]},0);
      await repository.saveMaterial(material as any);
      const afterInsert=repository.load();expect(afterInsert.state.materials).toEqual([material]);expect(afterInsert.revision).toBe(2);
      const updated={...material,title:'updated'};await repository.saveMaterial(updated as any);
      expect(repository.load().state.materials).toEqual([updated]);expect(repository.load().revision).toBe(3);
      const analysis={id:'port-analysis',materialId:material.id,analyzerVersion:'v1',createdAt:'now',status:'pending',items:[],unmatchedItems:[],errors:[],completedAt:null};
      await expect(repository.saveMaterialAnalysis('missing',analysis as any)).rejects.toThrow('Material not found');
      expect(repository.load().revision).toBe(3);expect(repository.load().state.materialAnalyses).toEqual([]);
      await repository.saveMaterialAnalysis(material.id,analysis as any);
      const analyzed={...analysis,status:'analyzed',completedAt:'later'};
      await repository.saveMaterialWithAnalysis(updated as any,analyzed as any);
      const committed=repository.load();expect(committed.state.materialAnalyses).toEqual([analyzed]);expect(committed.revision).toBe(5);
      await expect(repository.saveMaterialWithAnalysis(updated as any,{...analyzed,analyzerVersion:'tampered'} as any)).rejects.toThrow('Material analysis id is immutable');
      expect(repository.load()).toEqual(committed);
    } finally {connection.close();}
  });

  test('goal-material port upserts composite relations and loads the scoped records', async () => {
    const {connection}=openSqliteDatabase(':memory:');
    try {
      const repository=new SqliteLearningStateRepository(connection);const initial=repository.load();
      const learner={id:'scope-learner',currentVocabulary:null,timezone:'UTC',dailyTaskCapacity:1,createdAt:'now',updatedAt:'now'};
      const goal={id:'scope-goal',learnerId:learner.id,title:'g',targetFluency:{R:1,P:1},status:'active',createdAt:'now',updatedAt:'now'};
      const material={id:'scope-material',learnerId:learner.id,title:'m',filename:'m',format:'txt' as const,mimeType:'text/plain',checksum:'x',storageKey:null,extractedText:'',extractionMetadata:{},createdAt:'now'};
      const kp={id:'scope-kp',kind:'word',lemma:'word',wordFamily:'word',sense:{id:'sense',definition:'word',partOfSpeech:null,explanation:null}};
      const analysis={id:'scope-analysis',materialId:material.id,analyzerVersion:'v',createdAt:'now',status:'pending',items:[],unmatchedItems:[],errors:[],completedAt:null};
      repository.save({...initial.state,learners:[learner],materials:[material],materialAnalyses:[analysis]} as any,0);
      const payload={goal,materialLink:{goalId:goal.id,materialId:material.id,analysisId:analysis.id,addedAt:'now'},knowledgePoints:[kp],candidates:[{goalId:goal.id,knowledgePointId:kp.id,selection:'undecided',addedAt:'now',selectionUpdatedAt:'now'}],sources:[{goalId:goal.id,knowledgePointId:kp.id,sourceAnalysisId:analysis.id,addedAt:'now'}]};
      await repository.saveGoalMaterial(payload as any);
      expect(repository.load().revision).toBe(2);
      const scope=await repository.loadGoalScope(goal.id);expect(scope).toEqual({materialLinks:[payload.materialLink],candidates:payload.candidates,sources:payload.sources});
      const changed={...payload,materialLink:{...payload.materialLink,addedAt:'later'},candidates:[{...payload.candidates[0],selection:'included',selectionUpdatedAt:'later'}]};
      await repository.saveGoalMaterial(changed as any);
      expect(await repository.loadGoalScope(goal.id)).toEqual({materialLinks:[changed.materialLink],candidates:changed.candidates,sources:payload.sources});
      expect(repository.load().revision).toBe(3);
      expect((connection.prepare('SELECT COUNT(*) AS count FROM goal_materials').get() as {count:number}).count).toBe(1);
    } finally {connection.close();}
  });

  test('selection context loads candidate aggregates and selection save upserts related rows', async () => {
    const {connection}=openSqliteDatabase(':memory:');
    try {
      const repository=new SqliteLearningStateRepository(connection);const initial=repository.load();
      const learner={id:'selection-learner',currentVocabulary:null,timezone:'UTC',dailyTaskCapacity:1,createdAt:'now',updatedAt:'now'};
      const goal={id:'selection-goal',learnerId:learner.id,title:'g',targetFluency:{R:1,P:1},status:'active',createdAt:'now',updatedAt:'now'};
      const kp={id:'selection-kp',kind:'word',lemma:'word',wordFamily:'word',sense:{id:'s',definition:'word',partOfSpeech:null,explanation:null}};
      const candidate={goalId:goal.id,knowledgePointId:kp.id,selection:'undecided',addedAt:'now',selectionUpdatedAt:'now'};
      repository.save({...initial.state,learners:[learner],goals:[goal],knowledgePoints:[kp],goalKnowledgePoints:[candidate]} as any,0);
      expect(await repository.loadSelectionContext('absent')).toBeNull();
      const context=await repository.loadSelectionContext(goal.id);
      expect(context).toMatchObject({learner,goal,candidates:[candidate],knowledgePoints:[kp],classifications:[],learnerKnowledgePoints:[]});
      const learnerKp={learnerId:learner.id,knowledgePointId:kp.id,initialFluency:{R:0,P:0},initialization:{},dimensions:{},createdAt:'now',updatedAt:'now',version:1};
      const classification={knowledgePointId:kp.id,list:{id:'bnc-coca',version:'1'},band:'1k'};
      const included={...candidate,selection:'included',selectionUpdatedAt:'later'};
      const payload={updatedCandidates:[included],newLearnerKnowledgePoints:[learnerKp],newClassifications:[classification]};
      await repository.saveKnowledgePointSelection(payload as any);
      expect(repository.load().revision).toBe(2);
      expect(await repository.loadSelectionContext(goal.id)).toMatchObject({candidates:[included],classifications:[classification],learnerKnowledgePoints:[learnerKp]});
      await repository.saveKnowledgePointSelection(payload as any);
      expect(repository.load().revision).toBe(3);
      expect((connection.prepare('SELECT COUNT(*) AS count FROM learner_knowledge_points').get() as {count:number}).count).toBe(1);
    } finally {connection.close();}
  });

  test('selection context returns null when the goal learner row is missing', async () => {
    const {connection}=openSqliteDatabase(':memory:');
    try {
      const repository=new SqliteLearningStateRepository(connection);const initial=repository.load();
      const orphanGoal={id:'orphan-goal',learnerId:'missing',title:'g',targetFluency:{R:1,P:1},status:'active',createdAt:'now',updatedAt:'now'};
      connection.pragma('foreign_keys = OFF');
      repository.save({...initial.state,goals:[orphanGoal]} as any,0);
      expect(await repository.loadSelectionContext(orphanGoal.id)).toBeNull();
    } finally {connection.close();}
  });

  test('task-generation context filters source materials and handles missing scope rows', async () => {
    const {connection}=openSqliteDatabase(':memory:');
    try {
      const repository=new SqliteLearningStateRepository(connection);const initial=repository.load();
      const learner={id:'taskctx-learner',currentVocabulary:null,timezone:'UTC',dailyTaskCapacity:1,createdAt:'now',updatedAt:'now'};
      const goal={id:'taskctx-goal',learnerId:learner.id,title:'g',targetFluency:{R:1,P:1},status:'active',createdAt:'now',updatedAt:'now'};
      const kp={id:'taskctx-kp',kind:'word',lemma:'word',wordFamily:'word',sense:{id:'s',definition:'word',partOfSpeech:null,explanation:null}};
      const candidate={goalId:goal.id,knowledgePointId:kp.id,selection:'included',addedAt:'now',selectionUpdatedAt:'now'};
      const materials=['one','two','unrelated'].map(id=>({id:`material-${id}`,learnerId:learner.id,title:id,filename:id,format:'txt' as const,mimeType:'text/plain',checksum:id,storageKey:null,extractedText:'',extractionMetadata:{},createdAt:'now'}));
      const analyses=materials.map((m,i)=>({id:`analysis-${i}`,materialId:m.id,analyzerVersion:'v',createdAt:'now',status:'pending',items:[],unmatchedItems:[],errors:[],completedAt:null}));
      const sources=[0,1].map(i=>({goalId:goal.id,knowledgePointId:kp.id,sourceAnalysisId:analyses[i].id,addedAt:'now'}));
      const vocabulary={source:'assessment',estimatedAt:'now'};
      repository.save({...initial.state,learners:[{...learner,currentVocabulary:vocabulary}],goals:[goal],knowledgePoints:[kp],goalKnowledgePoints:[candidate],materials,materialAnalyses:analyses,goalKnowledgePointSources:sources} as any,0);
      const context=await repository.loadTaskGenerationContext(goal.id,kp.id);
      expect(context).toMatchObject({goal,candidate,knowledgePoint:kp,sourceMaterials:materials.slice(0,2),learnerVocabulary:vocabulary});
      expect(await repository.loadTaskGenerationContext('missing',kp.id)).toBeNull();
      expect(await repository.loadTaskGenerationContext(goal.id,'missing')).toBeNull();
      const withoutCandidate=repository.load();
      repository.save({...withoutCandidate.state,goalKnowledgePoints:[],goalKnowledgePointSources:[]},withoutCandidate.revision);
      expect(await repository.loadTaskGenerationContext(goal.id,kp.id)).toBeNull();
    } finally {connection.close();}
  });

  test('task-generation context returns null vocabulary if the goal learner row is absent', async () => {
    const {connection}=openSqliteDatabase(':memory:');
    try {
      const repository=new SqliteLearningStateRepository(connection);const initial=repository.load();
      const goal={id:'orphan-task-goal',learnerId:'missing',title:'g',targetFluency:{R:1,P:1},status:'active',createdAt:'now',updatedAt:'now'};
      const kp={id:'orphan-task-kp',kind:'word',lemma:'word',wordFamily:'word',sense:{id:'s',definition:'word',partOfSpeech:null,explanation:null}};
      const candidate={goalId:goal.id,knowledgePointId:kp.id,selection:'included',addedAt:'now',selectionUpdatedAt:'now'};
      connection.pragma('foreign_keys = OFF');
      repository.save({...initial.state,goals:[goal],knowledgePoints:[kp],goalKnowledgePoints:[candidate]} as any,0);
      expect(await repository.loadTaskGenerationContext(goal.id,kp.id)).toMatchObject({goal,candidate,knowledgePoint:kp,sourceMaterials:[],learnerVocabulary:null});
    } finally {connection.close();}
  });

  test('persists state across reopen and rejects stale revisions', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'flow-sqlite-repository-'));
    const filename = path.join(directory, 'test.db');
    try {
      let opened = openSqliteDatabase(filename);
      let repository = new SqliteLearningStateRepository(opened.connection);
      const initial = repository.load();
      const learner = { id: 'learner-1', currentVocabulary: null, timezone: 'UTC', dailyTaskCapacity: 2, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
      const saved = repository.save({ ...initial.state, learners: [learner] }, initial.revision);
      expect(saved.revision).toBe(1);
      expect(() => repository.save(initial.state, initial.revision)).toThrow(ConcurrencyConflictError);
      opened.connection.close();

      opened = openSqliteDatabase(filename);
      repository = new SqliteLearningStateRepository(opened.connection);
      expect(repository.load()).toEqual({ state: { ...initial.state, learners: [learner] }, revision: 1 });
      opened.connection.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('allows pending material analysis to finish under the same id', async () => {
    const { connection } = openSqliteDatabase(':memory:');
    try {
      const repository = new SqliteLearningStateRepository(connection);
      const initial = repository.load();
      const learner = { id: 'learner', currentVocabulary: null, timezone: 'UTC', dailyTaskCapacity: 1, createdAt: 'now', updatedAt: 'now' };
      const material = { id: 'material', learnerId: learner.id, title: 't', filename: 't.txt', format: 'txt', mimeType: 'text/plain', checksum: 'x', storageKey: null, extractedText: 'text', extractionMetadata: {}, createdAt: 'now' };
      repository.save({ ...initial.state, learners: [learner], materials: [material] } as any, initial.revision);
      const pending = { id: 'analysis', materialId: material.id, analyzerVersion: 'v1', createdAt: 'now', status: 'pending', items: [], unmatchedItems: [], errors: [], completedAt: null };
      await repository.saveMaterialAnalysis(material.id, pending as any);
      await repository.saveMaterialWithAnalysis(material as any, { ...pending, status: 'analyzed', completedAt: 'later' } as any);
      expect(repository.load().state.materialAnalyses[0].status).toBe('analyzed');
    } finally {
      connection.close();
    }
  });

  test('rolls back invalid foreign-key writes without advancing revision', () => {
    const { connection } = openSqliteDatabase(':memory:');
    try {
      const repository = new SqliteLearningStateRepository(connection);
      const initial = repository.load();
      expect(() => repository.save({ ...emptyLearningState(), tasks: [{ id: 'orphan', learnerId: 'missing', goalId: 'missing' } as any] }, 0)).toThrow();
      expect(repository.load()).toEqual(initial);
    } finally {
      connection.close();
    }
  });

  test('rolls back the entire save on a unique-key violation without advancing revision', () => {
    const {connection}=openSqliteDatabase(':memory:');
    try {
      const repository=new SqliteLearningStateRepository(connection);const initial=repository.load();
      const learner={id:'unique-learner',currentVocabulary:null,timezone:'UTC',dailyTaskCapacity:1,createdAt:'now',updatedAt:'now'};
      const goal={id:'unique-goal',learnerId:learner.id,title:'g',targetFluency:{R:1,P:1},status:'active' as const,createdAt:'now',updatedAt:'now'};
      const material={id:'unique-material',learnerId:learner.id,title:'m',filename:'m',format:'txt' as const,mimeType:'text/plain',checksum:'x',storageKey:null,extractedText:'',extractionMetadata:{},createdAt:'now'};
      const planA={id:'plan-a',learnerId:learner.id,date:'same-day',taskIds:[],taskCapacity:1,createdAt:'now',updatedAt:'now'};
      const planB={id:'plan-b',learnerId:learner.id,date:'same-day',taskIds:[],taskCapacity:1,createdAt:'now',updatedAt:'now'};
      repository.save({...initial.state,learners:[learner],goals:[goal],materials:[material],studyPlans:[planA]},0);
      const committed=repository.load();
      expect(()=>repository.save({...committed.state,materials:[],studyPlans:[planA,planB]},committed.revision)).toThrow();
      expect(repository.load()).toEqual(committed);
    } finally {connection.close();}
  });

  test('migration creates the planned query and uniqueness indexes', () => {
    const { connection } = openSqliteDatabase(':memory:');
    try {
      const indexes = new Set((connection.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{name:string}>).map(x=>x.name));
      for (const name of [
        'study_plans_learner_date_idx', 'tasks_goal_idx', 'attempts_learner_idx',
        'material_analyses_material_idx', 'goal_materials_material_idx',
        'goal_sources_analysis_idx', 'learner_kp_lookup_idx', 'analysis_items_kp_idx',
      ]) expect(indexes.has(name)).toBe(true);
      expect((connection.prepare('PRAGMA index_list(task_attempts)').all() as Array<{unique:number}>).some(x=>x.unique===1)).toBe(true);
    } finally { connection.close(); }
  });

  test('migration installs composite foreign keys for dependent relation rows', () => {
    const { connection } = openSqliteDatabase(':memory:');
    try {
      const fkTargets=(table:string)=>new Set((connection.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{table:string}>).map(x=>x.table));
      expect(fkTargets('material_analysis_occurrences').has('material_analysis_items')).toBe(true);
      expect(fkTargets('material_analysis_unmatched_occurrences').has('material_analysis_unmatched_items')).toBe(true);
      expect(fkTargets('goal_knowledge_point_sources').has('goal_knowledge_points')).toBe(true);
      expect(fkTargets('study_plan_tasks').has('learning_tasks')).toBe(true);
      expect(fkTargets('study_plan_tasks').has('study_plans')).toBe(true);
    } finally { connection.close(); }
  });

  test('migration rejects negative repository revisions and ordered positions', () => {
    const { connection } = openSqliteDatabase(':memory:');
    try {
      expect(() => connection.prepare("UPDATE repository_meta SET revision=-1 WHERE key='main'").run()).toThrow();
      expect((connection.prepare("SELECT revision FROM repository_meta WHERE key='main'").get() as {revision:number}).revision).toBe(0);
      expect(() => connection.prepare("INSERT INTO vocabulary_assessment_tasks(id,assessment_id,position,data) VALUES ('bad','missing',-1,'{}')").run()).toThrow();
      connection.prepare("INSERT INTO learners(id,data) VALUES ('learner','{}')").run();
      connection.prepare("INSERT INTO materials(id,learner_id,data) VALUES ('material','learner','{}')").run();
      connection.prepare("INSERT INTO material_analyses(id,material_id,data) VALUES ('analysis','material','{}')").run();
      expect(() => connection.prepare("INSERT INTO material_analysis_unmatched_items(analysis_id,position,data) VALUES ('analysis',-1,'{}')").run()).toThrow();
      connection.prepare("INSERT INTO material_analysis_unmatched_items(analysis_id,position,data) VALUES ('analysis',0,'{}')").run();
      expect(() => connection.prepare("INSERT INTO material_analysis_unmatched_occurrences(analysis_id,item_position,position,data) VALUES ('analysis',0,-1,'{}')").run()).toThrow();
      expect(() => connection.prepare("INSERT INTO material_analysis_unmatched_occurrences(analysis_id,item_position,position,data) VALUES ('analysis',-1,0,'{}')").run()).toThrow();
    } finally { connection.close(); }
  });

  test('schema rejects duplicate composite relations and missing foreign-key targets', () => {
    const {connection}=openSqliteDatabase(':memory:');
    try {
      expect(()=>connection.prepare("INSERT INTO goal_materials(goal_id,material_id,data) VALUES ('g','m','{}')").run()).toThrow();
      expect(()=>connection.prepare("INSERT INTO vocabulary_assessment_tasks(id,assessment_id,position,data) VALUES ('t','missing',0,'{}')").run()).toThrow();
      connection.prepare("INSERT INTO learners(id,data) VALUES ('schema-learner','{}')").run();
      connection.prepare("INSERT INTO learning_goals(id,learner_id,data) VALUES ('schema-goal','schema-learner','{}')").run();
      connection.prepare("INSERT INTO materials(id,learner_id,data) VALUES ('schema-material','schema-learner','{}')").run();
      connection.prepare("INSERT INTO goal_materials(goal_id,material_id,data) VALUES ('schema-goal','schema-material','{}')").run();
      expect(()=>connection.prepare("INSERT INTO goal_materials(goal_id,material_id,data) VALUES ('schema-goal','schema-material','{}')").run()).toThrow();
      expect(()=>connection.prepare("INSERT INTO study_plans(id,learner_id,date,data) VALUES ('p1','schema-learner','today','{}'),('p2','schema-learner','today','{}')").run()).toThrow();
      expect(()=>connection.prepare("INSERT INTO task_attempts(id,task_id,learner_id,data) VALUES ('a','missing','schema-learner','{}')").run()).toThrow();
      expect(()=>connection.prepare("INSERT INTO material_analysis_unmatched_occurrences(analysis_id,item_position,position,data) VALUES ('missing',0,0,'{}')").run()).toThrow();
    } finally {connection.close();}
  });

  test('schema enforces analysis occurrence keys, source candidate FK, and plan position uniqueness', () => {
    const {connection}=openSqliteDatabase(':memory:');
    try {
      connection.prepare("INSERT INTO learners(id,data) VALUES ('constraints-learner','{}')").run();
      connection.prepare("INSERT INTO materials(id,learner_id,data) VALUES ('constraints-material','constraints-learner','{}')").run();
      connection.prepare("INSERT INTO material_analyses(id,material_id,data) VALUES ('constraints-analysis','constraints-material','{}')").run();
      connection.prepare("INSERT INTO knowledge_points(id,data) VALUES ('constraints-kp','{}')").run();
      connection.prepare("INSERT INTO material_analysis_items(analysis_id,knowledge_point_id,position,data) VALUES ('constraints-analysis','constraints-kp',0,'{}')").run();
      expect(()=>connection.prepare("INSERT INTO material_analysis_items(analysis_id,knowledge_point_id,position,data) VALUES ('constraints-analysis','constraints-kp',1,'{}')").run()).toThrow();
      expect(()=>connection.prepare("INSERT INTO material_analysis_occurrences(analysis_id,knowledge_point_id,position,data) VALUES ('constraints-analysis','constraints-kp',-1,'{}')").run()).toThrow();
      connection.prepare("INSERT INTO material_analysis_occurrences(analysis_id,knowledge_point_id,position,data) VALUES ('constraints-analysis','constraints-kp',0,'{}')").run();
      expect(()=>connection.prepare("INSERT INTO material_analysis_occurrences(analysis_id,knowledge_point_id,position,data) VALUES ('constraints-analysis','constraints-kp',0,'{}')").run()).toThrow();
      connection.prepare("INSERT INTO learning_goals(id,learner_id,data) VALUES ('constraints-goal','constraints-learner','{}')").run();
      expect(()=>connection.prepare("INSERT INTO goal_knowledge_point_sources(goal_id,knowledge_point_id,source_analysis_id,data) VALUES ('constraints-goal','constraints-kp','constraints-analysis','{}')").run()).toThrow();
      connection.prepare("INSERT INTO goal_knowledge_points(goal_id,knowledge_point_id,data) VALUES ('constraints-goal','constraints-kp','{}')").run();
      connection.prepare("INSERT INTO goal_knowledge_point_sources(goal_id,knowledge_point_id,source_analysis_id,data) VALUES ('constraints-goal','constraints-kp','constraints-analysis','{}')").run();
      connection.prepare("INSERT INTO study_plans(id,learner_id,date,data) VALUES ('constraints-plan','constraints-learner','today','{}')").run();
      connection.prepare("INSERT INTO learning_tasks(id,learner_id,goal_id,data) VALUES ('constraints-task-a','constraints-learner','constraints-goal','{}'),('constraints-task-b','constraints-learner','constraints-goal','{}')").run();
      connection.prepare("INSERT INTO study_plan_tasks(plan_id,task_id,position) VALUES ('constraints-plan','constraints-task-a',0)").run();
      expect(()=>connection.prepare("INSERT INTO study_plan_tasks(plan_id,task_id,position) VALUES ('constraints-plan','constraints-task-b',0)").run()).toThrow();
      expect(()=>connection.prepare("INSERT INTO study_plan_tasks(plan_id,task_id,position) VALUES ('constraints-plan','constraints-task-b',-1)").run()).toThrow();
    } finally {connection.close();}
  });

  test('foreign keys restrict referenced parents and repository removes analysis child rows explicitly', () => {
    const {connection}=openSqliteDatabase(':memory:');
    try {
      connection.prepare("INSERT INTO learners(id,data) VALUES ('cascade-learner','{}')").run();
      connection.prepare("INSERT INTO learning_goals(id,learner_id,data) VALUES ('cascade-goal','cascade-learner','{}')").run();
      connection.prepare("INSERT INTO knowledge_points(id,data) VALUES ('cascade-kp','{}')").run();
      connection.prepare("INSERT INTO goal_knowledge_points(goal_id,knowledge_point_id,data) VALUES ('cascade-goal','cascade-kp','{}')").run();
      // Seed mutually dependent fixture rows before exercising FK restrictions.
      connection.pragma('foreign_keys = OFF');
      connection.prepare("INSERT INTO materials(id,learner_id,data) VALUES ('cascade-material','cascade-learner','{}')").run();
      connection.prepare("INSERT INTO material_analyses(id,material_id,data) VALUES ('cascade-analysis','cascade-material','{}')").run();
      connection.prepare("INSERT INTO goal_knowledge_point_sources(goal_id,knowledge_point_id,source_analysis_id,data) VALUES ('cascade-goal','cascade-kp','cascade-analysis','{}')").run();
      connection.pragma('foreign_keys = ON');
      connection.prepare("INSERT INTO material_analysis_unmatched_items(analysis_id,position,data) VALUES ('cascade-analysis',0,'{}')").run();
      connection.prepare("INSERT INTO material_analysis_unmatched_occurrences(analysis_id,item_position,position,data) VALUES ('cascade-analysis',0,0,'{}')").run();
      expect(()=>connection.prepare("DELETE FROM material_analyses WHERE id='cascade-analysis'").run()).toThrow();
      expect(()=>connection.prepare("DELETE FROM learning_goals WHERE id='cascade-goal'").run()).toThrow();
      expect((connection.prepare('SELECT COUNT(*) AS count FROM goal_knowledge_points').get() as {count:number}).count).toBe(1);
      connection.prepare("DELETE FROM goal_knowledge_point_sources WHERE goal_id='cascade-goal'").run();
      connection.prepare("DELETE FROM material_analysis_unmatched_occurrences WHERE analysis_id='cascade-analysis'").run();
      connection.prepare("DELETE FROM material_analysis_unmatched_items WHERE analysis_id='cascade-analysis'").run();
      connection.prepare("DELETE FROM material_analyses WHERE id='cascade-analysis'").run();
      expect((connection.prepare('SELECT COUNT(*) AS count FROM material_analysis_unmatched_items').get() as {count:number}).count).toBe(0);
      expect((connection.prepare('SELECT COUNT(*) AS count FROM material_analysis_unmatched_occurrences').get() as {count:number}).count).toBe(0);
    } finally {connection.close();}
  });

  test('fine-grained app ports share the aggregate state and revision', async () => {
    const { connection } = openSqliteDatabase(':memory:');
    try {
      const repository = new SqliteLearningStateRepository(connection);
      const empty = repository.load();
      const learner = { id:'port-learner',currentVocabulary:null,timezone:'UTC',dailyTaskCapacity:1,createdAt:'now',updatedAt:'now' };
      const goal = { id:'port-goal',learnerId:learner.id,title:'test',targetFluency:{R:80,P:80},status:'active',createdAt:'now',updatedAt:'now' };
      repository.save({ ...empty.state,learners:[learner],goals:[goal] } as any,empty.revision);
      expect(await repository.loadLearner(learner.id)).toEqual(learner);
      const context=await repository.loadSelectionContext(goal.id);
      expect(context?.goal).toEqual(goal);
      await repository.saveKnowledgePointSelection({updatedCandidates:[],newLearnerKnowledgePoints:[],newClassifications:[]});
      expect(repository.load().revision).toBe(2);
    } finally { connection.close(); }
  });

  test('updates vocabulary assessment task positions when order changes', () => {
    const { connection } = openSqliteDatabase(':memory:');
    try {
      const repository = new SqliteLearningStateRepository(connection);
      const empty = repository.load();
      const learner = { id:'order-learner',currentVocabulary:null,timezone:'UTC',dailyTaskCapacity:1,createdAt:'now',updatedAt:'now' };
      const assessment = { id:'order-assessment',learnerId:learner.id,taskIds:['a','b'],createdAt:'now',status:'in_progress',result:null,completedAt:null };
      const a={id:'a',band:'1k',knowledgePoint:{id:'kp-a',kind:'word',lemma:'a',wordFamily:'a',sense:{id:'s',definition:'a',partOfSpeech:null,explanation:null}}};
      const b={...a,id:'b',knowledgePoint:{...a.knowledgePoint,id:'kp-b',lemma:'b',wordFamily:'b'}};
      const first={...empty.state,learners:[learner],vocabularyAssessments:[assessment],vocabularyAssessmentTasks:[a,b],knowledgePoints:[a.knowledgePoint,b.knowledgePoint]};
      repository.save(first as any,empty.revision);
      repository.save({...first,vocabularyAssessmentTasks:[b,a]} as any,1);
      expect(repository.load().state.vocabularyAssessmentTasks.map(x=>x.id)).toEqual(['b','a']);
      expect(connection.prepare('SELECT id,position FROM vocabulary_assessment_tasks ORDER BY position').all()).toEqual([{id:'b',position:0},{id:'a',position:1}]);
    } finally { connection.close(); }
  });
});
