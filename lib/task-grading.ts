import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { logger as appLogger } from './logger';
import { schedule, type ScheduleEvent, type WordSchedule } from './schedule';
import { score, type EventLogger, type ScoreEvent } from './scoring';
import type { GeneratedTask, ReadingQuestionRole } from './task-material';
import type { VocabularyEstimate } from './vocabulary';

export type GradingSubmission =
  | { axis: 'R'; answers: Record<ReadingQuestionRole, string> }
  | { axis: 'P'; response: string };
export interface AttemptValidity { timingValid: boolean; interrupted: boolean; materialValid: boolean; speedWpm: number }
export type FluencyGradingInput = {
  attemptId: string; generationId?: string; task: Extract<GeneratedTask, { task: 'FLUENCY' }>;
  submission: GradingSubmission; learner: { vocabularyProfile: VocabularyEstimate; contentLevel?: string; language: string };
  validity: AttemptValidity; date: string; word: WordSchedule;
};
export interface CriterionDecision { passed: boolean; evidence: string }
export type GradeDecision =
  | { status: 'graded'; attemptId: string; axis: 'R'; targetMeaning: CriterionDecision; passageComprehension: CriterionDecision }
  | { status: 'graded'; attemptId: string; axis: 'P'; target: CriterionDecision; overall: CriterionDecision }
  | { status: 'invalid'; attemptId: string; reason: 'task_mismatch' | 'material_invalid' | 'timing_invalid' | 'interrupted' | 'invalid_submission' }
  | { status: 'unavailable'; attemptId: string; reason: string };
export interface GraderRequest { input: FluencyGradingInput; promptVersion: string }
export interface RawGraderResult { provider: string; model: string; rawOutput: string; rawResponse?: string; request?: { url: string; headers: { authorization: '[redacted]'; 'content-type': string }; systemPrompt: string; userPrompt: string; body: string }; requestId?: string }
export interface FluencyGrader { grade(request: GraderRequest): Promise<RawGraderResult> }
export interface GradingAttemptEvent {
  event: 'task_grading.attempt'; attemptId: string; generationId?: string; attempt: number; maxAttempts: number;
  provider: string; model: string; promptVersion: string; task: unknown; submission: unknown; validity: AttemptValidity;
  request?: RawGraderResult['request']; systemPrompt?: string; userPrompt?: string; rawRequest?: string; rawResponse?: string; rawOutput?: string; parsedGrade?: unknown;
  valid: boolean; errors: string[]; retryReason?: string; decision?: GradeDecision; scoreSettled: boolean; scheduleSettled: boolean;
}
export type GradingLogger = (event: GradingAttemptEvent) => void;
export interface StoredGradingAttempt { input: FluencyGradingInput; decision?: GradeDecision; scoreEvent?: ScoreEvent; scheduleEvent?: ScheduleEvent; updatedWord?: WordSchedule }
export interface GradingStore {
  saveOriginal(input: FluencyGradingInput): StoredGradingAttempt;
  load(attemptId: string): StoredGradingAttempt | undefined;
  settle(attemptId: string, value: Omit<StoredGradingAttempt, 'input'>): void;
}

