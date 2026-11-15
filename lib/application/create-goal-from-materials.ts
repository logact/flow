import type { FluencyScores, GoalKnowledgePointSelection } from '../domain/model';
import type { GoalMaterialRepository, KnowledgePointSelectionRepository, VocabularyIndex } from './ports';
import { addMaterialToGoalUseCase } from './goal-material';
import { selectKnowledgePointsUseCase } from './knowledge-point-selection';

export interface CreateGoalFromMaterialsInput {
  goalId: string;
  learnerId: string;
  title: string;
  targetFluency: FluencyScores;
  materials: Array<{ materialId: string; analysisId: string }>;
  selections: Array<{ knowledgePointId: string; selection: GoalKnowledgePointSelection }>;
  now: string;
}

export type CreateGoalFromMaterialsResult =
  | { ok: true; goal: { id: string; title: string }; candidateCount: number; initializedCount: number }
  | { ok: false; reason: string };

/**
 * 应用层编排 S05/S06：按顺序向同一目标加入材料，再一次性保存知识点选择。
 * 调用方复用稳定的 goalId 重试时，S05 对已关联材料幂等，避免部分失败后重复创建目标。
 */
export async function createGoalFromMaterialsUseCase(
  deps: {
    repository: GoalMaterialRepository & KnowledgePointSelectionRepository;
    vocabularyIndex?: VocabularyIndex;
  },
  input: CreateGoalFromMaterialsInput,
): Promise<CreateGoalFromMaterialsResult> {
  if (typeof input.goalId !== 'string' || !input.goalId.trim()
    || typeof input.learnerId !== 'string' || !input.learnerId.trim()
    || typeof input.title !== 'string' || !input.title.trim()
    || !Array.isArray(input.materials) || !input.materials.length) {
    return { ok: false, reason: 'invalid_input' };
  }

  const learner = await deps.repository.loadLearner(input.learnerId);
  if (!learner) return { ok: false, reason: 'learner_not_found' };
  const existingGoal = await deps.repository.loadGoal(input.goalId);
  if (existingGoal && existingGoal.learnerId !== input.learnerId) {
    return { ok: false, reason: 'goal_conflict' };
  }

  const materialIds = new Set<string>();
  const candidateIds = new Set<string>();
  for (const item of input.materials) {
    if (!item || typeof item.materialId !== 'string' || !item.materialId.trim()
      || typeof item.analysisId !== 'string' || !item.analysisId.trim() || materialIds.has(item.materialId)) {
      return { ok: false, reason: 'invalid_input' };
    }
    materialIds.add(item.materialId);
    const material = await deps.repository.loadMaterial(item.materialId);
    if (!material) return { ok: false, reason: 'material_not_found' };
    if (material.learnerId !== input.learnerId) return { ok: false, reason: 'material_conflict' };
    const analysis = await deps.repository.loadAnalysis(item.analysisId);
    if (!analysis) return { ok: false, reason: 'analysis_not_found' };
    if (analysis.materialId !== material.id) return { ok: false, reason: 'analysis_conflict' };
    if (analysis.status !== 'analyzed') return { ok: false, reason: 'analysis_not_analyzed' };
    analysis.items.forEach((analysisItem) => candidateIds.add(analysisItem.knowledgePoint.id));
  }

  if (!Array.isArray(input.selections)) return { ok: false, reason: 'invalid_input' };
  const selectedIds = new Set<string>();
  for (const selection of input.selections) {
    if (!selection || typeof selection.knowledgePointId !== 'string'
      || !['undecided', 'included', 'excluded'].includes(selection.selection)) {
      return { ok: false, reason: 'invalid_input' };
    }
    if (!candidateIds.has(selection.knowledgePointId)) return { ok: false, reason: 'unknown_candidate' };
    if (selectedIds.has(selection.knowledgePointId)) return { ok: false, reason: 'invalid_input' };
    selectedIds.add(selection.knowledgePointId);
  }

  let goal: { id: string; title: string } | null = null;
  let candidateCount = 0;
  for (let index = 0; index < input.materials.length; index += 1) {
    const material = input.materials[index];
    const result = await addMaterialToGoalUseCase(
      { repository: deps.repository },
      {
        goalId: input.goalId,
        learnerId: input.learnerId,
        title: index === 0 ? input.title : undefined,
        targetFluency: index === 0 ? input.targetFluency : undefined,
        materialId: material.materialId,
        analysisId: material.analysisId,
        addedAt: input.now,
        now: input.now,
      },
    );
    if (!result.ok) return result;
    goal = { id: result.goal.id, title: result.goal.title };
    candidateCount = result.candidates.length;
  }

  let initializedCount = 0;
  if (input.selections.length > 0) {
    const selected = await selectKnowledgePointsUseCase(
      { repository: deps.repository, vocabularyIndex: deps.vocabularyIndex },
      {
        goalId: input.goalId,
        selections: input.selections,
        policyVersion: 'v1',
        now: input.now,
      },
    );
    if (!selected.ok) return selected;
    initializedCount = selected.initialized.length;
  }

  if (!goal) return { ok: false, reason: 'invalid_input' };
  return { ok: true, goal, candidateCount, initializedCount };
}
