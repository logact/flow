import { randomUUID } from 'node:crypto';
import { logger as appLogger } from './logger';
import type { VocabularyEstimate } from './vocabulary';

export type Axis = 'R' | 'P';
export type RetrieveStage = 'choice' | 'cued' | 'free';
export type TaskType = 'ENCODE' | 'RETRIEVE' | 'FLUENCY';
export interface TaskGenerationInput {
  word: { id: string; text: string; sense: { id: string; definition: string; partOfSpeech?: string; examples?: string[] } };
  axis: Axis | 'both'; task: TaskType; stage?: RetrieveStage;
  learner: { vocabularyProfile: VocabularyEstimate; contentLevel?: string; score: number | { R: number; P: number }; language: string };
  promptVersion: string;
}
export interface RawGenerationResult { provider: string; model: string; rawOutput: string; rawResponse?: string; request?: ProviderRequestLog; requestId?: string }
export interface TaskMaterialGenerator { generate(input: TaskGenerationInput): Promise<RawGenerationResult> }
export interface ProviderRequestLog { url: string; headers: { authorization: '[redacted]'; 'content-type': string }; systemPrompt: string; userPrompt: string; body: string }
export type TaskEnvelope<T extends string, C> = { schemaVersion: '1'; task: T; wordId: string; content: C };
export type ReadingQuestionRole = 'target_meaning' | 'passage_comprehension';
export type GeneratedTask =
  | TaskEnvelope<'ENCODE', { word: string; pronunciation?: string; partOfSpeech?: string; definition: string; examples: Array<{ sentence: string; translation?: string }>; instruction: string }>
  | TaskEnvelope<'RETRIEVE', { axis: Axis; stage: 'choice'; prompt: string; options: Array<{ id: string; text: string }>; answerOptionId: string; explanation: string }>
  | TaskEnvelope<'RETRIEVE', { axis: Axis; stage: 'cued'; prompt: string; cue: string; answerKey: { acceptedAnswers: string[]; explanation: string } }>
  | TaskEnvelope<'RETRIEVE', { axis: Axis; stage: 'free'; prompt: string; answerKey: { acceptedAnswers: string[]; explanation: string } }>
  | TaskEnvelope<'FLUENCY', { axis: 'R'; passage: string; questions: Array<{ role: ReadingQuestionRole; prompt: string; answer: string; evidence: string }>; targetOccurrences: number }>
  | TaskEnvelope<'FLUENCY', { axis: 'P'; scenario: string; responseInstruction: string; gradingRequirements: { targetExpression: string; targetUseCriteria: string[]; overallExpressionCriteria: string[] } }>;
export type LearnerTask = TaskEnvelope<'ENCODE', { word: string; pronunciation?: string; partOfSpeech?: string; definition: string; examples: Array<{ sentence: string; translation?: string }>; instruction: string }>
  | TaskEnvelope<'RETRIEVE', { axis: Axis; stage: RetrieveStage; prompt: string; options?: Array<{ id: string; text: string }>; cue?: string }>
  | TaskEnvelope<'FLUENCY', { axis: 'R'; passage: string; questions: Array<{ prompt: string }> }>
  | TaskEnvelope<'FLUENCY', { axis: 'P'; scenario: string; responseInstruction: string }>;
export type TaskGenerationOutcome = { status: 'ready'; material: GeneratedTask; generationId: string } | { status: 'unavailable'; reason: string; generationId: string };
export interface TaskGenerationEvent { event: 'task_generation.attempt'; generationId: string; attempt: number; maxAttempts: number; provider: string; model: string; promptVersion: string; input: TaskGenerationInput; request?: ProviderRequestLog; systemPrompt?: string; userPrompt?: string; rawResponse?: string; rawOutput?: string; parsedOutput?: unknown; valid: boolean; errors: string[]; retryReason?: string; requestId?: string }
export type TaskGenerationLogger = (event: TaskGenerationEvent) => void;
const log: TaskGenerationLogger = event => appLogger.info(event, 'Task generation attempt');
class ProviderRequestError extends Error { constructor(readonly provider: string, readonly model: string, message: string, readonly request: ProviderRequestLog, readonly rawResponse?: string) { super(message); } }

