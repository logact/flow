import type {
  AttemptValidity,
  DimensionJudgement,
  FluencyDimension,
  FluencyScores,
  GeneratedTask,
  GoalKnowledgePoint,
  GoalKnowledgePointSelection,
  GoalKnowledgePointSource,
  GoalMaterial,
  ISODateTime,
  KnowledgePoint,
  KnowledgePointVocabularyClassification,
  Learner,
  LearnerKnowledgePoint,
  LearnerKnowledgePointInitialization,
  LearnerVocabularyAssessmentTask,
  LearningGoal,
  LearningState,
  LearningTask,
  LearningTaskView,
  LocalDate,
  Material,
  MaterialAnalysis,
  RetrieveStage,
  ReviewSchedule,
  TaskAttempt,
  TaskJudgement,
  TaskSubmission,
  VocabularyAssessment,
  VocabularyAssessmentAttempt,
  VocabularyAssessmentTask,
  VocabularyBand,
  VocabularyEstimate,
  VocabularyListReference,
} from './model';

// 学习者设置

export interface CreateLearnerInput {
  id: string;
  timezone: string;
  dailyTaskCapacity: number;
  now: ISODateTime;
}

/** 创建尚未完成词汇定级的学习者档案，不读写外部存储。 */
export declare function createLearner(input: CreateLearnerInput): Learner;

export interface UpdateLearnerSettingsInput {
  dailyTaskCapacity?: number;
  timezone?: string;
  now: ISODateTime;
}

/** 返回应用新设置后的学习者副本，不重新计算历史计划或复习到期时间。 */
export declare function updateLearnerSettings(
  learner: Learner,
  input: UpdateLearnerSettingsInput,
): Learner;

// 词汇定级

export interface VocabularyAssessmentWordFamily {
  /** 词表中词族的稳定标识。 */
  id: string;
  /** 词族的基本形式。 */
  headword: string;
  /** 词族所属词频段。 */
  band: VocabularyBand;
  /** 词族包含的词形。 */
  members: string[];
  /** 词族可能出现的词性。 */
  pos: string[];
}

export interface SampleVocabularyForAssessmentInput {
  /** 本次抽样使用的词表及版本。 */
  list: VocabularyListReference;
  /** 应用层从该词表读取的词族。 */
  families: VocabularyAssessmentWordFamily[];
  /** 每个词频段需要抽取的词族数量。 */
  sampleCounts: Partial<Record<VocabularyBand, number>>;
  /** 固定随机种子，使相同输入可以复现抽样结果。 */
  seed: string;
}

export interface VocabularyAssessmentSample {
  /** 样本来源的词族 ID。 */
  familyId: string;
  /** 样本所属词频段。 */
  band: VocabularyBand;
  /** 用于生成评级题的词元。 */
  lemma: string;
  /** 样本所属词族。 */
  wordFamily: string;
}

/** 按词频段从词表中抽取定级样本，不生成题目或访问外部存储。 */
export declare function sampleVocabularyForAssessment(
  input: SampleVocabularyForAssessmentInput,
): VocabularyAssessmentSample[];

export interface GenerateVocabularyAssessmentTasksInput {
  /** 已抽定的样本；数组顺序即出题顺序。 */
  samples: VocabularyAssessmentSample[];
  /** 与 samples 等长且顺序对应的任务 ID，由应用层分配。 */
  taskIds: string[];
}

/**
 * 为抽样结果生成包含语境、选项和正确答案的服务端评级题。
 * 具体规则或 AI 调用由实现层负责，本契约只固定生成输入和输出。
 */
export declare function generateVocabularyAssessmentTasks(
  input: GenerateVocabularyAssessmentTasksInput,
): VocabularyAssessmentTask[];

export interface CreateVocabularyAssessmentInput {
  id: string;
  learnerId: string;
  tasks: VocabularyAssessmentTask[];
  now: ISODateTime;
}

/** 根据已经抽定的评级题创建进行中的测评，固定题目及出题顺序。 */
export declare function createVocabularyAssessment(
  input: CreateVocabularyAssessmentInput,
): Extract<VocabularyAssessment, { status: 'in_progress' }>;

/** 移除正确答案和服务端词义，返回学习者可见的定级题。 */
export declare function toLearnerVocabularyAssessmentTask(
  task: VocabularyAssessmentTask,
): LearnerVocabularyAssessmentTask;

