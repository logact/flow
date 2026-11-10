import { expect, test } from '@jest/globals';
import { createConfiguredGrader, gradeFluencyAttempt, MemoryGradingStore, type FluencyGradingInput } from '../lib/task-grading';
import type { AxisSchedule } from '../lib/schedule';

const axis = (): AxisSchedule => ({ score: 60, target: 80, learningComplete: false, fluencyPass: false, reviewLevel: 1, graduated: false, dueAt: '2026-11-10' });
const attempts: FluencyGradingInput[] = [
  { attemptId: 'live-p7-r-pass', task: { schemaVersion: '1', task: 'FLUENCY', wordId: 'live-harbor', content: { axis: 'R', passage: 'The harbor gives ships a safe place to wait. '.repeat(10).trim(), targetOccurrences: 10, questions: [{ role: 'target_meaning', prompt: 'What does harbor mean?', answer: 'A safe place for ships.', evidence: 'The harbor gives ships a safe place to wait' }, { role: 'passage_comprehension', prompt: 'What uses the harbor?', answer: 'Ships.', evidence: 'harbor gives ships a safe place' }] } }, submission: { axis: 'R', answers: { target_meaning: 'A safe place for ships.', passage_comprehension: 'Ships and boats.' } }, learner: { vocabularyProfile: { size: 1200, listSource: { id: 'BNC_COCA_L6_v2', basis: 'word-family-frequency-band' }, sourceVersion: '2.0.0', distribution: [{ value: 1100, probability: 0.25 }, { value: 1200, probability: 0.5 }, { value: 1300, probability: 0.25 }], uncertainty: { lower: 900, upper: 1500, method: 'fixture' } }, language: 'en' }, validity: { timingValid: true, interrupted: false, materialValid: true, speedWpm: 180 }, date: '2026-11-10', word: { R: axis(), P: axis() } },
  { attemptId: 'live-p7-p-pass', task: { schemaVersion: '1', task: 'FLUENCY', wordId: 'live-harbor', content: { axis: 'P', scenario: 'Describe a safe place for ships.', responseInstruction: 'Say one sentence.', gradingRequirements: { targetExpression: 'harbor', targetUseCriteria: ['use harbor with its right meaning'], overallExpressionCriteria: ['answer is clear'] } } }, submission: { axis: 'P', response: 'The harbor is a safe place for ships.' }, learner: { vocabularyProfile: { size: 1200, listSource: { id: 'BNC_COCA_L6_v2', basis: 'word-family-frequency-band' }, sourceVersion: '2.0.0', distribution: [{ value: 1100, probability: 0.25 }, { value: 1200, probability: 0.5 }, { value: 1300, probability: 0.25 }], uncertainty: { lower: 900, upper: 1500, method: 'fixture' } }, language: 'en' }, validity: { timingValid: true, interrupted: false, materialValid: true, speedWpm: 35 }, date: '2026-11-10', word: { R: axis(), P: axis() } },
];
const liveCases = attempts.flatMap(original => {
  const isReading = original.submission.axis === 'R';
  const variants = isReading
    ? [
        ['pass', original.submission],
        ['fail', { axis: 'R' as const, answers: { target_meaning: 'A mountain path.', passage_comprehension: 'The harbor is a mountain.' } }],
        ['ambiguous', { axis: 'R' as const, answers: { target_meaning: 'I am not sure.', passage_comprehension: 'I do not know.' } }],
      ] as const
    : [
        ['pass', original.submission],
        ['fail', { axis: 'P' as const, response: 'There is a nice place.' }],
        ['ambiguous', { axis: 'P' as const, response: 'Maybe it is some kind of place, but I am not sure.' }],
      ] as const;
  return variants.map(([kind, submission]) => ({ kind, input: { ...original, attemptId: `${original.attemptId}-${kind}`, submission } as FluencyGradingInput }));
});
if (!process.env.LLM_API_KEY || !process.env.LLM_BASE_URL || !process.env.LLM_MODEL) {
  test('live P7 grading requires LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL', () => { throw new Error('Set LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL before running the live P7 command.'); });
} else {
  const grader = createConfiguredGrader();
  for (const { input, kind } of liveCases) test(`live LLM grades ${input.submission.axis} FLUENCY ${kind} response`, async () => {
    const result = await gradeFluencyAttempt(input, grader, new MemoryGradingStore(), { maxAttempts: 1 });
    process.stdout.write(`${JSON.stringify({ axis: input.submission.axis, kind, result })}\n`);
    expect(['graded', 'unavailable']).toContain(result.status);
  }, 120_000);
}
