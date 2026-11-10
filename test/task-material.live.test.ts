import { expect, test } from '@jest/globals';
import { createConfiguredTaskMaterialGenerator, generateTask, toLearnerTask, type TaskGenerationInput } from '../lib/task-material';

const cases: Record<string, TaskGenerationInput> = {
  encode: {
    word: { id: 'live-harbor', text: 'harbor', sense: { id: 'sense-1', definition: 'a sheltered place where ships can stay safely' } },
    axis: 'both', task: 'ENCODE', learner: { level: 'B1', score: { R: 0, P: 0 }, language: 'zh' }, promptVersion: 'p6-v1',
  },
  'retrieve-r-choice': {
    word: { id: 'live-harbor', text: 'harbor', sense: { id: 'sense-1', definition: 'a sheltered place where ships can stay safely' } },
    axis: 'R', task: 'RETRIEVE', stage: 'choice', learner: { level: 'B1', score: 5, language: 'zh' }, promptVersion: 'p6-v1',
  },
  'retrieve-p-cued': {
    word: { id: 'live-harbor', text: 'harbor', sense: { id: 'sense-1', definition: 'a sheltered place where ships can stay safely' } },
    axis: 'P', task: 'RETRIEVE', stage: 'cued', learner: { level: 'B1', score: 25, language: 'zh' }, promptVersion: 'p6-v1',
  },
  'retrieve-p-free': {
    word: { id: 'live-harbor', text: 'harbor', sense: { id: 'sense-1', definition: 'a sheltered place where ships can stay safely' } },
    axis: 'P', task: 'RETRIEVE', stage: 'free', learner: { level: 'B1', score: 45, language: 'zh' }, promptVersion: 'p6-v1',
  },
  'fluency-r': {
    word: { id: 'live-harbor', text: 'harbor', sense: { id: 'sense-1', definition: 'a sheltered place where ships can stay safely' } },
    axis: 'R', task: 'FLUENCY', learner: { level: 'B1', score: 70, language: 'zh' }, promptVersion: 'p6-v1',
  },
  'fluency-p': {
    word: { id: 'live-harbor', text: 'harbor', sense: { id: 'sense-1', definition: 'a sheltered place where ships can stay safely' } },
    axis: 'P', task: 'FLUENCY', learner: { level: 'B1', score: 70, language: 'zh' }, promptVersion: 'p6-v1',
  },
};
const learnerLevels = ['A1', 'B1', 'C1'];

if (!process.env.LLM_API_KEY) {
  test('live LLM requires LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL', () => {
    throw new Error('Set LLM_API_KEY, LLM_BASE_URL, and LLM_MODEL before running the live P6 command.');
  });
} else {
  const selected = process.env.P6_LIVE_VARIANT;
  const variants = selected ? [selected] : Object.keys(cases);
  for (const variant of variants) {
    const baseInput = cases[variant];
    if (!baseInput) throw new Error(`Unknown P6_LIVE_VARIANT "${variant}". Choose: ${Object.keys(cases).join(', ')}`);
    for (const level of learnerLevels) {
      test(`live LLM: ${variant} for ${level}`, async () => {
        const input: TaskGenerationInput = { ...baseInput, learner: { ...baseInput.learner, level } };
        const outcome = await generateTask(input, createConfiguredTaskMaterialGenerator([]), { maxAttempts: 1 });
        if (outcome.status !== 'ready') throw new Error(`${variant}/${level} output was rejected: ${outcome.reason}. Inspect logs/app.log for raw output and validation errors.`);
        const learnerTask = toLearnerTask(outcome.material);
        process.stdout.write(`${JSON.stringify({ variant, level, generationId: outcome.generationId, material: learnerTask }, null, 2)}\n`);
        expect(learnerTask.wordId).toBe(input.word.id);
      }, 120_000);
    }
  }
}