export interface RecordVocabularyAssessmentAttemptInput {
  attemptId: string;
  assessment: VocabularyAssessment;
  task: VocabularyAssessmentTask;
  previousAttempts: VocabularyAssessmentAttempt[];
  selectedOptionId: string;
  answeredAt: ISODateTime;
}

/** 评判并记录一道定级选择题，不负责生成整次测评的词汇估计。 */
export declare function recordVocabularyAssessmentAttempt(
  input: RecordVocabularyAssessmentAttemptInput,
): VocabularyAssessmentAttempt;

export interface VocabularyBandAssessmentEvidence {
  /** 被估计的词频段。 */
  band: VocabularyBand;
  /** 该词段在指定词表版本中的词族总数。 */
  wordFamilyCount: number;
  /** 属于该词段的抽样题目。 */
  tasks: VocabularyAssessmentTask[];
  /** 与抽样题目对应的作答。 */
  attempts: VocabularyAssessmentAttempt[];
}

export interface EstimateVocabularyInput {
  list: VocabularyListReference;
  bands: VocabularyBandAssessmentEvidence[];
  estimatedAt: ISODateTime;
}

/** 根据各词频段的抽样证据计算掌握概率、不确定区间和词汇水平快照。 */
export declare function estimateVocabulary(
  input: EstimateVocabularyInput,
): VocabularyEstimate;

export interface CompleteVocabularyAssessmentInput {
  learner: Learner;
  assessment: VocabularyAssessment;
  tasks: VocabularyAssessmentTask[];
  attempts: VocabularyAssessmentAttempt[];
  list: VocabularyListReference;
  bandWordFamilyCounts: Partial<Record<VocabularyBand, number>>;
  now: ISODateTime;
}

/** 汇总测评结果，返回已完成测评和采用最新词汇估计的学习者副本。 */
export declare function completeVocabularyAssessment(
  input: CompleteVocabularyAssessmentInput,
): {
  assessment: Extract<VocabularyAssessment, { status: 'completed' }>;
  learner: Learner;
};

// 材料导入与分析

export interface CreateMaterialInput {
  id: string;
  learnerId: string;
  title: string;
  filename: string;
  format: Material['format'];
  mimeType: string | null;
  checksum: string;
  storageKey: string | null;
  /** 应用层已从原始文件提取的纯文本；尚未提取时为空。 */
  extractedText: string | null;
  extractionMetadata: Record<string, unknown>;
  now: ISODateTime;
}

/** 创建材料记录；文件读取、格式解析和文本提取由应用层完成。 */
export declare function createMaterial(input: CreateMaterialInput): Material;

export interface AnalyzeMaterialInput {
  analysisId: string;
  material: Material;
  analyzerVersion: string;
  now: ISODateTime;
}

/**
 * 从材料纯文本识别并归一化知识点，保留原始出现记录和未匹配项。
 * 该函数只执行确定性的文本分析，不读取文件或调用外部服务。
 */
export declare function analyzeMaterial(
  input: AnalyzeMaterialInput,
): Extract<MaterialAnalysis, { status: 'analyzed' }>;

// 学习目标、材料范围和知识点选择

export interface CreateLearningGoalInput {
  id: string;
  learnerId: string;
  title: string;
  targetFluency: FluencyScores;
  now: ISODateTime;
}

/** 创建 active 学习目标；目标初始不包含材料或候选知识点。 */
export declare function createLearningGoal(
  input: CreateLearningGoalInput,
): LearningGoal;

export interface AddAnalyzedMaterialToGoalInput {
  goal: LearningGoal;
  material: Material;
  analysis: Extract<MaterialAnalysis, { status: 'analyzed' }>;
  existingCandidates: GoalKnowledgePoint[];
  existingSources: GoalKnowledgePointSource[];
  addedAt: ISODateTime;
}

export interface AddAnalyzedMaterialToGoalResult {
  goal: LearningGoal;
  materialLink: GoalMaterial;
  /** 本次分析涉及、需要纳入规范化知识点集合的知识点。 */
  knowledgePoints: KnowledgePoint[];
  /** 合并后的目标候选集合；已有选择状态不得被重置。 */
  candidates: GoalKnowledgePoint[];
  /** 合并后的来源集合；同一知识点可以保留多个材料分析来源。 */
  sources: GoalKnowledgePointSource[];
}

