/** ISO 8601 格式的日期时间字符串。 */
export type ISODateTime = string;
/** 学习者所在时区的本地日期，格式为 YYYY-MM-DD。 */
export type LocalDate = string;

/** 流利度维度：R 表示理解，P 表示产出。 */
export type FluencyDimension = 'R' | 'P';
/** 各流利度维度的分数。 */
export type FluencyScores = Record<FluencyDimension, number>;
/** 词频段标识，例如 1k 表示词频排名第 1～1000 的词族。 */
export type VocabularyBand = `${number}k`;

/** 标识词汇估计所依据的词表，避免混用不同词表的词段和概率。 */
export interface VocabularyListReference {
  /** 词表的稳定标识，例如 bnc-coca-l6。 */
  id: string;
  /** 词表版本；词表内容或词段划分变化时应更新版本。 */
  version: string;
}

/** 概率估计的不确定区间；区间类型由具体估计器决定。 */
export interface ProbabilityInterval {
  /** 概率下界，取值范围为 0～1。 */
  lower: number;
  /** 概率上界，取值范围为 0～1。 */
  upper: number;
  /** 区间覆盖水平，例如 0.95 表示 95% 区间。 */
  level: number;
}

/** 用户在一个词频段内的总体规模、抽样证据和掌握概率估计。 */
export interface VocabularyBandEstimate {
  /** 当前估计所属的词频段。 */
  band: VocabularyBand;
  /** 该词段在词表中包含的词族总数，不是测试数或已掌握数。 */
  wordFamilyCount: number;
  /** 用户掌握该词段内任意一个词族的估计概率，取值范围为 0～1。 */
  knownProbability: number;
  /** 本次估计实际使用的测试词族数量。 */
  sampleCount: number;
  /** 测试样本中回答正确的词族数量。 */
  correctCount: number;
  /** 掌握概率的不确定区间；无法可靠计算时为空。 */
  interval: ProbabilityInterval | null;
}

/** 基于一次测试证据生成的词汇水平估计快照，不代表固定不变的真实水平。 */
export interface VocabularyEstimate {
  /** 本次词汇估计使用的词表及版本。 */
  list: VocabularyListReference;
  /** 各词频段的掌握概率及其证据。 */
  bands: VocabularyBandEstimate[];
  /** 本次估计的生成时间。 */
  estimatedAt: ISODateTime;
}

/** 学习者档案及当前学习设置。 */
export interface Learner {
  /** 学习者的稳定标识。 */
  id: string;
  /** 当前采用的最新词汇估计；尚未完成首次测评时为空。 */
  currentVocabulary: VocabularyEstimate | null;
  /** 每个本地日期最多安排的学习任务数。 */
  dailyTaskCapacity: number;
  /** 用于计算每日容量和复习到期时间的 IANA 时区，例如 Asia/Shanghai。 */
  timezone: string;
  /** 档案创建时间。 */
  createdAt: ISODateTime;
  /** 档案最近一次修改时间。 */
  updatedAt: ISODateTime;
}

/** 一次词汇定级测评及其产生的估计结果。 */
export interface VocabularyAssessment {
  /** 测评记录标识。 */
  id: string;
  /** 参加测评的学习者 ID。 */
  learnerId: string;
  /** 本次测评包含的独立评级任务 ID，数组顺序表示出题顺序。 */
  taskIds: string[];
  /** 测评生命周期状态。 */
  status: 'draft' | 'in_progress' | 'completed';
  /** 根据作答证据生成的词汇估计；测评完成前为空。 */
  result: VocabularyEstimate | null;
  /** 测评创建时间。 */
  createdAt: ISODateTime;
  /** 测评完成时间；未完成时为空。 */
  completedAt: ISODateTime | null;
}

/** 词汇知识点的一个具体词义；同一单词的不同词义可以独立学习。 */
export interface KnowledgePointSense {
  /** 词义的稳定标识。 */
  id: string;
  /** 当前词义的释义。 */
  definition: string;
  /** 当前词义的词性；无法确定时为空。 */
  partOfSpeech: string | null;
  /** 对用法、语境或词义区别的补充说明；没有时为空。 */
  explanation: string | null;
}

/** 一个纯词汇知识点，由词元、所属词族和具体词义共同确定。 */
export interface KnowledgePoint {
  /** 词汇知识点的稳定标识。 */
  id: string;
  /** 词汇的词元或基本形式，例如 ran 的词元为 run。 */
  lemma: string;
  /** 词汇所属的词族，用于按词族统计词汇量和关联相关词形。 */
  wordFamily: string;
  /** 当前知识点学习的具体词义。 */
  sense: KnowledgePointSense;
}