/** Adapter outputs are untrusted JSON; the service owns parsing, validation, retry, and logging. */
export async function generateTask(input: TaskGenerationInput, generator: TaskMaterialGenerator, options: { maxAttempts?: number; logger?: TaskGenerationLogger; generationId?: string } = {}): Promise<TaskGenerationOutcome> {
  validateInput(input);
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new RangeError('maxAttempts must be an integer from 1 to 10');
  const generationId = options.generationId ?? randomUUID();
  const writeLog = options.logger ?? log;
  let lastReason = 'generation_failed';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw: RawGenerationResult;
    try { raw = await generator.generate(input); }
    catch (error) {
      lastReason = redact(error instanceof Error ? error.message : 'provider_error', process.env.LLM_API_KEY);
      const provider = error instanceof ProviderRequestError ? error.provider : 'unknown';
      const model = error instanceof ProviderRequestError ? error.model : 'unknown';
      writeLog({ event: 'task_generation.attempt', generationId, attempt, maxAttempts, provider, model, promptVersion: input.promptVersion, input: clone(input), ...(error instanceof ProviderRequestError ? { request: error.request, systemPrompt: error.request.systemPrompt, userPrompt: error.request.userPrompt, ...(error.rawResponse ? { rawResponse: error.rawResponse } : {}) } : {}), valid: false, errors: [lastReason], retryReason: lastReason });
      continue;
    }
    let parsed: unknown;
    const errors: string[] = [];
    try { parsed = JSON.parse(raw.rawOutput); } catch { errors.push('invalid_json'); }
    if (!errors.length) errors.push(...validateMaterial(parsed, input));
    const valid = errors.length === 0;
    lastReason = valid ? '' : errors.join(',');
    writeLog({ event: 'task_generation.attempt', generationId, attempt, maxAttempts, provider: raw.provider, model: raw.model, promptVersion: input.promptVersion, input: clone(input), ...(raw.request ? { request: raw.request, systemPrompt: raw.request.systemPrompt, userPrompt: raw.request.userPrompt } : {}), ...(raw.rawResponse ? { rawResponse: raw.rawResponse } : {}), rawOutput: raw.rawOutput, ...(parsed === undefined ? {} : { parsedOutput: parsed }), valid, errors, ...(valid ? {} : { retryReason: lastReason }), ...(raw.requestId ? { requestId: raw.requestId } : {}) });
    if (valid) return { status: 'ready', material: parsed as GeneratedTask, generationId };
  }
  return { status: 'unavailable', reason: lastReason, generationId };
}

/** Stable JSON prompt shared by fixture and remote adapters. */
export function buildTaskPrompt(input: TaskGenerationInput): string {
  const variant = input.task === 'ENCODE' ? 'ENCODE' : input.task === 'RETRIEVE' ? `RETRIEVE_${input.stage?.toUpperCase()}` : `FLUENCY_${input.axis}`;
  const contentShape = input.task === 'ENCODE' ? { word: input.word.text, definition: input.word.sense.definition, examples: [{ sentence: '<example sentence>' }], instruction: '<learner instruction>' }
    : input.task === 'RETRIEVE' && input.stage === 'choice' ? { axis: input.axis, stage: 'choice', prompt: '<question>', options: [{ id: 'a', text: '<option>' }, { id: 'b', text: '<option>' }], answerOptionId: 'a', explanation: '<server explanation>' }
      : input.task === 'RETRIEVE' && input.stage === 'cued' ? { axis: input.axis, stage: 'cued', prompt: '<prompt>', cue: '<cue>', answerKey: { acceptedAnswers: [input.word.text], explanation: '<server explanation>' } }
        : input.task === 'RETRIEVE' ? { axis: input.axis, stage: 'free', prompt: '<prompt>', answerKey: { acceptedAnswers: [input.word.text], explanation: '<server explanation>' } }
          : input.axis === 'R' ? { axis: 'R', passage: '<90-120 English words>', questions: [{ role: 'target_meaning', prompt: '<question about target word meaning>', answer: '<fixed answer>', evidence: '<exact evidence quote>' }, { role: 'passage_comprehension', prompt: '<question about passage content>', answer: '<fixed answer>', evidence: '<exact evidence quote>' }], targetOccurrences: 5 }
            : { axis: 'P', scenario: '<Chinese scenario>', responseInstruction: '<Chinese instruction>', gradingRequirements: { targetExpression: input.word.text, targetUseCriteria: ['<criterion>'], overallExpressionCriteria: ['<criterion>'] } };
  return JSON.stringify({
    instruction: `Create exactly one ${variant} task. Return ONLY the JSON object. Follow the output shape exactly: do not rename keys, add wrapper objects, add fields, or change schemaVersion from the string "1". wordId must equal the input word.id. Keep answer keys/rubrics in content for server grading.`,
    outputShape: { schemaVersion: '1', task: input.task, wordId: input.word.id, content: contentShape },
    input,
    learnerVocabularyProfile: input.learner.vocabularyProfile,
    ...(input.learner.contentLevel ? { contentLevelRule: `Keep learner-facing English vocabulary and grammar within the separately configured content level ${input.learner.contentLevel}. The supplied target word is the only intended exception.` } : {}),
    learnerKnowledgeRule: 'Use the supplied recognition probabilities by word-family frequency band to favor likely-known non-target vocabulary. They describe population proportions, not a list of words this individual knows. Do not convert them to CEFR levels or infer A1/B1/C1.',
    constraints: input.task === 'FLUENCY' && input.axis === 'R' ? `Write an English passage with 90-120 whitespace-separated words. Include the exact target word "${input.word.text}" at least five times. Include exactly two answerable questions; each evidence value must be an exact quote from passage. targetOccurrences must equal the exact count.` : input.task === 'FLUENCY' && input.axis === 'P' ? 'Write scenario and responseInstruction in Chinese; neither may reveal the target English expression.' : 'Match the supplied word and sense exactly. Return only the requested content shape.',
  });
}

