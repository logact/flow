import type Database from 'better-sqlite3';
import type { LearningState } from '../../domain/model';
import type { GoalMaterialRepository, KnowledgePointSelectionContext, KnowledgePointSelectionRepository, LearningTaskRepository, MaterialRepository, SaveGoalMaterialPayload, SaveKnowledgePointSelectionPayload, TaskGenerationContext } from '../../application/ports';
import { ConcurrencyConflictError, type LearningStateRepository, type LearningStateSnapshot } from '../../application/repository';

type Descriptor = {
  property: keyof LearningState;
  table: string;
  primary: string[];
  values: (item: any, index: number) => unknown[];
  keyOf: (item: any) => string;
};
const descriptors: Descriptor[] = [
  {property:'learners',table:'learners',primary:['id'],values:x=>[x.id],keyOf:x=>x.id},
  {property:'vocabularyAssessments',table:'vocabulary_assessments',primary:['id'],values:x=>[x.id,x.learnerId],keyOf:x=>x.id},
  {property:'vocabularyAssessmentTasks',table:'vocabulary_assessment_tasks',primary:['id'],values:(x,i)=>[x.id,x.assessmentId,i],keyOf:x=>x.id},
  {property:'vocabularyAssessmentAttempts',table:'vocabulary_assessment_attempts',primary:['id'],values:x=>[x.id,x.assessmentId,x.taskId],keyOf:x=>x.id},
  {property:'materials',table:'materials',primary:['id'],values:x=>[x.id,x.learnerId],keyOf:x=>x.id},
  {property:'materialAnalyses',table:'material_analyses',primary:['id'],values:x=>[x.id,x.materialId],keyOf:x=>x.id},
  {property:'knowledgePoints',table:'knowledge_points',primary:['id'],values:x=>[x.id],keyOf:x=>x.id},
  {property:'goals',table:'learning_goals',primary:['id'],values:x=>[x.id,x.learnerId],keyOf:x=>x.id},
  {property:'goalMaterials',table:'goal_materials',primary:['goal_id','material_id'],values:x=>[x.goalId,x.materialId],keyOf:x=>`${x.goalId}\0${x.materialId}`},
  {property:'goalKnowledgePoints',table:'goal_knowledge_points',primary:['goal_id','knowledge_point_id'],values:x=>[x.goalId,x.knowledgePointId],keyOf:x=>`${x.goalId}\0${x.knowledgePointId}`},
  {property:'goalKnowledgePointSources',table:'goal_knowledge_point_sources',primary:['goal_id','knowledge_point_id','source_analysis_id'],values:x=>[x.goalId,x.knowledgePointId,x.sourceAnalysisId],keyOf:x=>`${x.goalId}\0${x.knowledgePointId}\0${x.sourceAnalysisId}`},
  {property:'knowledgePointVocabularyClassifications',table:'knowledge_point_vocabulary_classifications',primary:['key'],values:x=>[`${x.knowledgePointId}\0${x.list.id}\0${x.list.version}`,x.knowledgePointId],keyOf:x=>`${x.knowledgePointId}\0${x.list.id}\0${x.list.version}`},
  {property:'learnerKnowledgePoints',table:'learner_knowledge_points',primary:['key'],values:x=>[`${x.learnerId}\0${x.knowledgePointId}`,x.learnerId,x.knowledgePointId],keyOf:x=>`${x.learnerId}\0${x.knowledgePointId}`},
  {property:'studyPlans',table:'study_plans',primary:['id'],values:x=>[x.id,x.learnerId,x.date],keyOf:x=>x.id},
  {property:'tasks',table:'learning_tasks',primary:['id'],values:x=>[x.id,x.learnerId,x.goalId],keyOf:x=>x.id},
  {property:'attempts',table:'task_attempts',primary:['id'],values:x=>[x.id,x.taskId,x.learnerId],keyOf:x=>x.id},
];

function decode<T>(value:string):T {
  try { return JSON.parse(value) as T; } catch { throw new Error('Invalid JSON in SQLite domain row'); }
}