/** 词汇评级选择题的一个选项。 */
export interface VocabularyAssessmentOption {
  /** 选项稳定标识，例如 a、b、c、d。 */
  id: string;
  /** 选项中的释义或翻译。 */
  text: string;
}

/** 词汇评级使用的独立选择题，不属于日常学习任务。 */
export interface VocabularyAssessmentTask {
  /** 评级任务标识。 */
  id: string;
  /** 被测词汇所属的词频段，用于分层抽样和分词段估计。 */
  band: VocabularyBand;
  /** 被测的词汇知识点及词义，仅保存在服务端。 */
  knowledgePoint: KnowledgePoint;
  /** 不提供定义提示的简单原文语境，用于限定词性和词义。 */
  context: string;
  /** 可供学习者选择的释义选项。 */
  options: VocabularyAssessmentOption[];
  /** 正确选项 ID，仅供服务端判分，不下发给学习者。 */
  answerOptionId: string;
}

/** 学习者对一道词汇评级题提交的答案及判分结果。 */
export interface VocabularyAssessmentAttempt {
  /** 作答记录标识，也可作为提交幂等键。 */
  id: string;
  /** 本次作答所属的词汇测评 ID。 */
  assessmentId: string;
  /** 被回答的词汇评级任务 ID。 */
  taskId: string;
  /** 学习者选择的选项 ID。 */
  selectedOptionId: string;
  /** 所选选项是否为本题正确答案。 */
  isCorrect: boolean;
  /** 学习者提交本题答案的时间。 */
  answeredAt: ISODateTime;
}

/** 学习者导入的一份原始学习材料。 */
export interface Material {
  /** 材料标识。 */
  id: string;
  /** 导入材料的学习者 ID。 */
  learnerId: string;
  /** 面向学习者展示的材料标题。 */
  title: string;
  /** 原始文件名。 */
  filename: string;
  /** 材料格式。 */
  format: 'txt' | 'markdown' | 'pdf';
  /** 原始文件的 MIME 类型；无法确定时为空。 */
  mimeType: string | null;
  /** 用于识别重复材料的内容校验和。 */
  checksum: string;
  /** 原始内容在外部存储中的键；内容直接内嵌时为空。 */
  storageKey: string | null;
  /** 从材料中提取、用于分析的纯文本；尚未提取时为空。 */
  extractedText: string | null;
  /** 提取过程的附加信息，例如页数、OCR 信息和提取器版本。 */
  extractionMetadata: Record<string, unknown>;
  /** 材料导入时间。 */
  createdAt: ISODateTime;
}

/** 词汇在原始材料中的一次出现。 */
export interface Occurrence {
  /** 词汇在材料中出现的原始词形，例如 running。 */
  rawForm: string;
  /** 包含该词汇的原始句子。 */
  sentence: string;
}

/** 材料分析结果中的一个词汇知识点及其全部原始出现记录。 */
export interface MaterialAnalysisItem {
  /** 分析后归一化得到的词汇知识点。 */
  knowledgePoint: KnowledgePoint;
  /** 归入该知识点的原始出现记录；出现次数由数组长度推导。 */
  occurrences: Occurrence[];
}

/** 对一份材料执行的一次版本化词汇分析。 */
export interface MaterialAnalysis {
  /** 分析记录标识。 */
  id: string;
  /** 被分析的材料 ID。 */
  materialId: string;
  /** 分析器名称或版本，用于复现分析结果。 */
  analyzerVersion: string;
  /** 分析生命周期状态。 */
  status: 'pending' | 'analyzed' | 'failed';
  /** 成功识别出的词汇知识点及其材料证据。 */
  items: MaterialAnalysisItem[];
  /** 未能匹配为词汇知识点的原始出现记录及其原因。 */
  unmatchedItems: Array<{
    /** 无法匹配或归一化的原因。 */
    reason: string;
    /** 具有相同未匹配原因的原始出现记录。 */
    occurrences: Occurrence[];
  }>;
  /** 分析过程中产生的错误信息。 */
  errors: string[];
  /** 本次分析的创建时间。 */
  createdAt: ISODateTime;
}