export function createFixtureGenerator(fixtures: RawGenerationResult[]): TaskMaterialGenerator {
  let index = 0;
  return { async generate() { const result = fixtures[Math.min(index, fixtures.length - 1)]; index++; if (!result) throw new Error('fixture_exhausted'); return { ...result }; } };
}

export type TaskMaterialProvider = 'fixture' | 'openai' | 'deepseek' | 'kimi' | (string & {});

/** Uses fixtures until LLM_API_KEY is set; LLM_BASE_URL and LLM_MODEL select any compatible service/model. */
export function createConfiguredTaskMaterialGenerator(fixtures: RawGenerationResult[], config: { provider?: TaskMaterialProvider; apiKey?: string; model?: string; endpoint?: string } = {}): TaskMaterialGenerator {
  const baseUrl = process.env.LLM_BASE_URL;
  if (!config.provider && !process.env.TASK_MATERIAL_PROVIDER && !config.apiKey && !process.env.LLM_API_KEY && !baseUrl && !process.env.LLM_MODEL) return createFixtureGenerator(fixtures);
  const provider = config.provider ?? process.env.TASK_MATERIAL_PROVIDER ?? inferProvider(baseUrl) ?? 'openai';
  if (provider === 'fixture') return createFixtureGenerator(fixtures);
  return createChatCompletionsGenerator({ ...config, provider });
}

/** Remove answer keys and grading rubrics before task content reaches a learner-facing view. */
export function toLearnerTask(material: GeneratedTask): LearnerTask {
  if (material.task === 'ENCODE') return { ...material, content: { ...material.content, examples: material.content.examples.map(example => ({ ...example })) } };
  if (material.task === 'RETRIEVE') {
    const { axis, stage, prompt } = material.content;
    return { schemaVersion: '1', task: 'RETRIEVE', wordId: material.wordId, content: { axis, stage, prompt, ...(stage === 'choice' ? { options: material.content.options.map(option => ({ ...option })) } : stage === 'cued' ? { cue: material.content.cue } : {}) } };
  }
  if (material.content.axis === 'R') return { schemaVersion: '1', task: 'FLUENCY', wordId: material.wordId, content: { axis: 'R', passage: material.content.passage, questions: material.content.questions.map(({ prompt }) => ({ prompt })) } };
  return { schemaVersion: '1', task: 'FLUENCY', wordId: material.wordId, content: { axis: 'P', scenario: material.content.scenario, responseInstruction: material.content.responseInstruction } };
}

/** Backwards-compatible OpenAI adapter name. */
export function createOpenAICompatibleGenerator(config: { apiKey?: string; model?: string; endpoint?: string } = {}): TaskMaterialGenerator {
  return createChatCompletionsGenerator({ provider: 'openai', ...config });
}

