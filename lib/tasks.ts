import { CONFIG } from './config';
import type { Word } from './db';

// 任务库（RPD「任务库」表）：资格谓词替代旧的段位→题型查表。
// 调度以 (KP, 方向, 任务) 三元组为候选——先由资格谓词定任务，后算 P。

export type Axis = 'p' | 'r';
export type ScoredKind = 'STEP3' | 'STEP4' | 'STEP4R' | 'MFI';

/** Learning purpose is independent of the renderer used to present the task. */
export type TaskType = 'ENCODE' | 'RETRIEVE' | 'FLUENCY' | 'INTEGRATE';
export type TaskPurpose =
  | 'introduce'
  | 'diagnose'
  | 'verify'
  | 'review'
  | 'recover'
  | 'relearn'
  | 'maintain';
export type TaskAction =
  | 'view'
  | 'recognize'
  | 'recall'
  | 'contextualize'
  | 'continuous_read'
  | 'continuous_write';
export type SpeedMode = 'none' | 'latency_proxy' | 'reading_wpm' | 'writing_wpm';
export type EvidenceAttribution = 'per_word' | 'overall';
export type TaskScope = 'single' | 'multiple';

export interface ScoreRange {
  min: number;
  max: number;
}

/** Requirements that must be satisfied before a definition can be instantiated. */
export interface TaskPrerequisites {
  materials?: readonly ('word' | 'example_sentence' | 'continuous_text' | 'book_text')[];
  accuracyChecks?: readonly ('target_word' | 'passage_comprehension' | 'expression')[];
  minimumWords?: number;
  requiresIndependentResponse?: boolean;
}

export interface TaskEvidenceDefinition {
  /** Checks are named so the server can verify each requirement independently. */
  accuracy_check: readonly ('target_word' | 'passage_comprehension' | 'expression')[];
  speed_mode: SpeedMode;
  attribution: EvidenceAttribution;
}

/** A reusable task template. A definition declares its learning purpose and evidence. */
export interface TaskDefinition {
  id: string;
  type: TaskType;
  supported_axes: readonly Axis[];
  score_range_by_axis: Readonly<Record<Axis, ScoreRange | null>>;
  action: TaskAction;
  /** Null means this definition teaches or provides unscored practice only. */
  checkpoint_range: ScoreRange | null;
  supported_purposes: readonly TaskPurpose[];
  scope: TaskScope;
  prerequisites: TaskPrerequisites;
  evidence: TaskEvidenceDefinition;
  renderer: string;
}

/** A server-created assignment; its checkpoint is fixed before the user responds. */
export interface TaskInstance {
  instance_id: string;
  definition_id: string;
  type: TaskType;
  checkpoint: number | null;
  axis: Axis;
  purpose: TaskPurpose;
  word_ids: readonly number[];
  payload: Readonly<Record<string, unknown>>;
  renderer: string;
  issued_at: number;
}

export type EmptyReason = 'waiting_cooldown' | 'all_complete' | 'materials_unavailable';

/** An explicit no-task response; retry timing is present only while waiting for cooldown. */
export interface EmptyTaskInstance {
  type: 'EMPTY';
  reason: EmptyReason;
  next_available_at: number | null;
  unavailable_materials?: readonly string[];
}

export type ScheduledTaskInstance = TaskInstance | EmptyTaskInstance;

/** Evidence sent with a result. It records whether the attempt can certify a checkpoint. */
export interface TaskEvidence {
  independent: boolean;
  answer_revealed: boolean;
  hint_used: boolean;
  accuracy: Readonly<Record<string, boolean>>;
  speed_mode: SpeedMode;
  speed_value: number | null;
  duration_ms: number | null;
  word_results: readonly {
    word_id: number;
    correct: boolean;
    response?: unknown;
  }[];
}

/** Client response to one issued instance; scoring fields are confirmed by the server. */
export interface TaskResult {
  instance_id: string;
  response: Readonly<Record<string, unknown>>;
  evidence: TaskEvidence;
  submitted_at: number;
}

export interface Candidate {
  dir: Axis;
  kind: ScoredKind;
}