/** 学习者为一个材料范围设定的词汇流利度目标。 */
export interface LearningGoal {
  /** 学习目标标识。 */
  id: string;
  /** 拥有该目标的学习者 ID。 */
  learnerId: string;
  /** 面向学习者展示的目标名称。 */
  title: string;
  /** 目标内所有词汇知识点需要达到的 R/P 流利度分数。 */
  targetFluency: FluencyScores;
  /** 目标生命周期状态。 */
  status: 'active' | 'completed' | 'archived';
  /** 目标创建时间。 */
  createdAt: ISODateTime;
  /** 目标最近一次修改时间。 */
  updatedAt: ISODateTime;
}

/** 学习目标与材料之间的关联，并固定该目标采用的材料分析版本。 */
export interface GoalMaterial {
  /** 学习目标 ID。 */
  goalId: string;
  /** 加入目标的材料 ID。 */
  materialId: string;
  /** 用于确定目标词汇范围的分析 ID；尚未完成分析时为空。 */
  analysisId: string | null;
  /** 材料加入目标的时间。 */
  addedAt: ISODateTime;
}

/** 学习目标包含的词汇知识点及其来源。 */
export interface GoalKnowledgePoint {
  /** 学习目标 ID。 */
  goalId: string;
  /** 纳入目标学习范围的词汇知识点 ID。 */
  knowledgePointId: string;
  /** 将该词汇引入目标的材料分析 ID。 */
  sourceAnalysisId: string;
  /** 词汇知识点加入目标的时间。 */
  addedAt: ISODateTime;
}

/** 单个流利度维度的复习计划状态。 */
export interface ReviewSchedule {
  /** 当前相邻两次复习之间的间隔天数。 */
  intervalDays: number;
  /** 下一次复习到期时间。 */
  dueAt: ISODateTime;
  /** 最近一次实际复习时间；从未复习时为空。 */
  lastReviewedAt: ISODateTime | null;
  /** 连续成功复习的次数。 */
  successfulReviewStreak: number;
  /** 复习失败或遗忘的次数。 */
  lapseCount: number;
}

/** 一个词汇知识点在单个流利度维度上的当前学习状态。 */
export interface DimensionLearningState {
  /** 当前维度的流利度分数。 */
  fluency: number;
  /** 是否已经在有效任务中达到流利度要求。 */
  fluencyPass: boolean;
  /** 当前维度的复习计划。 */
  review: ReviewSchedule;
}

/** 学习者对一个词汇知识点的初始估计和当前学习状态。 */
export interface LearnerKnowledgePoint {
  /** 学习者 ID。 */
  learnerId: string;
  /** 被学习的词汇知识点 ID。 */
  knowledgePointId: string;
  /** 词汇进入学习范围时，根据测试证据估计的初始 R/P 流利度。 */
  initialFluency: FluencyScores;
  /** 当前各流利度维度的分数和复习状态。 */
  dimensions: Record<FluencyDimension, DimensionLearningState>;
  /** 开始学习该词汇的时间。 */
  createdAt: ISODateTime;
  /** 学习状态最近一次修改时间。 */
  updatedAt: ISODateTime;
  /** 学习状态版本号，用于并发更新检测。 */
  version: number;
}

/** 学习者在某个本地日期的任务安排。 */
export interface DailyStudyPlan {
  /** 每日学习计划标识。 */
  id: string;
  /** 计划所属的学习者 ID。 */
  learnerId: string;
  /** 计划所属的本地日期。 */
  date: LocalDate;
  /** 生成或调整计划时采用的任务容量上限。 */
  taskCapacity: number;
  /** 当天安排的任务 ID，数组顺序表示计划顺序。 */
  taskIds: string[];
  /** 计划创建时间。 */
  createdAt: ISODateTime;
  /** 计划最近一次调整时间。 */
  updatedAt: ISODateTime;
}


/** 任务行为类型：建立词形词义连接、主动提取或流利度应用。 */
export type TaskType = 'ENCODE' | 'RETRIEVE' | 'FLUENCY';
/** 主动提取的递进阶段：选择、提示作答或自由作答。 */
export type RetrieveStage = 'choice' | 'cued' | 'free';
/** 阅读流利度问题的考察角色。 */
export type ReadingQuestionRole = 'target_meaning' | 'passage_comprehension';

/** 任务材料的统一外层结构。 */
export interface TaskEnvelope<T extends TaskType, C> {
  /** 任务材料结构版本。 */
  schemaVersion: '1';
  /** 任务行为类型。 */
  task: T;
  /** 任务针对的词汇知识点 ID。 */
  wordId: string;
  /** 与任务类型对应的具体材料。 */
  content: C;
}