/** SQLite submission store freezes the issued task and first answer; later retries always load this snapshot. */
export class SqliteGradingStore implements GradingStore {
  private readonly db: InstanceType<typeof Database>;
  constructor(filename = process.env.FLOW_DB_PATH ?? 'data/flow.sqlite') {
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS fluency_attempts (attempt_id TEXT PRIMARY KEY, input_json TEXT NOT NULL, result_json TEXT)`);
  }
  saveOriginal(input: FluencyGradingInput): StoredGradingAttempt {
    this.db.prepare('INSERT OR IGNORE INTO fluency_attempts (attempt_id, input_json) VALUES (?, ?)').run(input.attemptId, JSON.stringify(input));
    const row = this.db.prepare('SELECT input_json, result_json FROM fluency_attempts WHERE attempt_id = ?').get(input.attemptId) as { input_json: string; result_json: string | null };
    return { input: JSON.parse(row.input_json), ...(row.result_json ? JSON.parse(row.result_json) : {}) };
  }
  load(attemptId: string): StoredGradingAttempt | undefined {
    const row = this.db.prepare('SELECT input_json, result_json FROM fluency_attempts WHERE attempt_id = ?').get(attemptId) as { input_json: string; result_json: string | null } | undefined;
    return row ? { input: JSON.parse(row.input_json), ...(row.result_json ? JSON.parse(row.result_json) : {}) } : undefined;
  }
  settle(attemptId: string, value: Omit<StoredGradingAttempt, 'input'>): void {
    this.db.prepare('UPDATE fluency_attempts SET result_json = ? WHERE attempt_id = ? AND result_json IS NULL').run(JSON.stringify(value), attemptId);
  }
  close(): void { this.db.close(); }
}

/** Small deterministic store for tests, local fixture runs, and no-key debugging. */
export class MemoryGradingStore implements GradingStore {
  private readonly records = new Map<string, StoredGradingAttempt>();
  saveOriginal(input: FluencyGradingInput): StoredGradingAttempt {
    if (!this.records.has(input.attemptId)) this.records.set(input.attemptId, { input: clone(input) });
    return clone(this.records.get(input.attemptId)!);
  }
  load(attemptId: string): StoredGradingAttempt | undefined { const value = this.records.get(attemptId); return value && clone(value); }
  settle(attemptId: string, value: Omit<StoredGradingAttempt, 'input'>): void {
    const existing = this.records.get(attemptId);
    if (existing && !existing.decision) this.records.set(attemptId, { input: existing.input, ...clone(value) });
  }
}

const defaultLogger: GradingLogger = event => appLogger.info(event, 'Task grading attempt');

/** Saves the original answer once, retries against that saved snapshot, then settles existing score/schedule exactly once. */
export async function gradeFluencyAttempt(input: FluencyGradingInput, grader: FluencyGrader, store: GradingStore, options: { maxAttempts?: number; promptVersion?: string; logger?: GradingLogger; scoreLogger?: EventLogger; scheduleLogger?: (event: ScheduleEvent) => void } = {}): Promise<GradeDecision> {
  const saved = store.saveOriginal(input);
  if (saved.decision) return saved.decision;
  const frozen = saved.input;
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new RangeError('maxAttempts must be an integer from 1 to 10');
  const writeLog = options.logger ?? defaultLogger;
  const invalid = validateAttempt(frozen);
  if (invalid) {
    const decision: GradeDecision = { status: 'invalid', attemptId: frozen.attemptId, reason: invalid };
    writeLog(eventFor(frozen, 0, maxAttempts, options.promptVersion ?? 'p7-v1', 'none', 'none', false, [invalid], decision));
    store.settle(frozen.attemptId, { decision });
    return decision;
  }
  let lastReason = 'provider_error';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: RawGraderResult | undefined;
    try { raw = await grader.grade({ input: clone(frozen), promptVersion: options.promptVersion ?? 'p7-v1' }); }
    catch (error) {
      lastReason = redact(error instanceof Error ? error.message : 'provider_error');
      const providerError = error as Error & { provider?: string; model?: string; request?: RawGraderResult['request']; rawResponse?: string };
      const failedRaw = providerError.request ? { provider: providerError.provider ?? 'unknown', model: providerError.model ?? 'unknown', rawOutput: '', request: providerError.request, ...(providerError.rawResponse ? { rawResponse: providerError.rawResponse } : {}) } as RawGraderResult : undefined;
      const exhausted = attempt === maxAttempts ? { status: 'unavailable', attemptId: frozen.attemptId, reason: lastReason } as const : undefined;
      writeLog(eventFor(frozen, attempt, maxAttempts, options.promptVersion ?? 'p7-v1', providerError.provider ?? 'unknown', providerError.model ?? 'unknown', false, [lastReason], exhausted, failedRaw));
      continue;
    }
    let parsed: unknown;
    const errors: string[] = [];
    try { parsed = JSON.parse(raw.rawOutput); } catch { errors.push('invalid_json'); }
    const normalized = errors.length ? undefined : validateGrade(parsed, frozen.task.content.axis);
    if (!errors.length && !normalized) errors.push('invalid_grade_schema');
    const valid = errors.length === 0;
    lastReason = valid ? '' : errors.join(',');
    if (!valid) {
      const exhausted = attempt === maxAttempts ? { status: 'unavailable', attemptId: frozen.attemptId, reason: lastReason } as const : undefined;
      writeLog(eventFor(frozen, attempt, maxAttempts, options.promptVersion ?? 'p7-v1', raw.provider, raw.model, false, errors, exhausted, raw, parsed));
      continue;
    }
    const decision: GradeDecision = frozen.task.content.axis === 'R'
      ? { status: 'graded', attemptId: frozen.attemptId, axis: 'R', targetMeaning: normalized!.target, passageComprehension: normalized!.overall }
      : { status: 'graded', attemptId: frozen.attemptId, axis: 'P', target: normalized!.target, overall: normalized!.overall };
    const targetPassed = decision.axis === 'R' ? decision.targetMeaning.passed : decision.target.passed;
    const overallPassed = decision.axis === 'R' ? decision.passageComprehension.passed : decision.overall.passed;
    let scoreEvent: ScoreEvent | undefined;
    let scheduleEvent: ScheduleEvent | undefined;
    const scoreLogger = (event: ScoreEvent) => { const correlated = { ...event, attemptId: frozen.attemptId }; scoreEvent = correlated; (options.scoreLogger ?? (value => appLogger.info({ event: 'score.update', ...value }, 'Score updated')))(correlated); };
    const result = schedule({ word: clone(frozen.word), date: frozen.date, result: { axis: frozen.task.content.axis, targetPassed, overallPassed, speedWpm: frozen.validity.speedWpm, timingValid: frozen.validity.timingValid, materialValid: frozen.validity.materialValid, interrupted: frozen.validity.interrupted }, scoreLogger, logger: event => { const correlated = { ...event, attemptId: frozen.attemptId }; scheduleEvent = clone(correlated); (options.scheduleLogger ?? (value => appLogger.info(correlated, 'Schedule updated')))(correlated); } });
    store.settle(frozen.attemptId, { decision, ...(scoreEvent ? { scoreEvent } : {}), ...(scheduleEvent ? { scheduleEvent } : {}), updatedWord: result.word });
    writeLog(eventFor(frozen, attempt, maxAttempts, options.promptVersion ?? 'p7-v1', raw.provider, raw.model, true, [], decision, raw, parsed, true, true));
    return decision;
  }
  const decision: GradeDecision = { status: 'unavailable', attemptId: frozen.attemptId, reason: lastReason };
  return decision;
}

/** Resume an unavailable attempt by ID after restart; the persisted original answer and task are the only grading input. */
export async function retryFluencyAttempt(attemptId: string, grader: FluencyGrader, store: GradingStore, options: { maxAttempts?: number; promptVersion?: string; logger?: GradingLogger; scoreLogger?: EventLogger; scheduleLogger?: (event: ScheduleEvent) => void } = {}): Promise<GradeDecision> {
  const saved = store.load(attemptId);
  if (!saved) throw new Error(`Fluency attempt not found: ${attemptId}`);
  if (saved.decision) return saved.decision;
  return gradeFluencyAttempt(saved.input, grader, store, options);
}

export function buildGradingPrompt(input: FluencyGradingInput, promptVersion = 'p7-v1'): string {
  const rubric = input.task.content.axis === 'R'
    ? input.task.content.questions.map(q => ({ role: q.role, question: q.prompt, expectedAnswer: q.answer, evidence: q.evidence }))
    : input.task.content.gradingRequirements;
  const outputShape = input.task.content.axis === 'R'
    ? { targetMeaning: { passed: true, evidence: 'brief evidence from target meaning answer' }, passageComprehension: { passed: true, evidence: 'brief evidence from passage answer' } }
    : { target: { passed: true, evidence: 'brief evidence from target use' }, overall: { passed: true, evidence: 'brief evidence from expression' } };
  return JSON.stringify({ promptVersion, instruction: 'Grade only using the frozen task and rubric. Accept meaning-preserving answers. If evidence is unclear, return schema-invalid output rather than guessing. Return only the exact JSON outputShape with short evidence.', learner: input.learner, axis: input.task.content.axis, task: input.task.content.axis === 'R' ? { passage: input.task.content.passage, rubric } : { scenario: input.task.content.scenario, responseInstruction: input.task.content.responseInstruction, rubric }, submission: input.submission, outputShape });
}

export function createFixtureGrader(outputs: Array<string | unknown>, provider = 'fixture'): FluencyGrader {
  let index = 0;
  return { async grade() { const value = outputs[Math.min(index++, outputs.length - 1)] ?? '{bad json'; return { provider, model: `${provider}-p7`, rawOutput: typeof value === 'string' ? value : JSON.stringify(value) }; } };
}

export function createConfiguredGrader(config: { apiKey?: string; baseUrl?: string; model?: string; fetcher?: typeof fetch } = {}): FluencyGrader {
  const apiKey = config.apiKey ?? process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY is required for provider grading');
  const baseUrl = config.baseUrl ?? process.env.LLM_BASE_URL;
  const model = config.model ?? process.env.LLM_MODEL;
  if (!baseUrl) throw new Error('LLM_BASE_URL is required for provider grading');
  if (!model) throw new Error('LLM_MODEL is required for provider grading');
  const endpoint = /\/chat\/completions\/?$/.test(baseUrl) ? baseUrl : `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const host = new URL(baseUrl).hostname.toLowerCase();
  const provider = host.includes('deepseek') ? 'deepseek' : host.includes('moonshot') || host.includes('kimi') ? 'kimi' : host.includes('openai') ? 'openai' : host.split('.')[0];
  return { async grade({ input, promptVersion }) {
    const systemPrompt = 'Return only a JSON object. Do not add markdown.';
    const userPrompt = buildGradingPrompt(input, promptVersion);
    const body = JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }] });
    const request = { url: endpoint, headers: { authorization: '[redacted]' as const, 'content-type': 'application/json' }, systemPrompt, userPrompt, body };
    let response: Response;
    try { response = await (config.fetcher ?? fetch)(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body }); }
    catch { throw Object.assign(new Error('provider_request_failed'), { request, provider, model }); }
    const rawResponse = await response.text();
    if (!response.ok) throw Object.assign(new Error(`provider_http_${response.status}`), { rawResponse, request, provider, model });
    let payload: any;
    try { payload = JSON.parse(rawResponse); }
    catch { throw Object.assign(new Error('provider_invalid_json'), { rawResponse, request, provider, model }); }
    const rawOutput = payload?.choices?.[0]?.message?.content;
    if (typeof rawOutput !== 'string') throw Object.assign(new Error('provider_output_missing'), { rawResponse, request, provider, model });
    return { provider, model, rawOutput, rawResponse, request, ...(payload.id ? { requestId: payload.id } : {}) };
  } };
}

