import { describe, expect, test } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gradeFluencyAttempt, retryFluencyAttempt, MemoryGradingStore, SqliteGradingStore, createFixtureGrader, createConfiguredGrader, type FluencyGradingInput, type GradingAttemptEvent } from '../lib/task-grading';
import type { AxisSchedule } from '../lib/schedule';

const axis = (overrides: Partial<AxisSchedule> = {}): AxisSchedule => ({ score: 60, target: 80, learningComplete: false, fluencyPass: false, reviewLevel: 1, graduated: false, dueAt: '2026-11-10', ...overrides });
const base = (which: 'R' | 'P' = 'R'): FluencyGradingInput => ({
  attemptId: `attempt-${which}`, generationId: 'generation-1',
  task: which === 'R'
    ? { schemaVersion: '1', task: 'FLUENCY', wordId: 'w1', content: { axis: 'R', passage: 'A harbor welcomes many boats. '.repeat(20), targetOccurrences: 20, questions: [{ role: 'target_meaning', prompt: 'What does harbor mean?', answer: 'A safe place for ships.', evidence: 'harbor welcomes many boats' }, { role: 'passage_comprehension', prompt: 'What does it welcome?', answer: 'Boats.', evidence: 'welcomes many boats' }] } }
    : { schemaVersion: '1', task: 'FLUENCY', wordId: 'w1', content: { axis: 'P', scenario: 'Describe a safe place for ships.', responseInstruction: 'Say one sentence.', gradingRequirements: { targetExpression: 'harbor', targetUseCriteria: ['use harbor with the right meaning'], overallExpressionCriteria: ['sentence is understandable'] } } },
  submission: which === 'R' ? { axis: 'R', answers: { target_meaning: 'A safe place for ships.', passage_comprehension: 'It welcomes boats.' } } : { axis: 'P', response: 'The harbor is safe for ships.' },
  learner: { level: 'B1', language: 'en' }, validity: { timingValid: true, interrupted: false, materialValid: true, speedWpm: which === 'R' ? 180 : 35 }, date: '2026-11-10',
  word: { R: axis(), P: axis() },
});
const passing = { target: { passed: true, evidence: 'The target word is used with its correct meaning.' }, overall: { passed: true, evidence: 'The response is clear and relevant.' } };
const passingR = { targetMeaning: { passed: true, evidence: 'The target meaning answer is correct.' }, passageComprehension: { passed: true, evidence: 'The passage answer is supported.' } };

