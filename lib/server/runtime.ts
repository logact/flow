import path from 'node:path';
import { createTaskAIJudgeFromEnv, type TaskAIJudge } from '../application/ai-judge';
import { addMaterialToGoalUseCase } from '../application/goal-material';
import { createLearnerUseCase } from '../application/learner-settings';
import { importMaterialUseCase } from '../application/material-import';
import { createOpenAITaskGenerationProvider } from '../application/openai-task-provider';
import type {
  SenseDisambiguator,
  SenseInventory,
  TaskGenerationAIProvider,
  VocabularyIndex,
} from '../application/ports';
import { loadSenseInventoryFromFile } from '../application/sense-inventory';
import { createSenseDisambiguatorFromEnv } from '../application/sense-disambiguator';
import type { VocabularyListRepository } from '../application/vocabulary-assessment';
import { createVocabularyDecisionFilter, loadVocabularyIndexFromFile } from '../application/vocabulary-index';
import type { Learner } from '../domain/model';
import { InMemoryAppRepository, emptyLearningState } from './memory-repository';
import { BNC_COCA_L6, createFileVocabularyListRepository } from './vocabulary-list-repository';

/**
 * 服务端运行时单例：内存仓库 + 全部基础设施端口 + 演示种子数据。
 * 原型阶段进程内共享一份状态（dev 热更新通过 globalThis 保持）；
 * 切换 SQLite 持久化时只替换 repository 实现，用例与路由不变。
 */

export const DEMO_LEARNER_ID = 'demo-learner';
export const DEMO_GOAL_ID = 'demo-goal';
export const DEMO_MATERIAL_ID = 'demo-material';
export const DEMO_ANALYSIS_ID = 'demo-analysis';

const SEED_MATERIAL_TITLE = '海岸漫步（种子材料）';
const SEED_MATERIAL_TEXT = [
  'The meandering path climbed toward a towering cliff above the sea.',
  'Every traveler who reached the top spoke of the authenticity of the moment: the murky water below, the debonair lighthouse keeper, and the resilient grass growing between the stones.',
  'Such ubiquitous signs of life made the long walk worthwhile.',
].join('\n');

export interface FlowRuntime {
  repository: InMemoryAppRepository;
  senseInventory: SenseInventory;
  vocabularyIndex: VocabularyIndex;
  vocabularyListRepository: VocabularyListRepository;
  vocabularyFilter: ReturnType<typeof createVocabularyDecisionFilter>;
  taskGenerationProvider: TaskGenerationAIProvider;
  senseDisambiguator: SenseDisambiguator;
  aiJudge: TaskAIJudge;
  /** 是否配置了 LLM_API_KEY；未配置时任务生成与 AI 评判不可用。 */
  llmConfigured: boolean;
  /** 种子数据就绪后才 resolve；路由应先 await。 */
  ready: Promise<void>;
}

const globalForRuntime = globalThis as unknown as { flowRuntime?: FlowRuntime };

function createRuntime(): FlowRuntime {
  const senseInventory = loadSenseInventoryFromFile(
    path.join(process.cwd(), 'data', 'sense-inventory-v1.json'),
  );
  const vocabularyIndex = loadVocabularyIndexFromFile(
    path.join(process.cwd(), 'data', 'bnc-coca-l6-v2.0.0.json'),
  );
  const llmConfigured = Boolean(process.env.LLM_API_KEY);
  const runtime: FlowRuntime = {
    repository: new InMemoryAppRepository(emptyLearningState()),
    senseInventory,
    vocabularyIndex,
    vocabularyListRepository: createFileVocabularyListRepository(),
    vocabularyFilter: createVocabularyDecisionFilter(vocabularyIndex),
    taskGenerationProvider: createOpenAITaskGenerationProvider(),
    senseDisambiguator: createSenseDisambiguatorFromEnv(),
    aiJudge: createTaskAIJudgeFromEnv(),
    llmConfigured,
    ready: Promise.resolve(),
  };
  // 种子失败时重置仓库避免半初始化状态，错误随 ready 抛出，路由返回 500。
  runtime.ready = seed(runtime).catch((error) => {
    runtime.repository = new InMemoryAppRepository(emptyLearningState());
    throw error;
  });
  return runtime;
}

/** 首次启动时预置演示学习者、种子材料与演示目标；全部幂等。 */
async function seed(runtime: FlowRuntime): Promise<void> {
  const now = new Date().toISOString();
  const state = runtime.repository.load().state;

  if (!state.learners.some((learner) => learner.id === DEMO_LEARNER_ID)) {
    createLearnerUseCase(runtime.repository, {
      id: DEMO_LEARNER_ID,
      timezone: 'Asia/Shanghai',
      dailyTaskCapacity: 12,
      now,
    });
  }

  if (!runtime.repository.load().state.materials.some((item) => item.id === DEMO_MATERIAL_ID)) {
    await importMaterialUseCase(
      {
        repository: runtime.repository,
        senseInventory: runtime.senseInventory,
        // 种子材料不调用 AI 消歧：单义词条直接取词义库，多义词条回退占位义项。
        vocabularyFilter: runtime.vocabularyFilter,
      },
      {
        materialId: DEMO_MATERIAL_ID,
        analysisId: DEMO_ANALYSIS_ID,
        learnerId: DEMO_LEARNER_ID,
        title: SEED_MATERIAL_TITLE,
        filename: 'seed-coastal-walk.txt',
        extractedText: SEED_MATERIAL_TEXT,
        analyzerVersion: 'seed-v1',
        now,
      },
    );
  }

  if (!runtime.repository.load().state.goals.some((goal) => goal.id === DEMO_GOAL_ID)) {
    await addMaterialToGoalUseCase(
      { repository: runtime.repository },
      {
        goalId: DEMO_GOAL_ID,
        learnerId: DEMO_LEARNER_ID,
        title: '演示学习目标',
        targetFluency: { R: 80, P: 80 },
        materialId: DEMO_MATERIAL_ID,
        analysisId: DEMO_ANALYSIS_ID,
        addedAt: now,
        now,
      },
    );
  }
}

export function getRuntime(): FlowRuntime {
  if (!globalForRuntime.flowRuntime) {
    globalForRuntime.flowRuntime = createRuntime();
  }
  return globalForRuntime.flowRuntime;
}

/** 等待种子完成并返回演示学习者。 */
export async function getDemoLearner(): Promise<Learner> {
  const runtime = getRuntime();
  await runtime.ready;
  const learner = runtime.repository.load().state.learners.find((item) => item.id === DEMO_LEARNER_ID);
  if (!learner) throw new Error(`Demo learner not persisted: ${DEMO_LEARNER_ID}`);
  return learner;
}

export { BNC_COCA_L6 };