const PROVIDER_DEFAULTS: Record<string, { defaultModel: string; baseUrl: string }> = {
  openai: { defaultModel: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1' },
  deepseek: { defaultModel: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
  kimi: { defaultModel: 'kimi-k2.6', baseUrl: 'https://api.moonshot.ai/v1' },
};

/** Shared OpenAI-compatible Chat Completions adapter for selectable providers and models. */
function createChatCompletionsGenerator(config: { provider: string; apiKey?: string; model?: string; endpoint?: string }): TaskMaterialGenerator {
  const defaults = PROVIDER_DEFAULTS[config.provider];
  const apiKey = config.apiKey ?? process.env.LLM_API_KEY;
  if (!apiKey) throw new Error('LLM_API_KEY is required for provider generation');
  const model = config.model ?? process.env.LLM_MODEL ?? defaults?.defaultModel;
  if (!model) throw new Error(`LLM_MODEL is required for provider ${config.provider}`);
  const baseUrl = process.env.LLM_BASE_URL ?? defaults?.baseUrl;
  const endpoint = config.endpoint ?? (baseUrl ? toChatCompletionsEndpoint(baseUrl) : undefined);
  if (!endpoint) throw new Error(`LLM_BASE_URL is required for provider ${config.provider}`);
  return { async generate(input) {
    const systemPrompt = 'Return only a JSON object that follows the requested task schema.';
    const userPrompt = buildTaskPrompt(input);
    const requestBody = { model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }], response_format: { type: 'json_object' } };
    const request: ProviderRequestLog = { url: endpoint, headers: { authorization: '[redacted]', 'content-type': 'application/json' }, systemPrompt, userPrompt, body: JSON.stringify(requestBody) };
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: request.body });
      const rawResponse = await response.text();
      let body: { id?: string; model?: string; choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>; error?: { message?: string } };
      const safeRawResponse = redact(rawResponse, apiKey);
      try { body = JSON.parse(rawResponse); } catch { throw new ProviderRequestError(config.provider, model, 'provider_invalid_json_response', request, safeRawResponse); }
      if (!response.ok) throw new ProviderRequestError(config.provider, model, `provider_http_${response.status}`, request, safeRawResponse);
      const content = body.choices?.[0]?.message?.content;
      const output = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
      if (!output) throw new ProviderRequestError(config.provider, model, 'provider_empty_output', request, safeRawResponse);
      return { provider: config.provider, model: body.model ?? model, rawOutput: redact(output, apiKey), rawResponse: safeRawResponse, request, ...(body.id ? { requestId: body.id } : {}) };
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError(config.provider, model, 'provider_request_failed', request);
    }
  } };
}

function inferProvider(baseUrl?: string): string | null {
  if (!baseUrl) return null;
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (host.includes('deepseek')) return 'deepseek';
  if (host.includes('moonshot') || host.includes('kimi')) return 'kimi';
  if (host.includes('openai')) return 'openai';
  return host.split('.')[0] || 'openai-compatible';
}
function toChatCompletionsEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