// 材料长度（词数）：Step 4 写作示范句 / Step 4R 速读篇章共用同一份 per-KP 材料
export const materialWords = (w: Word) =>
  w.step4_sentences.join(' ').split(/\s+/).filter(Boolean).length;

// 有可测的阅读构念：材料够长才谈得上速读。短材料词（词表导入只有语块本身）
// 的 F_R 改为镜像 F_P——它们的流利度按定义就是单一构念（见 RPD「P⊃R 迁移」）
export const readable = (w: Word) => materialWords(w) >= CONFIG.READ_MIN_WORDS;

// Legacy kinds remain available to old renderers while the scheduler migrates to definitions.
// They have no scoring or tie-break semantics.
export const taskRank = (_k: ScoredKind): number => 0;

const scoreRange = (min: number, max: number): ScoreRange => ({ min, max });

/** Abstract learning tasks. Renderer names are presentation adapters, not dispatch rules. */
export const TASK_LIBRARY: readonly TaskDefinition[] = [
  {
    id: 'encode-r', type: 'ENCODE', supported_axes: ['r'],
    score_range_by_axis: { p: null, r: scoreRange(0, 100) }, action: 'view',
    checkpoint_range: null, supported_purposes: ['introduce', 'relearn'], scope: 'single',
    prerequisites: { materials: ['word', 'example_sentence'] },
    evidence: { accuracy_check: [], speed_mode: 'none', attribution: 'per_word' }, renderer: 'encode-r',
  },
  {
    id: 'encode-p', type: 'ENCODE', supported_axes: ['p'],
    score_range_by_axis: { p: scoreRange(0, 100), r: null }, action: 'view',
    checkpoint_range: null, supported_purposes: ['introduce', 'relearn'], scope: 'single',
    prerequisites: { materials: ['word', 'example_sentence'] },
    evidence: { accuracy_check: [], speed_mode: 'none', attribution: 'per_word' }, renderer: 'encode-p',
  },
  {
    id: 'retrieve-r', type: 'RETRIEVE', supported_axes: ['r'],
    score_range_by_axis: { p: null, r: scoreRange(0, 100) }, action: 'recognize',
    checkpoint_range: scoreRange(0, 50),
    supported_purposes: ['diagnose', 'verify', 'review', 'recover', 'relearn', 'maintain'], scope: 'single',
    prerequisites: { materials: ['word', 'example_sentence'], accuracyChecks: ['target_word'], requiresIndependentResponse: true },
    evidence: { accuracy_check: ['target_word'], speed_mode: 'latency_proxy', attribution: 'per_word' }, renderer: 'retrieve-r',
  },
  {
    id: 'retrieve-p', type: 'RETRIEVE', supported_axes: ['p'],
    score_range_by_axis: { p: scoreRange(0, 100), r: null }, action: 'recall',
    checkpoint_range: scoreRange(0, 50),
    supported_purposes: ['diagnose', 'verify', 'review', 'recover', 'relearn', 'maintain'], scope: 'single',
    prerequisites: { materials: ['word', 'example_sentence'], accuracyChecks: ['target_word'], requiresIndependentResponse: true },
    evidence: { accuracy_check: ['target_word'], speed_mode: 'latency_proxy', attribution: 'per_word' }, renderer: 'retrieve-p',
  },
  {
    id: 'fluency-r', type: 'FLUENCY', supported_axes: ['r'],
    score_range_by_axis: { p: null, r: scoreRange(50, 100) }, action: 'continuous_read',
    checkpoint_range: scoreRange(50, 100), supported_purposes: ['verify', 'review', 'recover', 'maintain'], scope: 'single',
    prerequisites: { materials: ['continuous_text'], accuracyChecks: ['target_word', 'passage_comprehension'], minimumWords: CONFIG.READ_MIN_WORDS, requiresIndependentResponse: true },
    evidence: { accuracy_check: ['target_word', 'passage_comprehension'], speed_mode: 'reading_wpm', attribution: 'per_word' }, renderer: 'fluency-r',
  },
  {
    id: 'fluency-p', type: 'FLUENCY', supported_axes: ['p'],
    score_range_by_axis: { p: scoreRange(50, 100), r: null }, action: 'continuous_write',
    checkpoint_range: scoreRange(50, 100), supported_purposes: ['verify', 'review', 'recover', 'maintain'], scope: 'single',
    prerequisites: { materials: ['continuous_text'], accuracyChecks: ['target_word', 'expression'], minimumWords: 30, requiresIndependentResponse: true },
    evidence: { accuracy_check: ['target_word', 'expression'], speed_mode: 'writing_wpm', attribution: 'per_word' }, renderer: 'fluency-p',
  },
  {
    id: 'integrate-r', type: 'INTEGRATE', supported_axes: ['r'],
    score_range_by_axis: { p: null, r: scoreRange(75, 100) }, action: 'continuous_read',
    checkpoint_range: scoreRange(75, 100), supported_purposes: ['verify', 'review', 'maintain'], scope: 'multiple',
    prerequisites: { materials: ['continuous_text'], accuracyChecks: ['target_word', 'passage_comprehension'], requiresIndependentResponse: true },
    evidence: { accuracy_check: ['target_word', 'passage_comprehension'], speed_mode: 'reading_wpm', attribution: 'per_word' }, renderer: 'integrate-r',
  },
  {
    id: 'integrate-p', type: 'INTEGRATE', supported_axes: ['p'],
    score_range_by_axis: { p: scoreRange(75, 100), r: null }, action: 'continuous_write',
    checkpoint_range: scoreRange(75, 100), supported_purposes: ['verify', 'review', 'maintain'], scope: 'multiple',
    prerequisites: { materials: ['continuous_text'], accuracyChecks: ['target_word', 'expression'], requiresIndependentResponse: true },
    evidence: { accuracy_check: ['target_word', 'expression'], speed_mode: 'writing_wpm', attribution: 'per_word' }, renderer: 'integrate-p',
  },
];