/** Relation-backed aggregate repository. Each table stores one stable domain payload in its data column. */
export class SqliteLearningStateRepository implements LearningStateRepository, MaterialRepository, GoalMaterialRepository, KnowledgePointSelectionRepository, LearningTaskRepository {
  constructor(private readonly connection: Database.Database) {}

  load(): LearningStateSnapshot {
    const state: any = {};
    for (const descriptor of descriptors) {
      const rows = this.connection.prepare(`SELECT data FROM ${descriptor.table}${descriptor.property==='vocabularyAssessmentTasks'?' ORDER BY position':''}`).all() as Array<{data:string}>;
      state[descriptor.property] = rows.map(row=>decode(row.data));
    }
    const planTasks = this.connection.prepare('SELECT plan_id,task_id,position FROM study_plan_tasks ORDER BY plan_id,position').all() as Array<{plan_id:string;task_id:string;position:number}>;
    for (const plan of state.studyPlans) plan.taskIds = planTasks.filter(x=>x.plan_id===plan.id).sort((a,b)=>a.position-b.position).map(x=>x.task_id);
    for (const analysis of state.materialAnalyses) if (analysis.status==='analyzed') {
      const items=this.connection.prepare('SELECT knowledge_point_id,position FROM material_analysis_items WHERE analysis_id=? ORDER BY position').all(analysis.id) as Array<{knowledge_point_id:string;position:number}>;
      if(items.length) analysis.items=items.map(item=>({knowledgePoint:state.knowledgePoints.find((kp:any)=>kp.id===item.knowledge_point_id),occurrences:(this.connection.prepare('SELECT data FROM material_analysis_occurrences WHERE analysis_id=? AND knowledge_point_id=? ORDER BY position').all(analysis.id,item.knowledge_point_id) as Array<{data:string}>).map(x=>decode(x.data))}));
      const unmatched=this.connection.prepare('SELECT position,data FROM material_analysis_unmatched_items WHERE analysis_id=? ORDER BY position').all(analysis.id) as Array<{position:number;data:string}>;
      if(unmatched.length) analysis.unmatchedItems=unmatched.map(item=>({...decode<any>(item.data),occurrences:(this.connection.prepare('SELECT data FROM material_analysis_unmatched_occurrences WHERE analysis_id=? AND item_position=? ORDER BY position').all(analysis.id,item.position) as Array<{data:string}>).map(x=>decode(x.data))}));
    }
    const revision = (this.connection.prepare("SELECT revision FROM repository_meta WHERE key='main'").get() as {revision:number}).revision;
    return {state:state as LearningState,revision};
  }