/** ENCODE 任务中的一个例句。 */
export interface TaskExample {
  /** 英文例句。 */
  sentence: string;
  /** 例句翻译；没有翻译时可省略。 */
  translation?: string;
}

/** 新词连接任务的学习内容。 */
export interface EncodeTaskContent {
  /** 目标词形。 */
  word: string;
  /** 目标词发音或音标；没有时可省略。 */
  pronunciation?: string;
  /** 目标词性；没有时可省略。 */
  partOfSpeech?: string;
  /** 目标词义。 */
  definition: string;
  /** 帮助建立词形与词义连接的例句。 */
  examples: TaskExample[];
  /** 展示给学习者的操作说明。 */
  instruction: string;
}

/** 选择题的一个选项。 */
export interface RetrieveOption {
  /** 选项稳定标识，例如 a、b、c、d。 */
  id: string;
  /** 选项文本。 */
  text: string;
}

/** 选择式主动提取任务的服务端完整内容。 */
export interface ChoiceRetrieveTaskContent {
  /** 任务考察的流利度维度。 */
  axis: FluencyDimension;
  /** 固定为选择阶段。 */
  stage: 'choice';
  /** 选择题目。 */
  prompt: string;
  /** 可选择的答案选项。 */
  options: RetrieveOption[];
  /** 正确选项 ID，仅供服务端评判。 */
  answerOptionId: string;
  /** 正确答案的解释，仅供服务端使用。 */
  explanation: string;
}

/** 非选择式主动提取任务的服务端答案。 */
export interface RetrieveAnswerKey {
  /** 可接受的正确答案文本。 */
  acceptedAnswers: string[];
  /** 答案解释。 */
  explanation: string;
}

/** 提示式主动提取任务的服务端完整内容。 */
export interface CuedRetrieveTaskContent {
  /** 任务考察的流利度维度。 */
  axis: FluencyDimension;
  /** 固定为提示阶段。 */
  stage: 'cued';
  /** 作答题目。 */
  prompt: string;
  /** 帮助提取答案的提示。 */
  cue: string;
  /** 服务端答案及解释。 */
  answerKey: RetrieveAnswerKey;
}

/** 自由主动提取任务的服务端完整内容。 */
export interface FreeRetrieveTaskContent {
  /** 任务考察的流利度维度。 */
  axis: FluencyDimension;
  /** 固定为自由作答阶段。 */
  stage: 'free';
  /** 作答题目。 */
  prompt: string;
  /** 服务端答案及解释。 */
  answerKey: RetrieveAnswerKey;
}

/** 阅读流利度任务中的一道服务端完整问题。 */
export interface ReadingQuestion {
  /** 问题考察目标词义还是篇章理解。 */
  role: ReadingQuestionRole;
  /** 问题文本。 */
  prompt: string;
  /** 服务端参考答案。 */
  answer: string;
  /** 原文中支持答案的证据句或片段。 */
  evidence: string;
}

/** R 维阅读流利度任务的服务端完整内容。 */
export interface ReadingFluencyTaskContent {
  /** 固定为理解维度。 */
  axis: 'R';
  /** 阅读文章。 */
  passage: string;
  /** 目标词义与篇章理解问题。 */
  questions: ReadingQuestion[];
  /** 目标词在文章中的实际出现次数。 */
  targetOccurrences: number;
}

/** P 维场景表达任务的服务端评分要求。 */
export interface ProductionGradingRequirements {
  /** 学习者需要自然使用的目标英文表达。 */
  targetExpression: string;
  /** 判断目标表达使用是否合格的标准。 */
  targetUseCriteria: string[];
  /** 判断整体表达是否合格的标准。 */
  overallExpressionCriteria: string[];
}

/** P 维场景表达流利度任务的服务端完整内容。 */
export interface ProductionFluencyTaskContent {
  /** 固定为产出维度。 */
  axis: 'P';
  /** 不泄露目标表达的中文场景。 */
  scenario: string;
  /** 不泄露目标表达的中文作答说明。 */
  responseInstruction: string;
  /** 仅供服务端评判的评分要求。 */
  gradingRequirements: ProductionGradingRequirements;
}

