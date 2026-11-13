/**
 * 服务端内存基础设施：唯一 LearningState + 乐观锁版本号，
 * 同时实现全部应用层 Repository 端口（状态、材料、目标、知识点选择、S08 上下文），
 * 使所有用例写入都走同一个状态源。原型阶段使用；生产实现切换为 SQLite。
 * 与 test/helpers/in-memory-app-repository.ts 保持同一语义。
 */

import type {
  GoalMaterialRepository,
  KnowledgePointSelectionContext,
  KnowledgePointSelectionRepository,
  LearningTaskRepository,
  MaterialRepository,
  SaveGoalMaterialPayload,
  SaveKnowledgePointSelectionPayload,
  TaskGenerationContext,
} from '../application/ports';
import {
  ConcurrencyConflictError,
  type LearningStateRepository,
  type LearningStateSnapshot,
} from '../application/repository';
import type * as Model from '../domain/model';

export class InMemoryAppRepository implements
  LearningStateRepository,
  MaterialRepository,
  GoalMaterialRepository,
  KnowledgePointSelectionRepository,
  LearningTaskRepository {
  private snapshot: LearningStateSnapshot;

  constructor(initial: Model.LearningState) {
    this.snapshot = { state: initial, revision: 0 };
  }

  load(): LearningStateSnapshot {
    return this.snapshot;
  }

  save(next: Model.LearningState, expectedRevision: number): LearningStateSnapshot {
    if (this.snapshot.revision !== expectedRevision) {
      throw new ConcurrencyConflictError(expectedRevision, this.snapshot.revision);
    }
    this.snapshot = { state: next, revision: expectedRevision + 1 };
    return this.snapshot;
  }

  async saveMaterialWithAnalysis(
    material: Model.Material,
    analysis: Extract<Model.MaterialAnalysis, { status: 'analyzed' }>,
  ): Promise<void> {
    const state = this.snapshot.state;
    this.save(
      {
        ...state,
        materials: [...state.materials, material],
        materialAnalyses: [...state.materialAnalyses, analysis],
      },
      this.snapshot.revision,
    );
  }

  async loadLearner(learnerId: string): Promise<Model.Learner | null> {
    return this.snapshot.state.learners.find((item) => item.id === learnerId) ?? null;
  }

  async loadGoal(goalId: string): Promise<Model.LearningGoal | null> {
    return this.snapshot.state.goals.find((item) => item.id === goalId) ?? null;
  }

  async loadMaterial(materialId: string): Promise<Model.Material | null> {
    return this.snapshot.state.materials.find((item) => item.id === materialId) ?? null;
  }

  async loadAnalysis(analysisId: string): Promise<Model.MaterialAnalysis | null> {
    return this.snapshot.state.materialAnalyses.find((item) => item.id === analysisId) ?? null;
  }

  async loadGoalScope(goalId: string) {
    const state = this.snapshot.state;
    return {
      materialLinks: state.goalMaterials.filter((link) => link.goalId === goalId),
      candidates: state.goalKnowledgePoints.filter((item) => item.goalId === goalId),
      sources: state.goalKnowledgePointSources.filter((item) => item.goalId === goalId),
    };
  }

  async saveGoalMaterial(payload: SaveGoalMaterialPayload): Promise<void> {
    const state = this.snapshot.state;
    const upsertBy = <T>(items: T[], incoming: T[], same: (a: T, b: T) => boolean): T[] => {
      const next = [...items];
      for (const item of incoming) {
        const index = next.findIndex((existing) => same(existing, item));
        if (index >= 0) next[index] = item;
        else next.push(item);
      }
      return next;
    };
    this.save(
      {
        ...state,
        goals: upsertBy(state.goals, [payload.goal], (a, b) => a.id === b.id),
        goalMaterials: upsertBy(
          state.goalMaterials,
          [payload.materialLink],
          (a, b) => a.goalId === b.goalId && a.materialId === b.materialId,
        ),
        knowledgePoints: upsertBy(state.knowledgePoints, payload.knowledgePoints, (a, b) => a.id === b.id),
        goalKnowledgePoints: upsertBy(
          state.goalKnowledgePoints,
          payload.candidates,
          (a, b) => a.goalId === b.goalId && a.knowledgePointId === b.knowledgePointId,
        ),
        goalKnowledgePointSources: upsertBy(
          state.goalKnowledgePointSources,
          payload.sources,
          (a, b) => a.goalId === b.goalId
            && a.knowledgePointId === b.knowledgePointId
            && a.sourceAnalysisId === b.sourceAnalysisId,
        ),
      },
      this.snapshot.revision,
    );
  }

  async loadSelectionContext(goalId: string): Promise<KnowledgePointSelectionContext | null> {
    const state = this.snapshot.state;
    const goal = state.goals.find((item) => item.id === goalId);
    if (!goal) return null;
    const learner = state.learners.find((item) => item.id === goal.learnerId);
    if (!learner) return null;
    const knowledgePointIds = new Set(
      state.goalKnowledgePoints.filter((item) => item.goalId === goalId).map((item) => item.knowledgePointId),
    );
    return {
      learner,
      goal,
      candidates: state.goalKnowledgePoints.filter((item) => item.goalId === goalId),
      knowledgePoints: state.knowledgePoints.filter((item) => knowledgePointIds.has(item.id)),
      classifications: state.knowledgePointVocabularyClassifications.filter((item) =>
        knowledgePointIds.has(item.knowledgePointId),
      ),
      learnerKnowledgePoints: state.learnerKnowledgePoints.filter(
        (item) => item.learnerId === learner.id && knowledgePointIds.has(item.knowledgePointId),
      ),
    };
  }

  async saveKnowledgePointSelection(payload: SaveKnowledgePointSelectionPayload): Promise<void> {
    const state = this.snapshot.state;
    const changed = new Map(
      payload.updatedCandidates.map((item) => [`${item.goalId}:${item.knowledgePointId}`, item]),
    );
    this.save(
      {
        ...state,
        goalKnowledgePoints: state.goalKnowledgePoints.map(
          (item) => changed.get(`${item.goalId}:${item.knowledgePointId}`) ?? item,
        ),
        learnerKnowledgePoints: [
          ...state.learnerKnowledgePoints,
          ...payload.newLearnerKnowledgePoints,
        ],
        knowledgePointVocabularyClassifications: [
          ...state.knowledgePointVocabularyClassifications,
          ...payload.newClassifications,
        ],
      },
      this.snapshot.revision,
    );
  }

  async loadTaskGenerationContext(
    goalId: string,
    knowledgePointId: string,
  ): Promise<TaskGenerationContext | null> {
    const state = this.snapshot.state;
    const goal = state.goals.find((item) => item.id === goalId) ?? null;
    const candidate = state.goalKnowledgePoints.find(
      (item) => item.goalId === goalId && item.knowledgePointId === knowledgePointId,
    ) ?? null;
    const knowledgePoint = state.knowledgePoints.find((item) => item.id === knowledgePointId) ?? null;
    if (!goal || !candidate || !knowledgePoint) return null;
    const learner = state.learners.find((item) => item.id === goal.learnerId) ?? null;
    const materialsById = new Map<string, Model.Material>();
    for (const source of state.goalKnowledgePointSources) {
      if (source.goalId !== goalId || source.knowledgePointId !== knowledgePointId) continue;
      const analysis = state.materialAnalyses.find((item) => item.id === source.sourceAnalysisId);
      const material = analysis
        ? state.materials.find((item) => item.id === analysis.materialId)
        : undefined;
      if (material) materialsById.set(material.id, material);
    }
    return {
      goal,
      candidate,
      knowledgePoint,
      sourceMaterials: [...materialsById.values()],
      learnerVocabulary: learner?.currentVocabulary ?? null,
    };
  }
}

export function emptyLearningState(): Model.LearningState {
  return {
    learners: [],
    vocabularyAssessments: [],
    vocabularyAssessmentTasks: [],
    vocabularyAssessmentAttempts: [],
    materials: [],
    materialAnalyses: [],
    goals: [],
    goalMaterials: [],
    knowledgePoints: [],
    knowledgePointVocabularyClassifications: [],
    goalKnowledgePoints: [],
    goalKnowledgePointSources: [],
    learnerKnowledgePoints: [],
    studyPlans: [],
    tasks: [],
    attempts: [],
  };
}