/** 将固定分析版本加入目标，并增量合并候选知识点和来源。 */
export declare function addAnalyzedMaterialToGoal(
  input: AddAnalyzedMaterialToGoalInput,
): AddAnalyzedMaterialToGoalResult;

export interface SetGoalKnowledgePointSelectionInput {
  selection: GoalKnowledgePointSelection;
  now: ISODateTime;
}

/**
 * 返回选择状态更新后的候选知识点副本。
 * 不删除学习进度或历史任务；排除后的任务取消由每日排期决策处理。
 */
export declare function setGoalKnowledgePointSelection(
  candidate: GoalKnowledgePoint,
  input: SetGoalKnowledgePointSelectionInput,
): GoalKnowledgePoint;

export interface ChangeLearningGoalStatusInput {
  status: LearningGoal['status'];
  now: ISODateTime;
}

/** 更新目标生命周期状态，不删除其材料、候选知识点或学习历史。 */
export declare function changeLearningGoalStatus(
  goal: LearningGoal,
  input: ChangeLearningGoalStatusInput,
): LearningGoal;

// 知识点初始流利度

export interface DeriveInitialFluencyInput {
  vocabulary: VocabularyEstimate;
  classification: KnowledgePointVocabularyClassification | null;
  policyVersion: string;
}

export interface DerivedInitialFluency {
  initialFluency: FluencyScores;
  initialization: LearnerKnowledgePointInitialization;
}

/** 根据词汇定级快照推导 R/P 初始分数，并保留完整的初始化证据。 */
export declare function deriveInitialFluency(
  input: DeriveInitialFluencyInput,
): DerivedInitialFluency;

export interface InitializeLearnerKnowledgePointInput {
  learnerId: string;
  knowledgePoint: KnowledgePoint;
  /** 由 deriveInitialFluency 返回的初始分数及完整初始化证据。 */
  derived: DerivedInitialFluency;
  now: ISODateTime;
}

/** 使用已推导的初始流利度创建学习状态；已有状态应由调用方保留。 */
export declare function initializeLearnerKnowledgePoint(
  input: InitializeLearnerKnowledgePointInput,
): LearnerKnowledgePoint;

// 下一步任务与任务内容

export interface TaskSpecificationBase {
  /** 本任务服务的学习目标。 */
  goalId: string;
  /** 本任务考察的知识点，与 TaskEnvelope.wordId 对应。 */
  wordId: string;
}

/**
 * 一项待生成任务的教学规格，只描述“要学什么”，不包含具体题目、答案或评分标准。
 * 每日排期先产出该规格，之后由应用层调用任务生成器生成 GeneratedTask。
 */
export type TaskSpecification = TaskSpecificationBase & (
  | {
      /** 建立词形与词义连接；该类型不区分 R/P 维度。 */
      task: 'ENCODE';
    }
  | {
      /** 主动提取任务。 */
      task: 'RETRIEVE';
      /** 本次提取考察理解还是产出。 */
      axis: FluencyDimension;
      /** 选择、提示作答或自由作答的递进阶段。 */
      stage: RetrieveStage;
    }
  | {
      /** 阅读或场景表达流利度任务。 */
      task: 'FLUENCY';
      /** R 对应阅读任务，P 对应场景表达任务。 */
      axis: FluencyDimension;
    }
);

export interface DecideNextTaskInput {
  /** 当前排期所服务的目标；只有 active 目标可以继续生成任务。 */
  goal: LearningGoal;
  /** 知识点在该目标中的选择状态；只有 included 可以生成新任务。 */
  candidate: GoalKnowledgePoint;
  /** 知识点的规范化内容，用于判断知识点类型和学习条件。 */
  knowledgePoint: KnowledgePoint;
  /** 已有学习状态；null 表示该知识点尚未开始学习。 */
  learning: LearnerKnowledgePoint | null;
  /** 本次决策时间，用于判断复习是否到期。 */
  now: ISODateTime;
}

/**
 * 决定一个知识点当前需要执行的任务。
 * 返回 null 表示目标未启用、知识点未纳入、尚未到期或目标已经达成。
 * 该函数不考虑每日容量，不生成任务内容，也不修改输入。
 */
export declare function decideNextTask(
  input: DecideNextTaskInput,
): TaskSpecification | null;