/** 服务端保存的完整任务材料，包含答案、证据或评分标准。 */
export type GeneratedTask =
  | TaskEnvelope<'ENCODE', EncodeTaskContent>
  | TaskEnvelope<'RETRIEVE', ChoiceRetrieveTaskContent>
  | TaskEnvelope<'RETRIEVE', CuedRetrieveTaskContent>
  | TaskEnvelope<'RETRIEVE', FreeRetrieveTaskContent>
  | TaskEnvelope<'FLUENCY', ReadingFluencyTaskContent>
  | TaskEnvelope<'FLUENCY', ProductionFluencyTaskContent>;

/** 学习者可见的选择式主动提取内容，不包含正确答案和解释。 */
export interface LearnerChoiceRetrieveTaskContent {
  /** 任务考察的流利度维度。 */
  axis: FluencyDimension;
  /** 固定为选择阶段。 */
  stage: 'choice';
  /** 选择题目。 */
  prompt: string;
  /** 可选择的答案选项。 */
  options: RetrieveOption[];
}

/** 学习者可见的提示式主动提取内容，不包含答案。 */
export interface LearnerCuedRetrieveTaskContent {
  /** 任务考察的流利度维度。 */
  axis: FluencyDimension;
  /** 固定为提示阶段。 */
  stage: 'cued';
  /** 作答题目。 */
  prompt: string;
  /** 帮助提取答案的提示。 */
  cue: string;
}

/** 学习者可见的自由主动提取内容，不包含答案。 */
export interface LearnerFreeRetrieveTaskContent {
  /** 任务考察的流利度维度。 */
  axis: FluencyDimension;
  /** 固定为自由作答阶段。 */
  stage: 'free';
  /** 作答题目。 */
  prompt: string;
}

/** 学习者可见的阅读问题，不包含答案和证据。 */
export interface LearnerReadingQuestion {
  /** 问题文本。 */
  prompt: string;
}

/** 学习者可见的阅读流利度内容，不包含答案和证据。 */
export interface LearnerReadingFluencyTaskContent {
  /** 固定为理解维度。 */
  axis: 'R';
  /** 阅读文章。 */
  passage: string;
  /** 学习者需要回答的问题。 */
  questions: LearnerReadingQuestion[];
}

/** 学习者可见的场景表达内容，不包含目标表达和评分要求。 */
export interface LearnerProductionFluencyTaskContent {
  /** 固定为产出维度。 */
  axis: 'P';
  /** 中文表达场景。 */
  scenario: string;
  /** 中文作答说明。 */
  responseInstruction: string;
}

/** 可安全返回给学习者的任务材料，不包含服务端答案或评分标准。 */
export type LearnerTask =
  | TaskEnvelope<'ENCODE', EncodeTaskContent>
  | TaskEnvelope<'RETRIEVE', LearnerChoiceRetrieveTaskContent>
  | TaskEnvelope<'RETRIEVE', LearnerCuedRetrieveTaskContent>
  | TaskEnvelope<'RETRIEVE', LearnerFreeRetrieveTaskContent>
  | TaskEnvelope<'FLUENCY', LearnerReadingFluencyTaskContent>
  | TaskEnvelope<'FLUENCY', LearnerProductionFluencyTaskContent>;

/** 分配给学习者的一份不可变任务。 */
export interface LearningTask {
  /** 任务标识。 */
  id: string;
  /** 接收任务的学习者 ID。 */
  learnerId: string;
  /** 任务针对的词汇知识点 ID，与 content.wordId 一致。 */
  knowledgePointId: string;
  /** 任务考察的流利度维度，ENCODE 可同时初始化 R/P。 */
  dimension: FluencyDimension | 'both';
  /** 任务行为类型。 */
  type: TaskType;
  /** RETRIEVE 的提取阶段；其他任务类型为空。 */
  stage: RetrieveStage | null;
  /** 服务端保存的完整任务材料。 */
  content: GeneratedTask;
  /** 返回给学习者的脱敏任务材料。 */
  learnerContent: LearnerTask;

  /** 任务生命周期状态。 */
  status: 'issued' | 'completed' | 'expired';
  /** 任务下发时间。 */
  issuedAt: ISODateTime;
}

/** 判断一次作答是否适合用于学习状态结算的有效性信息。 */
export interface AttemptValidity {
  /** 从任务呈现到提交所经过的毫秒数。 */
  elapsedMs: number;
  /** 作答过程是否被中断。 */
  interrupted: boolean;
}

/** 单个流利度维度的作答评判结果。 */
export interface DimensionJudgement {
  /** 作答表现：正确、部分正确或错误。 */
  outcome: 'correct' | 'partial' | 'incorrect';
  /** 当前维度的评判分数，不是结算后的流利度分数。 */
  score: number;
}