function validateAttempt(input: FluencyGradingInput): Extract<GradeDecision, { status: 'invalid' }>['reason'] | undefined {
  if (input.task.task !== 'FLUENCY') return 'task_mismatch';
  if (input.task.content.axis !== input.submission.axis) return 'task_mismatch';
  if (!input.validity.materialValid || !validMaterial(input.task)) return 'material_invalid';
  if (input.validity.interrupted) return 'interrupted';
  if (!input.validity.timingValid || !Number.isFinite(input.validity.speedWpm) || input.validity.speedWpm <= 0) return 'timing_invalid';
  if (input.task.content.axis === 'R') {
    const answers = input.submission as Extract<GradingSubmission, { axis: 'R' }>;
    if (!answers.answers || !['target_meaning', 'passage_comprehension'].every(k => typeof answers.answers[k as ReadingQuestionRole] === 'string' && answers.answers[k as ReadingQuestionRole].trim())) return 'invalid_submission';
  } else if (typeof (input.submission as Extract<GradingSubmission, { axis: 'P' }>).response !== 'string' || !(input.submission as Extract<GradingSubmission, { axis: 'P' }>).response.trim()) return 'invalid_submission';
}
function validMaterial(task: FluencyGradingInput['task']): boolean {
  if (task.schemaVersion !== '1' || task.task !== 'FLUENCY') return false;
  if (task.content.axis === 'R') {
    const passage = task.content.passage;
    const words = passage.trim().split(/\s+/).filter(Boolean);
    return words.length >= 90 && words.length <= 120 && task.content.questions.length === 2 && new Set(task.content.questions.map(q => q.role)).size === 2 && task.content.questions.some(q => q.role === 'target_meaning') && task.content.questions.some(q => q.role === 'passage_comprehension') && task.content.questions.every(q => q.prompt.trim() && q.answer.trim() && q.evidence.trim() && passage.toLowerCase().includes(q.evidence.toLowerCase()));
  }
  return Boolean(task.content.gradingRequirements?.targetExpression && task.content.gradingRequirements.targetUseCriteria.length && task.content.gradingRequirements.overallExpressionCriteria.length);
}
function validateGrade(value: unknown, axis: 'R' | 'P'): { target: CriterionDecision; overall: CriterionDecision } | undefined {
  const targetKey = axis === 'R' ? 'targetMeaning' : 'target';
  const overallKey = axis === 'R' ? 'passageComprehension' : 'overall';
  if (!isObject(value) || !exactKeys(value, [targetKey, overallKey]) || !isObject(value[targetKey]) || !isObject(value[overallKey])) return;
  for (const part of [value[targetKey], value[overallKey]]) if (!exactKeys(part, ['passed', 'evidence']) || typeof part.passed !== 'boolean' || typeof part.evidence !== 'string' || !part.evidence.trim()) return;
  return { target: { passed: value[targetKey].passed, evidence: value[targetKey].evidence }, overall: { passed: value[overallKey].passed, evidence: value[overallKey].evidence } };
}
function eventFor(input: FluencyGradingInput, attempt: number, maxAttempts: number, promptVersion: string, provider: string, model: string, valid: boolean, errors: string[], decision?: GradeDecision, raw?: RawGraderResult, parsedGrade?: unknown, scoreSettled = false, scheduleSettled = false): GradingAttemptEvent {
  const err = errors.map(value => redact(value));
  const request = raw?.request;
  const systemPrompt = request?.systemPrompt ?? 'Return only a JSON object. Do not add markdown.';
  const userPrompt = request?.userPrompt ?? buildGradingPrompt(input, promptVersion);
  return { event: 'task_grading.attempt', attemptId: input.attemptId, ...(input.generationId ? { generationId: input.generationId } : {}), attempt, maxAttempts, provider, model, promptVersion, task: clone(input.task), submission: clone(input.submission), validity: clone(input.validity), systemPrompt, userPrompt, ...(request ? { request, rawRequest: request.body } : {}), ...(raw?.rawResponse ? { rawResponse: redact(raw.rawResponse) } : {}), ...(raw?.rawOutput ? { rawOutput: redact(raw.rawOutput) } : {}), ...(parsedGrade === undefined ? {} : { parsedGrade }), valid, errors: err, ...(valid ? {} : { retryReason: err.join(',') }), ...(decision ? { decision } : {}), scoreSettled, scheduleSettled };
}
function exactKeys(value: Record<string, unknown>, required: string[]): boolean { const keys = Object.keys(value); return keys.length === required.length && required.every(key => Object.hasOwn(value, key)); }
function redact(value: string): string { const secret = process.env.LLM_API_KEY; return secret ? value.split(secret).join('[redacted]') : value; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)); }
function isObject(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