export interface TaskEligibilityContext {
  axis: Axis;
  score: number;
  purpose: TaskPurpose;
  materials: ReadonlySet<NonNullable<TaskPrerequisites['materials']>[number]>;
  accuracyChecks: ReadonlySet<NonNullable<TaskPrerequisites['accuracyChecks']>[number]>;
  wordCount?: number;
  independentResponseAvailable?: boolean;
}

/** Filter definitions by the declared score band, purpose, material, and evidence capability. */
export function eligibleTaskDefinitions(context: TaskEligibilityContext): TaskDefinition[] {
  return TASK_LIBRARY.filter((definition) => {
    if (!definition.supported_axes.includes(context.axis)) return false;
    const range = definition.score_range_by_axis[context.axis];
    if (!range || context.score < range.min || context.score > range.max) return false;
    if (!definition.supported_purposes.includes(context.purpose)) return false;
    if (definition.prerequisites.materials?.some((item) => !context.materials.has(item))) return false;
    if (definition.evidence.accuracy_check.some((item) => !context.accuracyChecks.has(item))) return false;
    if (definition.prerequisites.minimumWords != null && (context.wordCount ?? 0) < definition.prerequisites.minimumWords) return false;
    if (definition.prerequisites.requiresIndependentResponse && context.independentResponseAvailable === false) return false;
    return true;
  });
}

/** Ordinary score-driven candidates. Even below 50, both axes retain a RETRIEVE route. */
export function ordinaryCandidates(context: Omit<TaskEligibilityContext, 'purpose'>): TaskDefinition[] {
  const purpose: TaskPurpose = context.score < 50 ? 'review' : 'maintain';
  return eligibleTaskDefinitions({ ...context, purpose });
}

// 资格谓词保证「先准确后速度」无需档位：F 低于 ACCURACY_FLOOR 时速度任务不可派，
// 候选自然落回提取类任务。新词（last_ts = 0）走引入通道，不参与复习竞争。
export function candidatesOf(w: Word, hasBook: boolean): Candidate[] {
  if (w.last_ts === 0) return [];
  const out: Candidate[] = [{ dir: 'p', kind: 'STEP3' }];
  if (w.fluency >= CONFIG.ACCURACY_FLOOR) out.push({ dir: 'p', kind: 'STEP4' });
  if (w.fluency_r >= CONFIG.ACCURACY_FLOOR) {
    if (readable(w)) out.push({ dir: 'r', kind: 'STEP4R' });
    if (hasBook) out.push({ dir: 'r', kind: 'MFI' });
  }
  return out;
}
