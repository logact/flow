import { expect, test } from '@jest/globals';
import { createConfiguredTaskMaterialGenerator, generateTask, toLearnerTask, type TaskGenerationInput } from '../lib/task-material';

const cases: Record<string, TaskGenerationInput> = {
  encode: {
    word: { id: 'live-harbor', text: 'harbor', sense: { id: 'sense-1', definition: 'a sheltered place where ships can stay safely' } },
    axis: 'both', task: 'ENCODE', learner: { vocabularyProfile: { size: 1200, listSource: { id: 'BNC_COCA_L6_v2', basis: 'word-family-frequency-band' }, sourceVersion: '2.0.0', distribution: [{ value: 1100, probability: 0.25 }, { value: 1200, probability: 0.5 }, { value: 1300, probability: 0.25 }], uncertainty: { lower: 900, upper: 1500, method: 'fixture' } }, score: { R: 0, P: 0 }, language: 'zh' }, promptVersion: 'p6-v1',
  },
  'retrieve-r-choice': {
    word: { id: 'live-harbor', text: 'harbor', sense: { id: 'sense-1', definition: 'a sheltered place where ships can stay safely' } },
    axis: 'R', task: 'RETRIEVE', stage: 'choice', learner: { vocabularyProfile: { size: 1200, listSource: { id: 'BNC_COCA_L6_v2', basis: 'word-family-frequency-band' }, sourceVersion: '2.0.0', distribution: [{ value: 1100, probability: 0.25 }, { value: 1200, probability: 0.5 }, { value: 1300, probability: 0.25 }], uncertainty: { lower: 900, upper: 1500, method: 'fixture' } }, score: 5, language: 'zh' }, promptVersion: 'p6-v1',
  },
  'retrieve-p-cued': {
    word: { id: 'live-harbor', text: 'harbor', sense: { id: 'sense-1', definition: 'a sheltered place where ships can stay safely' } },
    axis: 'P', task: 'RETRIEVE', stage: 'cued', learner: { vocabularyProfile: { size: 1200, listSource: { id: 'BNC_COCA_L6_v2', basis: 'word-family-frequency-band' }, sourceVersion: '2.0.0', distribution: [{ value: 1100, probability: 0.25 }, { value: 1200, probability: 0.5 }, { value: 1300, probability: 0.25 }], uncertainty: { lower: 900, upper: 1500, method: 'fixture' } }, score: 25, language: 'zh' }, promptVersion: 'p6-v1',
  },
  'retrieve-p-free': {
    word: { id: 'live-harbor', text: 'harbor', sense: { id: 'sense-1', definition: 'a sheltered place where ships can stay safely' } },
    axis: 'P', task: 'RETRIEVE', stage: 'free', learner: { vocabularyProfile: { size: 1200, listSource: { id: 'BNC_COCA_L6_v2', basis: 'word-family-frequency-band' }, sourceVersion: '2.0.0', distribution: [{ value: 1100, probability: 0.25 }, { value: 1200, probability: 0.5 }, { value: 1300, probability: 0.25 }], uncertainty: { lower: 900, upper: 1500, method: 'fixture' } }, score: 45, language: 'zh' }, promptVersion: 'p6-v1',
  },
  'fluency-r': {
    word: { id: 'live-harbor', text: 'harbor', sense: { id: 'sense-1', definition: 'a sheltered place where ships can stay safely' } },
    axis: 'R', task: 'FLUENCY', learner: { vocabularyProfile: { size: 1200, listSource: { id: 'BNC_COCA_L6_v2', basis: 'word-family-frequency-band' }, sourceVersion: '2.0.0', distribution: [{ value: 1100, probability: 0.25 }, { value: 1200, probability: 0.5 }, { value: 1300, probability: 0.25 }], uncertainty: { lower: 900, upper: 1500, method: 'fixture' } }, score: 70, language: 'zh' }, promptVersion: 'p6-v1',
  },
  'fluency-p': {
    word: { id: 'live-harbor', text: 'harbor', sense: { id: 'sense-1', definition: 'a sheltered place where ships can stay safely' } },
    axis: 'P', task: 'FLUENCY', learner: { vocabularyProfile: { size: 1200, listSource: { id: 'BNC_COCA_L6_v2', basis: 'word-family-frequency-band' }, sourceVersion: '2.0.0', distribution: [{ value: 1100, probability: 0.25 }, { value: 1200, probability: 0.5 }, { value: 1300, probability: 0.25 }], uncertainty: { lower: 900, upper: 1500, method: 'fixture' } }, score: 70, language: 'zh' }, promptVersion: 'p6-v1',
  },
};
const profiles = ['low', 'middle', 'high'].map((_, i) => ({ size: [500, 12000, 24000][i], listSource: { id: 'BNC_COCA_L6_v2', basis: 'word-family-frequency-band' }, sourceVersion: '2.0.0', distribution: [{ value: [400, 11000, 23000][i], probability: 0.25 }, { value: [500, 12000, 24000][i], probability: 0.5 }, { value: [600, 13000, 25000][i], probability: 0.25 }], uncertainty: { lower: Math.max(0, [300, 10000, 22000][i]), upper: [700, 14000, 26000][i], method: 'debug-profile' } }));

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
    for (const [profileIndex, vocabularyProfile] of profiles.entries()) {
      test(`live LLM: ${variant} with ${['low', 'middle', 'high'][profileIndex]} recognition profile`, async () => {
        const input: TaskGenerationInput = { ...baseInput, learner: { ...baseInput.learner, vocabularyProfile } };
        const outcome = await generateTask(input, createConfiguredTaskMaterialGenerator([]), { maxAttempts: 1 });
        if (outcome.status !== 'ready') throw new Error(`${variant}/${profileIndex} output was rejected: ${outcome.reason}. Inspect logs/app.log for raw output and validation errors.`);
        const learnerTask = toLearnerTask(outcome.material);
        process.stdout.write(`${JSON.stringify({ variant, vocabularyProfile, generationId: outcome.generationId, material: learnerTask }, null, 2)}\n`);
        expect(learnerTask.wordId).toBe(input.word.id);
      }, 120_000);
    }
  }
}