export interface GenerateLearningTaskInput {
  /** 每日排期产出的教学规格。 */
  specification: TaskSpecification;
  /** 生成题目所需的知识点词义或用法。 */
  knowledgePoint: KnowledgePoint;
  /** 与目标关联、可用于构造语境和证据的材料；没有可用材料时为空。 */
  sourceMaterials: Material[];
}

/**
 * 根据教学规格和知识点内容生成服务端完整任务。
 * 具体规则或 AI 调用由实现层负责，本契约只固定生成输入和输出。
 */
export declare function generateLearningTask(
  input: GenerateLearningTaskInput,
): GeneratedTask;

/**
 * 校验生成内容的任务类型、知识点、R/P 维度和提取阶段是否与排期规格一致。
 * 只校验结构契约，不判断题目的教学质量，也不修改生成内容。
 */
export declare function validateGeneratedTask(
  specification: TaskSpecification,
  generated: GeneratedTask,
): boolean;

export interface CreateLearningTaskInput {
  id: string;
  learnerId: string;
  specification: TaskSpecification;
  generated: GeneratedTask;
  issuedAt: ISODateTime;
}

/** 将符合规格的服务端完整内容组装为 issued 学习任务，不下发给客户端。 */
export declare function createLearningTask(
  input: CreateLearningTaskInput,
): LearningTask;

/** 移除正确答案、答案解释、原文证据和评分标准，返回学习者可见的任务副本。 */
export declare function toLearningTaskView(
  task: LearningTask,
): LearningTaskView;

// 每日排期与计划应用

export interface PlanDailyStudyInput {
  /** 需要安排学习任务的学习者。 */
  learnerId: string;
  /** 计划所属的学习者本地日期。 */
  date: LocalDate;
  /** 本次排期时间，用于识别到期复习和过期任务。 */
  now: ISODateTime;
}

/** 每日计划中的一个位置，可以保留已下发任务，也可以请求生成一项新任务。 */
export type PlannedTask =
  | {
      /** 保留今日计划中仍然有效的已下发任务。 */
      source: 'existing';
      taskId: string;
    }
  | {
      /** 需要生成并加入今日计划的新任务。 */
      source: 'new';
      specification: TaskSpecification;
    };

/** 每日排期的完整决策；它是待持久化的结果，不是对学习状态的直接修改。 */
export interface DailyStudyDecision {
  /** 计划所属的学习者。 */
  learnerId: string;
  /** 计划所属的学习者本地日期。 */
  date: LocalDate;
  /** 本次排期采用的任务容量快照。 */
  taskCapacity: number;
  /** 今日任务及其学习顺序，数量不得超过 taskCapacity。 */
  tasks: PlannedTask[];
  /** 以前日期下发但截至本次排期仍未完成的任务。 */
  expireTaskIds: string[];
  /** 因知识点被排除、目标关闭或今日容量缩减而需要取消的任务。 */
  cancelTaskIds: string[];
}

/**
 * 根据当前学习状态生成每日排期决策。
 * 函数负责保留有效任务、识别过期或取消任务，并按优先级和容量选择新任务规格。
 * 不生成任务 ID 或题目内容，不执行 AI、数据库等外部操作，也不修改输入状态。
 */
export declare function planDailyStudy(
  state: Readonly<LearningState>,
  input: PlanDailyStudyInput,
): DailyStudyDecision;

export interface ApplyDailyStudyDecisionInput {
  /** 新建计划必须提供 ID；已有计划省略此字段并保留原 ID。 */
  planId?: string;
  decision: DailyStudyDecision;
  /** 应用层已为全部 new 位置生成并赋予 ID 的服务端任务。 */
  newTasks: LearningTask[];
  now: ISODateTime;
}

/**
 * 将排期决策和已生成任务应用到学习状态，返回包含新计划及任务状态变化的新状态。
 * 不生成内容、不分配 ID；相同输入不得产生不同的领域结果。
 */
export declare function applyDailyStudyDecision(
  state: Readonly<LearningState>,
  input: ApplyDailyStudyDecisionInput,
): LearningState;

// 作答接收与评判

