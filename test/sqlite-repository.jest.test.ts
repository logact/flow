import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { emptyLearningState } from '../lib/server/memory-repository';
import { ConcurrencyConflictError } from '../lib/application/repository';
import { openSqliteDatabase } from '../lib/server/sqlite/database';
import { SqliteLearningStateRepository } from '../lib/server/sqlite/repository';

describe('SQLite learning state repository', () => {
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
