import type Database from 'better-sqlite3';
import { applyTaskResult, getNextTaskInstance, snapshot } from '@/lib/scheduler';
import { TASK_LIBRARY, type ScheduledTaskInstance, type TaskEvidence, type TaskInstance } from '@/lib/tasks';

type InstanceRow = {
  instance_id: string;
  status: 'issued' | 'submitted';
  instance_json: string;
  response_json: string | null;
  writeback_json: string | null;
};

export class TaskApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

function readInstance(row: InstanceRow): TaskInstance {
  return JSON.parse(row.instance_json) as TaskInstance;
}

const isMeaningAnswerKey = (key: string) => {
  const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
  return [
    'meaning',
    'expectedmeaning',
    'targetmeaning',
    'meaninganswer',
    'answemeaning',
  ].includes(normalizedKey);
};

function redactMeaningAnswers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMeaningAnswers);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !isMeaningAnswerKey(key))
      .map(([key, nested]) => [key, redactMeaningAnswers(nested)])
  );
}

/** Keep server-side answer data private for independent R tasks. */
function publicInstance(task: ScheduledTaskInstance): ScheduledTaskInstance {
  if (task.type === 'EMPTY') return task;
  const isIndependentRTask = task.axis === 'r' && task.type !== 'ENCODE';
  const payload = isIndependentRTask
    ? (redactMeaningAnswers(task.payload) as Record<string, unknown>)
    : { ...task.payload };
  delete payload.answer_index;
  return { ...task, payload };
}

function insertIssued(db: Database.Database, now: number): ScheduledTaskInstance {
  const active = db.prepare(
    `SELECT instance_id, status, instance_json, response_json, writeback_json
       FROM task_instances WHERE status = 'issued' ORDER BY issued_at DESC LIMIT 1`
  ).get() as InstanceRow | undefined;
  if (active) return readInstance(active);

  const task = getNextTaskInstance(db, now);
  if (task.type !== 'EMPTY') {
    db.prepare(
      `INSERT INTO task_instances (instance_id, status, instance_json, issued_at)
       VALUES (?, 'issued', ?, ?)`
    ).run(task.instance_id, JSON.stringify(task), task.issued_at);
  }
  return task;
}

export function getOrIssueTask(db: Database.Database, now = Date.now()) {
  const task = db.transaction(() => insertIssued(db, now))();
  return { task: publicInstance(task), ...snapshot(db) };
}

const normalized = (value: string) => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

function submittedAnswers(response: Record<string, unknown>, wordIds: readonly number[]): Map<number, string> {
  const answers = new Map<number, string>();
  const expected = new Set(wordIds);
  const raw = response.word_answers;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isObject(entry) || !Number.isInteger(entry.word_id) || typeof entry.answer !== 'string') {
        throw new TaskApiError('word answer is malformed', 400);
      }
      const wordId = entry.word_id as number;
      if (!expected.has(wordId) || answers.has(wordId)) throw new TaskApiError('word answer does not match the issued instance', 400);
      answers.set(wordId, entry.answer);
    }
  } else if (isObject(raw)) {
    for (const [id, answer] of Object.entries(raw)) {
      const wordId = Number(id);
      if (!Number.isInteger(wordId) || !expected.has(wordId) || typeof answer !== 'string') {
        throw new TaskApiError('word answer does not match the issued instance', 400);
      }
      answers.set(wordId, answer);
    }
  }
  if (answers.size === 0 && typeof response.answer === 'string') {
    // Single-word renderers may use the short form; bind it to the issued word later.
    if (wordIds.length !== 1) throw new TaskApiError('multi-word task requires per-word answers', 400);
    answers.set(-1, response.answer);
  }
  if (answers.size === 0 && typeof response.text === 'string') answers.set(-1, response.text);
  if (answers.size > 0 && [...expected].some((wordId) => !answers.has(wordId) && !answers.has(-1))) {
    throw new TaskApiError('one or more issued words are missing answers', 400);
  }
  return answers;
}

function deriveWordResults(
  db: Database.Database,
  task: TaskInstance,
  response: Record<string, unknown>
): TaskEvidence['word_results'] {
  const answers = submittedAnswers(response, task.word_ids);
  return task.word_ids.map((wordId) => {
    const word = db.prepare('SELECT chunk, meaning FROM words WHERE id = ?').get(wordId) as
      | { chunk: string; meaning: string }
      | undefined;
    const answer = answers.get(wordId) ?? answers.get(-1) ?? '';
    if (!word) return { word_id: wordId, correct: false };
    const expected = task.axis === 'p' ? word.chunk : word.meaning;
    const actualNormalized = normalized(answer);
    const expectedNormalized = normalized(expected);
    const correct = task.type === 'FLUENCY' || task.type === 'INTEGRATE'
      ? actualNormalized.includes(expectedNormalized)
      : actualNormalized === expectedNormalized;
    return { word_id: wordId, correct };
  });
}

