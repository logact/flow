import type { TaskSpecification } from '../domain/functions';
import type {
  GoalKnowledgePoint,
  GoalKnowledgePointSource,
  GoalMaterial,
  KnowledgePoint,
  Learner,
  LearningGoal,
  Material,
  MaterialAnalysis,
} from '../domain/model';

/**
 * S08 任务生成所需的领域数据：目标知识点及其来源材料。
 * 由 Repository 按 goalId + knowledgePointId 聚合加载，用例不自行拼装跨表查询。
 */
export interface TaskGenerationContext {
  goal: LearningGoal;
  candidate: GoalKnowledgePoint;
  knowledgePoint: KnowledgePoint;
  sourceMaterials: Material[];
}

/**
 * 存储端口：测试使用内存实现，实际运行切换 SQLite。
 * S08 只读不写——任务由 S09 随每日计划一起持久化。
 */
export interface LearningTaskRepository {
  loadTaskGenerationContext(
    goalId: string,
    knowledgePointId: string,
  ): Promise<TaskGenerationContext | null>;
}

/** 交给 AI Provider 的任务生成请求。 */
export interface TaskGenerationAIRequest {
  specification: TaskSpecification;
  knowledgePoint: KnowledgePoint;
  sourceMaterials: Material[];
}

/**
 * AI Provider 端口：只负责生成原始输出文本。
 * 应用层解析并校验结构；供应商、密钥、超时与重试由基础设施实现。
 */
export interface TaskGenerationAIProvider {
  generateTask(request: TaskGenerationAIRequest): Promise<string>;
}

/** 已完成的材料分析，固定分析器版本，可交给 S05 建立学习范围。 */
export type AnalyzedMaterialAnalysis = Extract<MaterialAnalysis, { status: 'analyzed' }>;

/** 词义库中的一个义项（来自 Princeton WordNet 3.1 义项清单）。 */
export interface InventorySense {
  /** 义项稳定标识，例如 wn31:a:01340892。 */
  id: string;
  /** 词性全名，例如 adjective。 */
  pos: string;
  /** 英文释义。 */
  gloss: string;
}

/**
 * 词义库端口：按 lemma 查询候选义项。
 * 实现为本地版本化 JSON 词义库；未知 lemma 返回空数组。
 */
export interface SenseInventory {
  lookup(lemma: string): InventorySense[];
}

/** 交给 AI Provider 的一次词义消歧输入，对应一处出现记录。 */
export interface SenseDisambiguationItem {
  /** 出现记录稳定 key，格式为 {termIndex}:{occurrenceIndex}，消歧结果按此回传。 */
  key: string;
  lemma: string;
  sentence: string;
  context: string[];
  candidates: InventorySense[];
}

/**
 * AI 词义消歧端口：为每处出现记录从候选义项中选一个。
 * 应用层校验 senseId 必须属于该条目的候选集；校验不过的词整体回退占位义项。
 */
export interface SenseDisambiguator {
  disambiguate(items: SenseDisambiguationItem[]): Promise<Array<{ key: string; senseId: string }>>;
}

/** 词频词表中的一条词族记录（BNC/COCA 词族数据）。 */
export interface VocabularyFamily {
  /** 频段，例如 '1k'、'5k'、'25k'。 */
  band: string;
  /** 词族在语料中的总频次。 */
  totalFrequency: number;
}

/**
 * 词频词表端口：按 lemma 查询所属词族的频段与总频次。
 * 实现为本地 BNC/COCA 词族清单；未知 lemma 返回 null。
 * 用于过滤不值得学习的超高频词与学习者已掌握的词。
 */
export interface VocabularyIndex {
  lookup(lemma: string): VocabularyFamily | null;
}

/**
 * S04 材料导入所需的写入端口。
 * 材料与分析必须在同一次写入中一起保存：要么全部保存，要么全部不保存。
 */
export interface MaterialRepository {
  saveMaterialWithAnalysis(
    material: Material,
    analysis: AnalyzedMaterialAnalysis,
  ): Promise<void>;
}

/** S05 加入材料时一次性保存的负载。 */
export interface SaveGoalMaterialPayload {
  goal: LearningGoal;
  /** 本次固定的目标材料关联；同材料新版本分析时为更新后的关联。 */
  materialLink: GoalMaterial;
  knowledgePoints: KnowledgePoint[];
  candidates: GoalKnowledgePoint[];
  sources: GoalKnowledgePointSource[];
}

/** S05 目标的材料关联与候选学习范围。 */
export interface GoalScope {
  materialLinks: GoalMaterial[];
  candidates: GoalKnowledgePoint[];
  sources: GoalKnowledgePointSource[];
}

/**
 * S05 创建目标并加入已分析材料的读写端口。
 * 目标、材料关联、规范化知识点、候选与来源在同一次写入中一起保存。
 */
export interface GoalMaterialRepository {
  loadLearner(learnerId: string): Promise<Learner | null>;
  loadGoal(goalId: string): Promise<LearningGoal | null>;
  loadMaterial(materialId: string): Promise<Material | null>;
  loadAnalysis(analysisId: string): Promise<MaterialAnalysis | null>;
  loadGoalScope(goalId: string): Promise<GoalScope>;
  saveGoalMaterial(payload: SaveGoalMaterialPayload): Promise<void>;
}