  save(next:LearningState, expectedRevision:number):LearningStateSnapshot {
    const write = this.connection.transaction(() => {
      const row = this.connection.prepare("SELECT revision FROM repository_meta WHERE key='main'").get() as {revision:number}|undefined;
      if (!row) throw new Error('Missing repository_meta main revision');
      if (row.revision!==expectedRevision) throw new ConcurrencyConflictError(expectedRevision,row.revision);
      // Plan task links have no payload column; synchronize them by the full composite key.
      const planLinks=next.studyPlans.flatMap(plan=>plan.taskIds.map((taskId,position)=>({planId:plan.id,taskId,position})));
      const oldLinks=this.connection.prepare('SELECT plan_id,task_id,position FROM study_plan_tasks').all() as Array<{plan_id:string;task_id:string;position:number}>;
      const incomingLinks=new Map(planLinks.map(x=>[`${x.planId}\0${x.taskId}`,x.position]));
      const deleteLink=this.connection.prepare('DELETE FROM study_plan_tasks WHERE plan_id=? AND task_id=?');
      for(const link of oldLinks) if(!incomingLinks.has(`${link.plan_id}\0${link.task_id}`)) deleteLink.run(link.plan_id,link.task_id);
      const oldAnalysisIds=new Set((this.connection.prepare('SELECT id FROM material_analyses').all() as Array<{id:string}>).map(x=>x.id));
      // Remove only rows absent from the new state, in reverse FK dependency order.
      for (const descriptor of [...descriptors].reverse()) {
        const records = next[descriptor.property] as unknown as any[];
        const incoming = new Set(records.map(descriptor.keyOf));
        const rows = this.connection.prepare(`SELECT data FROM ${descriptor.table}`).all() as Array<{data:string}>;
        const remove = this.connection.prepare(`DELETE FROM ${descriptor.table} WHERE ${descriptor.primary.map(c=>`${c}=?`).join(' AND ')}`);
        for (const stored of rows) {
          const item = decode<any>(stored.data);
          if (!incoming.has(descriptor.keyOf(item))) {
            if(descriptor.table==='material_analyses') {
              this.connection.prepare('DELETE FROM material_analysis_occurrences WHERE analysis_id=?').run(item.id);
              this.connection.prepare('DELETE FROM material_analysis_items WHERE analysis_id=?').run(item.id);
              this.connection.prepare('DELETE FROM material_analysis_unmatched_occurrences WHERE analysis_id=?').run(item.id);
              this.connection.prepare('DELETE FROM material_analysis_unmatched_items WHERE analysis_id=?').run(item.id);
            }
            remove.run(...descriptor.values(item,0).slice(0,descriptor.primary.length));
          }
        }
      }
      for (const descriptor of descriptors) {
        const records = next[descriptor.property] as unknown as any[];
        const columns = [...descriptor.primary];
        const extra = descriptor.table==='vocabulary_assessment_tasks'?['assessment_id','position']
          : descriptor.table==='vocabulary_assessment_attempts'?['assessment_id','task_id']
          : descriptor.table==='vocabulary_assessments'||descriptor.table==='materials'||descriptor.table==='learning_goals'?['learner_id']
          : descriptor.table==='material_analyses'?['material_id']
          : descriptor.table==='goal_knowledge_point_sources'?[]
          : descriptor.table==='knowledge_point_vocabulary_classifications'?['knowledge_point_id']
          : descriptor.table==='learner_knowledge_points'?['learner_id','knowledge_point_id']
          : descriptor.table==='study_plans'?['learner_id','date']
          : descriptor.table==='learning_tasks'?['learner_id','goal_id']
          : descriptor.table==='task_attempts'?['task_id','learner_id']
          : descriptor.table==='goal_materials'||descriptor.table==='goal_knowledge_points'?[] : [];
        const allColumns=[...columns,...extra,'data'];
        const conflict=descriptor.primary.join(',');
        const updates=[...extra,'data'].map(c=>`${c}=excluded.${c}`).join(',');
        const statement=this.connection.prepare(`INSERT INTO ${descriptor.table}(${allColumns.join(',')}) VALUES (${allColumns.map(()=>'?').join(',')}) ON CONFLICT(${conflict}) DO UPDATE SET ${updates}`);
        const find = this.connection.prepare(`SELECT data${descriptor.table==='vocabulary_assessment_tasks'?', position':''} FROM ${descriptor.table} WHERE ${descriptor.primary.map(c=>`${c}=?`).join(' AND ')}`);
        records.forEach((item,index)=>{
          const values=descriptor.table==='vocabulary_assessment_tasks'
            ? [item.id,next.vocabularyAssessments.find(a=>a.taskIds.includes(item.id))?.id,index]
            : descriptor.values(item,index);
          if(descriptor.table==='vocabulary_assessment_tasks' && !values[1]) throw new Error(`Vocabulary assessment task has no owning assessment: ${item.id}`);
          const data=JSON.stringify(item);
          const old=find.get(...values.slice(0,descriptor.primary.length)) as {data:string;position?:number}|undefined;
          if(descriptor.table==='material_analyses' && old && old.data!==data) {
            const previous=JSON.parse(old.data) as LearningState['materialAnalyses'][number];
            const transition=previous.status==='pending' && previous.materialId===item.materialId && item.status!=='pending';
            if(!transition) throw new Error(`Material analysis id is immutable: ${item.id}`);
          }
          if (old?.data===data && (descriptor.table!=='vocabulary_assessment_tasks' || old.position===values[2])) return;
          statement.run(...values,data);
        });
      }
      // Insert new task links and update only positions that actually changed.
      // 位置可能在两次保存之间重排；UNIQUE(plan_id, position) 不允许逐行把旧行改到新
      // 位置（旧行仍占用该位置），因此对仍存在的计划整组重写链接。
      const plansInState=new Set(next.studyPlans.map((plan)=>plan.id));
      const clearPlan=this.connection.prepare('DELETE FROM study_plan_tasks WHERE plan_id=?');
      const insertPlanTask=this.connection.prepare('INSERT INTO study_plan_tasks(plan_id,task_id,position) VALUES (?,?,?)');
      for(const planId of plansInState) clearPlan.run(planId);
      for(const link of planLinks) insertPlanTask.run(link.planId,link.taskId,link.position);
      const insertItem=this.connection.prepare('INSERT OR IGNORE INTO material_analysis_items(analysis_id,knowledge_point_id,position,data) VALUES (?,?,?,?)');
      const insertOccurrence=this.connection.prepare('INSERT OR IGNORE INTO material_analysis_occurrences(analysis_id,knowledge_point_id,position,data) VALUES (?,?,?,?)');
      const insertUnmatched=this.connection.prepare('INSERT OR IGNORE INTO material_analysis_unmatched_items(analysis_id,position,data) VALUES (?,?,?)');
      const insertUnmatchedOccurrence=this.connection.prepare('INSERT OR IGNORE INTO material_analysis_unmatched_occurrences(analysis_id,item_position,position,data) VALUES (?,?,?,?)');
      for(const analysis of next.materialAnalyses) if(analysis.status==='analyzed' && !oldAnalysisIds.has(analysis.id)) {
        analysis.items.forEach((item,index)=>{insertItem.run(analysis.id,item.knowledgePoint.id,index,'{}');item.occurrences.forEach((occurrence,position)=>insertOccurrence.run(analysis.id,item.knowledgePoint.id,position,JSON.stringify(occurrence)));});
        analysis.unmatchedItems.forEach((item,index)=>{const {occurrences,...metadata}=item;insertUnmatched.run(analysis.id,index,JSON.stringify(metadata));occurrences.forEach((occurrence,position)=>insertUnmatchedOccurrence.run(analysis.id,index,position,JSON.stringify(occurrence)));});
      }
      this.connection.prepare("UPDATE repository_meta SET revision=revision+1 WHERE key='main'").run();
      return row.revision+1;
    });
    return {state:next,revision:write.immediate()};
  }