describe('P7 FLUENCY grading', () => {
  test.each(['R', 'P'] as const)('grades %s through fixture and settles existing score/schedule logic', async which => {
    const store = new MemoryGradingStore(); const events: GradingAttemptEvent[] = []; const scores: unknown[] = []; const schedules: unknown[] = [];
    const decision = await gradeFluencyAttempt(base(which), createFixtureGrader([which === 'R' ? passingR : passing]), store, { logger: e => events.push(e), scoreLogger: e => scores.push(e), scheduleLogger: e => schedules.push(e) });
    expect(decision).toMatchObject(which === 'R' ? { status: 'graded', targetMeaning: { passed: true }, passageComprehension: { passed: true } } : { status: 'graded', target: { passed: true }, overall: { passed: true } });
    expect(scores).toHaveLength(1); expect(schedules).toHaveLength(1);
    expect(scores[0]).toMatchObject({ attemptId: `attempt-${which}` }); expect(schedules[0]).toMatchObject({ attemptId: `attempt-${which}` });
    expect(store.load(`attempt-${which}`)?.scoreEvent).toMatchObject({ attemptId: `attempt-${which}` });
    expect(store.load(`attempt-${which}`)?.scheduleEvent).toMatchObject({ attemptId: `attempt-${which}` });
    expect(events[0]).toMatchObject({ event: 'task_grading.attempt', attemptId: `attempt-${which}`, scoreSettled: true, scheduleSettled: true });
    expect(store.load(`attempt-${which}`)?.updatedWord?.[which].score).toBeGreaterThan(60);
  });

  test('R result keeps target meaning and passage comprehension as separate decisions', async () => {
    const store = new MemoryGradingStore();
    const result = await gradeFluencyAttempt(base(), createFixtureGrader([{ targetMeaning: { passed: true, evidence: 'Meaning matches.' }, passageComprehension: { passed: false, evidence: 'Passage answer is wrong.' } }]), store, { logger: () => undefined });
    expect(result).toMatchObject({ status: 'graded', targetMeaning: { passed: true }, passageComprehension: { passed: false } });
  });

  test.each([
    ['interrupted', { validity: { timingValid: true, interrupted: true, materialValid: true, speedWpm: 180 } }, 'interrupted'],
    ['bad timing', { validity: { timingValid: false, interrupted: false, materialValid: true, speedWpm: 180 } }, 'timing_invalid'],
    ['bad R schema roles', { task: { schemaVersion: '1', task: 'FLUENCY', wordId: 'w1', content: { axis: 'R', passage: 'text', targetOccurrences: 1, questions: [{ role: 'other', prompt: 'q', answer: 'a', evidence: 'text' }, { role: 'passage_comprehension', prompt: 'q', answer: 'a', evidence: 'text' }] } } }, 'material_invalid'],
  ] as const)('does not ask grader or settle for %s', async (_label, change, reason) => {
    const input = { ...base(), ...change } as FluencyGradingInput; const calls: unknown[] = []; const store = new MemoryGradingStore();
    const result = await gradeFluencyAttempt(input, { async grade() { calls.push(1); return { provider: 'x', model: 'x', rawOutput: JSON.stringify(passing) }; } }, store, { logger: () => undefined });
    expect(result).toMatchObject({ status: 'invalid', reason }); expect(calls).toHaveLength(0);
    expect(store.load(input.attemptId)?.updatedWord).toBeUndefined();
  });

  test('retries malformed output with frozen original answer and settles only once', async () => {
    const store = new MemoryGradingStore(); const original = base(); let count = 0; const received: string[] = [];
    const grader = { async grade({ input }: { input: FluencyGradingInput }) { count++; received.push(input.submission.axis === 'R' ? input.submission.answers.target_meaning : input.submission.response); return { provider: 'fixture', model: 'fixture', rawOutput: count === 1 ? '{bad' : JSON.stringify(passingR) }; } };
    const events: GradingAttemptEvent[] = [];
    const first = await gradeFluencyAttempt(original, grader, store, { logger: e => events.push(e) });
    const again = await gradeFluencyAttempt({ ...original, submission: { axis: 'R', answers: { target_meaning: 'edited answer', passage_comprehension: 'edited answer' } } }, grader, store, { logger: e => events.push(e) });
    expect(first.status).toBe('graded'); expect(again).toEqual(first); expect(received).toEqual(['A safe place for ships.', 'A safe place for ships.']);
    expect(events.map(e => e.attempt)).toEqual([1, 2]);
  });

  test('retry exhaustion leaves the saved attempt unsettled and does not log score or schedule updates', async () => {
    const store = new MemoryGradingStore(); const grading: GradingAttemptEvent[] = []; const scoreEvents: unknown[] = []; const scheduleEvents: unknown[] = [];
    const result = await gradeFluencyAttempt(base('P'), createFixtureGrader(['{bad', { target: { passed: true } }]), store, { maxAttempts: 2, logger: e => grading.push(e), scoreLogger: e => scoreEvents.push(e), scheduleLogger: e => scheduleEvents.push(e) });
    expect(result).toMatchObject({ status: 'unavailable', reason: 'invalid_grade_schema' });
    expect(grading).toHaveLength(2); expect(grading[0].errors).toEqual(['invalid_json']);
    expect(scoreEvents).toHaveLength(0); expect(scheduleEvents).toHaveLength(0);
    expect(store.load('attempt-P')?.decision).toBeUndefined();
  });

  test('valid target failure uses the existing P1 score and schedule settlement', async () => {
    const store = new MemoryGradingStore();
    const result = await gradeFluencyAttempt(base('P'), createFixtureGrader([{ target: { passed: false, evidence: 'The target expression is missing.' }, overall: { passed: true, evidence: 'The sentence is clear.' } }]), store, { logger: () => undefined });
    expect(result).toMatchObject({ status: 'graded', target: { passed: false }, overall: { passed: true } });
    expect(store.load('attempt-P')?.updatedWord?.P).toMatchObject({ score: 40, dueAt: '2026-11-10' });
  });

  test('provider adapter reads the three LLM variables and redacts the credential in audit request', async () => {
    const grader = createConfiguredGrader({ apiKey: 'secret', baseUrl: 'https://provider.test/v1', model: 'unit-model', fetcher: (async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer secret');
      return new Response(JSON.stringify({ id: 'r1', choices: [{ message: { content: JSON.stringify(passing) } }] }), { status: 200 });
    }) as typeof fetch });
    const events: GradingAttemptEvent[] = [];
    const result = await gradeFluencyAttempt(base('P'), grader, new MemoryGradingStore(), { logger: e => events.push(e) });
    expect(result.status).toBe('graded'); expect(events[0].request?.headers.authorization).toBe('[redacted]'); expect(JSON.stringify(events)).not.toContain('secret');
  });

  test('SQLite reload keeps the first answer and frozen issued task across store instances', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'flow-p7-'));
    const file = path.join(dir, 'attempts.sqlite');
    try {
      const firstStore = new SqliteGradingStore(file);
      const original = base('P');
      await gradeFluencyAttempt(original, createFixtureGrader(['{bad']), firstStore, { maxAttempts: 1, logger: () => undefined });
      firstStore.close();
      const reopened = new SqliteGradingStore(file);
      const result = await retryFluencyAttempt(original.attemptId, createFixtureGrader([passing]), reopened, { logger: () => undefined });
      const loaded = reopened.load(original.attemptId);
      expect(result.status).toBe('graded');
      expect(loaded?.input.submission).toEqual(original.submission);
      expect(loaded?.decision).toMatchObject({ status: 'graded' });
      reopened.close();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('no API key is needed for the fixture service; missing reading roles are invalid', async () => {
    expect(await gradeFluencyAttempt(base('P'), createFixtureGrader([passing]), new MemoryGradingStore(), { logger: () => undefined })).toMatchObject({ status: 'graded' });
    const malformed = base('R');
    (malformed.task as any).content.questions[0] = { prompt: 'old saved question', answer: 'a', evidence: 'harbor welcomes many boats' };
    expect(await gradeFluencyAttempt(malformed, createFixtureGrader([passing]), new MemoryGradingStore(), { logger: () => undefined })).toMatchObject({ status: 'invalid', reason: 'material_invalid' });
  });
});