export interface RecordTaskAttemptInput {
  /** 作答记录 ID，同时作为提交幂等键。 */
  attemptId: string;
  /** 被作答且已经下发的学习任务。 */
  taskId: string;
  /** 学习者首次提交的原始答案。 */
  submission: TaskSubmission;
  /** 作答耗时和中断情况，用于判断作答是否适合评判和结算。 */
  validity: AttemptValidity;
  /** 系统首次接收到该作答的时间。 */
  receivedAt: ISODateTime;
}

export interface RecordTaskAttemptResult {
  /** 包含首次作答记录的新状态。 */
  state: LearningState;
  /** 可评判作答为 received；无效或不可用作答直接记录原因。 */
  attempt:
    | Extract<TaskAttempt, { status: 'received' }>
    | Extract<TaskAttempt, { status: 'invalid' | 'unavailable' }>;
}

/** 记录首次作答并检查任务与提交有效性，不执行评判或学习状态结算。 */
export declare function recordTaskAttempt(
  state: Readonly<LearningState>,
  input: RecordTaskAttemptInput,
): RecordTaskAttemptResult;

export interface StartTaskAttemptJudgingInput {
  /** 已接收且尚未评判的作答记录 ID。 */
  attemptId: string;
}

export interface StartTaskAttemptJudgingResult {
  state: LearningState;
  attempt: Extract<TaskAttempt, { status: 'judging' }>;
}

/** 将已接收作答标记为评判中，供同步或 AI 异步评判使用。 */
export declare function startTaskAttemptJudging(
  state: Readonly<LearningState>,
  input: StartTaskAttemptJudgingInput,
): StartTaskAttemptJudgingResult;

export interface JudgeTaskInput {
  task: LearningTask;
  submission: TaskSubmission;
  judgedAt: ISODateTime;
}

/**
 * 使用确定性规则评判任务答案并返回绑定 taskId 的各维度结果。
 * AI 评判由应用层执行；其评判结果同样通过 settleTaskAttempt 进入结算。
 */
export declare function judgeTask(input: JudgeTaskInput): TaskJudgement;

// 流利度、复习计划与词汇估计更新

export interface CalculateNextFluencyInput {
  task: LearningTask;
  dimension: FluencyDimension;
  currentFluency: number;
  judgement: DimensionJudgement;
}

/** 根据任务表现计算单个维度的下一流利度分数，不修改复习计划。 */
export declare function calculateNextFluency(
  input: CalculateNextFluencyInput,
): number;

export interface CalculateNextReviewScheduleInput {
  current: ReviewSchedule;
  nextFluency: number;
  judgement: DimensionJudgement;
  reviewedAt: ISODateTime;
}

/** 根据本次表现和结算后分数计算下一间隔、到期时间及连续成功或遗忘计数。 */
export declare function calculateNextReviewSchedule(
  input: CalculateNextReviewScheduleInput,
): ReviewSchedule;

export interface UpdateVocabularyEstimateInput {
  before: VocabularyEstimate;
  knowledgePoint: KnowledgePoint;
  classification: KnowledgePointVocabularyClassification | null;
  task: LearningTask;
  judgement: TaskJudgement;
  estimatedAt: ISODateTime;
}

/** 将一次有效学习证据合并到词汇水平估计，返回新的估计快照。 */
export declare function updateVocabularyEstimate(
  input: UpdateVocabularyEstimateInput,
): VocabularyEstimate;

// 作答结算

export interface SettleTaskAttemptInput {
  /** 已接收或评判中的作答记录 ID；原始提交从学习状态中读取。 */
  attemptId: string;
  /** 已完成的评判结果；taskId 必须与作答任务一致。 */
  judgement: TaskJudgement;
  /** 本次学习状态结算时间。 */
  now: ISODateTime;
}

export interface SettleTaskAttemptResult {
  /** 包含任务完成状态、学习进度、复习计划和词汇估计变化的新状态。 */
  state: LearningState;
  /** 包含评判与结算快照的作答记录。 */
  attempt: Extract<TaskAttempt, { status: 'settled' }>;
}

/**
 * 根据已完成的评判结算一次有效作答。
 * 统一调用流利度、复习计划和词汇估计更新规则，返回新状态和 settled 作答记录。
 * 不修改原始提交，不调用评判器、ID 生成器或外部服务。
 */
export declare function settleTaskAttempt(
  state: Readonly<LearningState>,
  input: SettleTaskAttemptInput,
): SettleTaskAttemptResult;