  async saveMaterialWithAnalysis(material:LearningState['materials'][number],analysis:Extract<LearningState['materialAnalyses'][number],{status:'analyzed'}>):Promise<void>{
    const {state,revision}=this.load();
    const extracted=analysis.items.map(item=>item.knowledgePoint);
    this.save({...state,materials:upsert(state.materials,[material],x=>x.id),knowledgePoints:upsert(state.knowledgePoints,extracted,x=>x.id),materialAnalyses:upsert(state.materialAnalyses,[analysis],x=>x.id)},revision);
  }
  async saveMaterial(material:LearningState['materials'][number]):Promise<void>{const {state,revision}=this.load();this.save({...state,materials:upsert(state.materials,[material],x=>x.id)},revision);}
  async saveMaterialAnalysis(materialId:string,analysis:LearningState['materialAnalyses'][number]):Promise<void>{const {state,revision}=this.load();if(!state.materials.some(x=>x.id===materialId))throw new Error('Material not found');this.save({...state,materialAnalyses:upsert(state.materialAnalyses,[analysis],x=>x.id)},revision);}
  async loadLearner(id:string){return this.load().state.learners.find(x=>x.id===id)??null;}
  async loadGoal(id:string){return this.load().state.goals.find(x=>x.id===id)??null;}
  async loadMaterial(id:string){return this.load().state.materials.find(x=>x.id===id)??null;}
  async loadAnalysis(id:string){return this.load().state.materialAnalyses.find(x=>x.id===id)??null;}
  async loadGoalScope(goalId:string){const s=this.load().state;return {materialLinks:s.goalMaterials.filter(x=>x.goalId===goalId),candidates:s.goalKnowledgePoints.filter(x=>x.goalId===goalId),sources:s.goalKnowledgePointSources.filter(x=>x.goalId===goalId)};}
  async saveGoalMaterial(payload:SaveGoalMaterialPayload):Promise<void>{
    const {state,revision}=this.load();
    this.save({...state,goals:upsert(state.goals,[payload.goal],x=>x.id),goalMaterials:upsert(state.goalMaterials,[payload.materialLink],x=>`${x.goalId}/${x.materialId}`),knowledgePoints:upsert(state.knowledgePoints,payload.knowledgePoints,x=>x.id),goalKnowledgePoints:upsert(state.goalKnowledgePoints,payload.candidates,x=>`${x.goalId}/${x.knowledgePointId}`),goalKnowledgePointSources:upsert(state.goalKnowledgePointSources,payload.sources,x=>`${x.goalId}/${x.knowledgePointId}/${x.sourceAnalysisId}`)},revision);
  }
  async loadSelectionContext(goalId:string):Promise<KnowledgePointSelectionContext|null>{
    const s=this.load().state;const goal=s.goals.find(x=>x.id===goalId);if(!goal)return null;const learner=s.learners.find(x=>x.id===goal.learnerId);if(!learner)return null;
    const candidates=s.goalKnowledgePoints.filter(x=>x.goalId===goalId);const ids=new Set(candidates.map(x=>x.knowledgePointId));
    return {learner,goal,candidates,knowledgePoints:s.knowledgePoints.filter(x=>ids.has(x.id)),classifications:s.knowledgePointVocabularyClassifications.filter(x=>ids.has(x.knowledgePointId)),learnerKnowledgePoints:s.learnerKnowledgePoints.filter(x=>x.learnerId===learner.id&&ids.has(x.knowledgePointId))};
  }
  async saveKnowledgePointSelection(payload:SaveKnowledgePointSelectionPayload):Promise<void>{
    const {state,revision}=this.load();const changed=new Map(payload.updatedCandidates.map(x=>[`${x.goalId}/${x.knowledgePointId}`,x]));
    this.save({...state,goalKnowledgePoints:state.goalKnowledgePoints.map(x=>changed.get(`${x.goalId}/${x.knowledgePointId}`)??x),learnerKnowledgePoints:upsert(state.learnerKnowledgePoints,payload.newLearnerKnowledgePoints,x=>`${x.learnerId}/${x.knowledgePointId}`),knowledgePointVocabularyClassifications:upsert(state.knowledgePointVocabularyClassifications,payload.newClassifications,x=>`${x.knowledgePointId}/${x.list.id}/${x.list.version}`)},revision);
  }
  async loadTaskGenerationContext(goalId:string,knowledgePointId:string):Promise<TaskGenerationContext|null>{
    const s=this.load().state;const goal=s.goals.find(x=>x.id===goalId);const candidate=s.goalKnowledgePoints.find(x=>x.goalId===goalId&&x.knowledgePointId===knowledgePointId);const knowledgePoint=s.knowledgePoints.find(x=>x.id===knowledgePointId);if(!goal||!candidate||!knowledgePoint)return null;
    const learner=s.learners.find(x=>x.id===goal.learnerId);const analyses=new Set(s.goalKnowledgePointSources.filter(x=>x.goalId===goalId&&x.knowledgePointId===knowledgePointId).map(x=>x.sourceAnalysisId));const materialIds=new Set(s.materialAnalyses.filter(x=>analyses.has(x.id)).map(x=>x.materialId));
    return {goal,candidate,knowledgePoint,sourceMaterials:s.materials.filter(x=>materialIds.has(x.id)),learnerVocabulary:learner?.currentVocabulary??null};
  }
}

function upsert<T>(existing:T[],incoming:T[],key:(value:T)=>string):T[]{const map=new Map(existing.map(x=>[key(x),x]));for(const x of incoming)map.set(key(x),x);return [...map.values()];}