function validateInput(input: TaskGenerationInput): void {
  if (!input.word?.id || !input.word.text || !input.word.sense?.id || !input.word.sense.definition || !input.promptVersion || !input.learner?.language || !validVocabularyProfile(input.learner.vocabularyProfile) || (input.learner.contentLevel !== undefined && !input.learner.contentLevel.trim())) throw new TypeError('word, sense, vocabulary profile, learner language, and promptVersion are required');
  if (input.task === 'ENCODE' && input.axis !== 'both') throw new TypeError('ENCODE requires axis both');
  if (input.task !== 'ENCODE' && input.axis === 'both') throw new TypeError('axis-specific tasks require R or P');
  if ((input.task === 'RETRIEVE') !== Boolean(input.stage)) throw new TypeError('stage is required only for RETRIEVE');
}
function validVocabularyProfile(value: VocabularyEstimate | undefined): value is VocabularyEstimate {
  return Boolean(value && Number.isFinite(value.size) && value.size >= 0 && value.listSource?.id && value.listSource.basis && value.sourceVersion && Array.isArray(value.distribution) && value.distribution.length > 0 && value.distribution.every(item => Number.isFinite(item.value) && item.value >= 0 && Number.isFinite(item.probability) && item.probability >= 0) && Math.abs(value.distribution.reduce((sum, item) => sum + item.probability, 0) - 1) < 1e-6 && value.uncertainty && Number.isFinite(value.uncertainty.lower) && Number.isFinite(value.uncertainty.upper));
}
function validateMaterial(value: unknown, input: TaskGenerationInput): string[] {
  const errors: string[] = [];
  if (!isObject(value)) return ['material_not_object'];
  const expected = input.task === 'ENCODE' ? 'ENCODE' : input.task;
  if (!exactKeys(value, ['schemaVersion', 'task', 'wordId', 'content']) || value.schemaVersion !== '1' || value.task !== expected || value.wordId !== input.word.id || !isObject(value.content)) return ['envelope_mismatch'];
  const c = value.content;
  if (input.task === 'ENCODE') {
    if (!exactKeys(c, ['word', 'definition', 'examples', 'instruction'], ['pronunciation', 'partOfSpeech'])) errors.push('invalid_encode_schema');
    if (c.word !== input.word.text || c.definition !== input.word.sense.definition) errors.push('sense_mismatch');
    if (!Array.isArray(c.examples) || c.examples.length < 1 || c.examples.some(e => !isObject(e) || !nonempty(e.sentence))) errors.push('invalid_examples');
    if (!nonempty(c.instruction)) errors.push('invalid_instruction');
  } else if (input.task === 'RETRIEVE') {
    const contentKeys = input.stage === 'choice' ? ['axis', 'stage', 'prompt', 'options', 'answerOptionId', 'explanation'] : input.stage === 'cued' ? ['axis', 'stage', 'prompt', 'cue', 'answerKey'] : ['axis', 'stage', 'prompt', 'answerKey'];
    if (!exactKeys(c, contentKeys)) errors.push('invalid_retrieve_schema');
    if (c.axis !== input.axis || c.stage !== input.stage || !nonempty(c.prompt)) errors.push('task_variant_mismatch');
    if (input.stage === 'choice') {
      if (!Array.isArray(c.options) || c.options.length < 2 || c.options.some(o => !isObject(o) || !nonempty(o.id) || !nonempty(o.text)) || new Set(c.options.map(o => o.id)).size !== c.options.length || !c.options.some(o => o.id === c.answerOptionId) || !nonempty(c.explanation)) errors.push('invalid_choice');
    } else {
      if (input.stage === 'cued' && !nonempty(c.cue)) errors.push('invalid_cue');
      if (!isObject(c.answerKey) || !Array.isArray(c.answerKey.acceptedAnswers) || !c.answerKey.acceptedAnswers.length || c.answerKey.acceptedAnswers.some(a => !nonempty(a)) || !nonempty(c.answerKey.explanation)) errors.push('invalid_answer_key');
      const answer = isObject(c.answerKey) && Array.isArray(c.answerKey.acceptedAnswers) ? c.answerKey.acceptedAnswers : [];
      if (!answer.some(a => typeof a === 'string' && a.toLowerCase() === input.word.text.toLowerCase())) errors.push('target_answer_mismatch');
      if ([c.prompt, c.cue].filter(nonempty).some(text => answer.some(a => text.toLowerCase().includes(a.toLowerCase())))) errors.push('answer_disclosed');
    }
  } else if (input.axis === 'R') {
    if (!exactKeys(c, ['axis', 'passage', 'questions', 'targetOccurrences'])) errors.push('invalid_reading_fluency_schema');
    const passage = c.passage;
    const words = typeof passage === 'string' ? passage.trim().split(/\s+/).filter(Boolean) : [];
    const occurrences = countOccurrences(String(passage ?? ''), input.word.text);
    if (words.length < 90 || words.length > 120) errors.push('passage_word_count');
    if (occurrences < 5 || c.targetOccurrences !== occurrences) errors.push('target_occurrence_count');
    if (!Array.isArray(c.questions) || c.questions.length !== 2 || c.questions.some(q => !isObject(q) || !['target_meaning', 'passage_comprehension'].includes(q.role) || !nonempty(q.prompt) || !nonempty(q.answer) || !nonempty(q.evidence) || !String(passage ?? '').toLowerCase().includes(q.evidence.toLowerCase())) || new Set(Array.isArray(c.questions) ? c.questions.map(q => q?.role) : []).size !== 2) errors.push('invalid_questions');
  } else {
    if (!exactKeys(c, ['axis', 'scenario', 'responseInstruction', 'gradingRequirements'])) errors.push('invalid_production_fluency_schema');
    if (!nonempty(c.scenario) || !nonempty(c.responseInstruction) || !isObject(c.gradingRequirements) || !nonempty(c.gradingRequirements.targetExpression) || !stringArray(c.gradingRequirements.targetUseCriteria) || !stringArray(c.gradingRequirements.overallExpressionCriteria)) errors.push('invalid_production_fluency');
    if (String(c.scenario ?? '').includes(input.word.text) || String(c.responseInstruction ?? '').includes(input.word.text)) errors.push('target_revealed');
  }
  return errors;
}
function countOccurrences(text: string, target: string): number { const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return (text.match(new RegExp(`\\b${escaped}\\b`, 'gi')) ?? []).length; }
function stringArray(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.every(nonempty); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function isObject(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean { const keys = Object.keys(value); return required.every(key => keys.includes(key)) && keys.every(key => required.includes(key) || optional.includes(key)); }
function redact(value: string, secret?: string): string { return secret ? value.split(secret).join('[redacted]') : value; }
function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