function validatedEvidence(
  db: Database.Database,
  task: TaskInstance,
  response: Record<string, unknown>,
  raw: unknown
): TaskEvidence {
  if (!isObject(raw)) throw new TaskApiError('evidence must be an object', 400);
  if (typeof raw.independent !== 'boolean' || typeof raw.answer_revealed !== 'boolean' || typeof raw.hint_used !== 'boolean') {
    throw new TaskApiError('independence evidence is malformed', 400);
  }
  if (!Array.isArray(raw.word_results)) throw new TaskApiError('word result evidence must be an array', 400);
  const submittedWordIds = raw.word_results.map((item) => {
    if (!isObject(item) || !Number.isInteger(item.word_id) || typeof item.correct !== 'boolean') {
      throw new TaskApiError('word result evidence is malformed', 400);
    }
    return item.word_id as number;
  });
  if (
    new Set(submittedWordIds).size !== submittedWordIds.length ||
    submittedWordIds.length !== task.word_ids.length ||
    task.word_ids.some((id) => !submittedWordIds.includes(id))
  ) throw new TaskApiError('word result IDs do not match the issued instance', 400);
  if (!isObject(raw.accuracy)) throw new TaskApiError('accuracy evidence must be an object', 400);
  const definition = TASK_LIBRARY.find((item) => item.id === task.definition_id);
  if (!definition) throw new TaskApiError('issued task definition is unavailable', 409);
  const accuracy: Record<string, boolean> = {};
  for (const key of definition.evidence.accuracy_check) {
    if (typeof raw.accuracy[key] !== 'boolean') {
      throw new TaskApiError(`missing accuracy evidence: ${key}`, 400);
    }
    accuracy[key] = raw.accuracy[key] as boolean;
  }
  const wordResults = deriveWordResults(db, task, response);
  accuracy.target_word = wordResults.length > 0 && wordResults.every((item) => item.correct);

  if (task.axis === 'r' && definition.evidence.accuracy_check.includes('passage_comprehension')) {
    const expectedIndex = task.payload.answer_index;
    const submittedIndex = response.passage_answer_index;
    // When a server-keyed comprehension option exists, derive this check from the answer.
    if (typeof expectedIndex === 'number') {
      accuracy.passage_comprehension = submittedIndex === expectedIndex;
    } else {
      // A client-declared true value cannot substitute for a server-known answer key.
      accuracy.passage_comprehension = false;
    }
  }
  if (task.axis === 'p' && definition.evidence.accuracy_check.includes('expression')) {
    const text = typeof response.text === 'string' ? response.text : '';
    const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
    accuracy.expression = wordCount >= 30 && accuracy.target_word === true;
  }

  const speedMode = definition.evidence.speed_mode;
  if (raw.speed_mode !== speedMode) throw new TaskApiError('speed mode does not match the issued task', 400);
  const duration = raw.duration_ms;
  if (duration !== null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0 || duration > 24 * 60 * 60_000)) {
    throw new TaskApiError('duration evidence is invalid', 400);
  }
  let speedValue: number | null = null;
  if (speedMode === 'reading_wpm' || speedMode === 'writing_wpm') {
    if (typeof duration !== 'number') throw new TaskApiError('continuous task requires duration evidence', 400);
    const count = speedMode === 'reading_wpm'
      ? Number(task.payload.passage_words)
      : (typeof response.text === 'string' ? response.text.trim().split(/\s+/).filter(Boolean).length : 0);
    if (!Number.isFinite(count) || count <= 0) throw new TaskApiError('continuous task has no measurable material', 400);
    speedValue = (count * 60_000) / duration;
  }
  return {
    independent: raw.independent,
    answer_revealed: raw.answer_revealed,
    hint_used: raw.hint_used,
    accuracy,
    speed_mode: speedMode,
    speed_value: speedValue,
    duration_ms: typeof duration === 'number' ? duration : null,
    word_results: wordResults,
  };
}

export interface SubmitTaskResult {
  instance_id: string;
  response: Readonly<Record<string, unknown>>;
  evidence: unknown;
}

export function submitTaskResult(db: Database.Database, input: unknown, now = Date.now()) {
  if (!isObject(input) || typeof input.instance_id !== 'string' || !isObject(input.response)) {
    throw new TaskApiError('result must include instance_id and response', 400);
  }
  const result = input as unknown as SubmitTaskResult;
  const responseJson = JSON.stringify(result.response);
  if (responseJson.length > 200_000) throw new TaskApiError('response is too large', 413);

  return db.transaction(() => {
    const row = db.prepare(
      `SELECT instance_id, status, instance_json, response_json, writeback_json
         FROM task_instances WHERE instance_id = ?`
    ).get(result.instance_id) as InstanceRow | undefined;
    if (!row) throw new TaskApiError('task instance not found', 404);
    if (row.status === 'submitted') {
      const task = insertIssued(db, now);
      return { duplicate: true, task: publicInstance(task), writeback: row.writeback_json ? JSON.parse(row.writeback_json) : null };
    }

    const task = readInstance(row);
    const definition = TASK_LIBRARY.find((item) => item.id === task.definition_id);
    if (!definition || definition.type !== task.type || !definition.supported_axes.includes(task.axis)) {
      throw new TaskApiError('issued task contract is invalid', 409);
    }
    const evidence = validatedEvidence(db, task, result.response, result.evidence);
    // T05 owns score mutation. Nesting its transaction keeps score, event, and the
    // submitted marker atomic with this outer transaction.
    const writeback = applyTaskResult(db, task, evidence, now);
    db.prepare(
      `UPDATE task_instances SET status = 'submitted', submitted_at = ?, response_json = ?, writeback_json = ?
         WHERE instance_id = ? AND status = 'issued'`
    ).run(now, responseJson, JSON.stringify(writeback), task.instance_id);
    const nextTask = insertIssued(db, now);
    return { duplicate: false, task: publicInstance(nextTask), writeback };
  })();
}

export function taskSnapshot(db: Database.Database) {
  return snapshot(db);
}