/** 对一次任务作答的完整评判结果。 */
export interface TaskJudgement {
  /** 任务实际考察的各流利度维度的评判结果。 */
  dimensions: Partial<Record<FluencyDimension, DimensionJudgement>>;
  /** 返回给学习者的反馈；没有反馈时为空。 */
  feedback: string | null;
  /** 评判方式：确定性规则或 AI。 */
  judgedBy: 'rule' | 'ai';
  /** 完成评判的时间。 */
  judgedAt: ISODateTime;
}

/** 作答结算引起的一项词汇流利度变化。 */
export interface FluencyChange {
  /** 流利度发生变化的词汇知识点 ID。 */
  knowledgePointId: string;
  /** 发生变化的流利度维度。 */
  dimension: FluencyDimension;
  /** 结算前的流利度分数。 */
  before: number;
  /** 结算后的流利度分数。 */
  after: number;
}

/** 作答结算引起的一项复习计划变化。 */
export interface ReviewScheduleChange {
  /** 复习计划发生变化的词汇知识点 ID。 */
  knowledgePointId: string;
  /** 发生变化的流利度维度。 */
  dimension: FluencyDimension;
  /** 结算前的复习计划快照。 */
  before: ReviewSchedule;
  /** 结算后的复习计划快照。 */
  after: ReviewSchedule;
}

/** 一次有效作答对学习状态产生的全部持久化变更。 */
export interface TaskSettlement {
  /** 本次结算产生的各词汇流利度变化。 */
  fluencyChanges: FluencyChange[];
  /** 本次结算产生的各复习计划变化。 */
  reviewChanges: ReviewScheduleChange[];
  /** 结算前采用的词汇水平估计快照。 */
  vocabularyBefore: VocabularyEstimate;
  /** 根据本次测试作答更新后的词汇水平估计快照。 */
  vocabularyAfter: VocabularyEstimate;
  /** 学习状态完成结算的时间。 */
  settledAt: ISODateTime;
}

/** 学习者对一份已下发任务提交的首次作答及其处理状态。 */
export interface TaskAttempt {
  /** 作答记录标识，也可作为提交幂等键。 */
  id: string;
  /** 被回答的任务 ID。 */
  taskId: string;
  /** 提交作答的学习者 ID。 */
  learnerId: string;
  /** 学习者提交的原始答案，重试评判时不得替换。 */
  submission: unknown;
  /** 用于判断作答能否结算的有效性信息。 */
  validity: AttemptValidity;
  /** 作答从接收、评判到结算的生命周期状态。 */
  status: 'received' | 'judging' | 'unavailable' | 'invalid' | 'settled';
  /** 作答评判结果；尚未完成评判时为空。 */
  judgement: TaskJudgement | null;
  /** 学习状态结算结果；未结算时为空。 */
  settlement: TaskSettlement | null;
  /** 系统首次接收到作答的时间。 */
  receivedAt: ISODateTime;
}

/** 完整学习领域状态，便于纯函数处理或内存持久化。 */
export interface LearningState {
  /** 全部学习者档案。 */
  learners: Learner[];
  /** 全部词汇测评记录。 */
  vocabularyAssessments: VocabularyAssessment[];
  /** 全部独立词汇评级任务。 */
  vocabularyAssessmentTasks: VocabularyAssessmentTask[];
  /** 全部词汇评级题的作答及判分记录。 */
  vocabularyAssessmentAttempts: VocabularyAssessmentAttempt[];
  /** 全部已导入材料。 */
  materials: Material[];
  /** 全部材料分析快照。 */
  materialAnalyses: MaterialAnalysis[];
  /** 全部学习目标。 */
  goals: LearningGoal[];
  /** 全部目标与材料的关联。 */
  goalMaterials: GoalMaterial[];
  /** 全部规范化词汇知识点。 */
  knowledgePoints: KnowledgePoint[];
  /** 全部目标与词汇知识点的关联。 */
  goalKnowledgePoints: GoalKnowledgePoint[];
  /** 全部学习者词汇学习状态。 */
  learnerKnowledgePoints: LearnerKnowledgePoint[];
  /** 全部每日学习计划。 */
  studyPlans: DailyStudyPlan[];
  /** 全部已下发任务。 */
  tasks: LearningTask[];
  /** 全部任务作答记录。 */
  attempts: TaskAttempt[];
}
