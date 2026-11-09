import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { estimateNewWordCapacity, planCapacity, recordNewWordCapacityEstimate, FIRST_DAY_TASK_DEMAND, type CapacityInput } from '../lib/capacity';
import { logger as appLogger } from '../lib/logger';
import type { AxisSchedule } from '../lib/schedule';

const axis = (overrides: Partial<AxisSchedule> = {}): AxisSchedule => ({ score: 0, target: 60, learningComplete: false, fluencyPass: false, reviewLevel: 1, graduated: false, dueAt: 'infinity', ...overrides });
const input = (overrides: Partial<CapacityInput> = {}): CapacityInput => ({
  asOf: '2026-12-20', maxTasksPerDay: 10,
  words: [], completedByDate: {}, ...overrides,
});

test('builds 42 inclusive local-date rows across year boundary', () => {
  const plan = planCapacity(input());
  expect(plan.days).toHaveLength(42);
  expect(plan.days[0].date).toBe('2026-12-20');
  expect(plan.through).toBe('2027-01-30');
});

test('counts completed, confirmed, and overdue tasks separately without rewriting due dates', () => {
  const overdueDueAt = '2026-12-18';
  const word = { id: 'w', R: axis({ score: 20, learningComplete: true, dueAt: overdueDueAt }), P: axis({ score: 20, learningComplete: true, dueAt: '2026-12-20' }) };
  const plan = planCapacity(input({ words: [word], completedByDate: { '2026-12-20': 2 } }));
  expect(plan.days[0]).toMatchObject({ completed: 2, confirmed: 1, overdue: 1, remaining: 6 });
  expect(word.R.dueAt).toBe(overdueDueAt);
});

test('does not count graduated or infinity axes and forecasts independent review paths', () => {
  const plan = planCapacity(input({ words: [{
    id: 'w',
    R: axis({ learningComplete: true, dueAt: 'infinity', graduated: true }),
    P: axis({ score: 40, dueAt: '2026-12-20' }),
  }] }));
  expect(plan.conditionalReservations.filter(r => r.axis === 'R')).toHaveLength(0);
  expect(plan.conditionalReservations.filter(r => r.axis === 'P').map(r => r.reviewDate)).toEqual([
    '2026-12-21', '2026-12-24', '2026-12-31', '2027-01-30',
  ].filter(date => date <= plan.through));
});

test('derives an unfinished axis attainment date from score, dueAt, and available daily slots', () => {
  const plan = planCapacity(input({ maxTasksPerDay: 1, words: [{
    id: 'learn',
    R: axis({ score: 40, dueAt: '2026-12-20' }),
    P: axis({ graduated: true, dueAt: 'infinity' }),
  }] }));
  expect(plan.days[0]).toMatchObject({ confirmed: 1, proposed: 0 });
  expect(plan.days[1]).toMatchObject({ proposed: 1 });
  expect(plan.conditionalReservations[0]).toMatchObject({ anchorDate: '2026-12-21', reviewDate: '2026-12-22' });
});

test('maps P3 bands to the explicit P4 first-day demand policy', () => {
  expect(FIRST_DAY_TASK_DEMAND).toEqual({ common: 3, known: 5, less_common: 7, unknown: 9 });
  for (const band of ['common', 'known', 'less_common', 'unknown'] as const) {
    const plan = estimateNewWordCapacity({ ...input(), candidates: [{ id: band, band, targets: { R: 80, P: 80 }, materialAvailable: true, cooldownReady: true, timeAvailable: true }] }).plan;
    expect(plan.days[0].proposed).toBe(FIRST_DAY_TASK_DEMAND[band]);
  }
});

test('counts a shared ENCODE once while deriving both axes fastest learning paths', () => {
  const plan = planCapacity(input({ words: [{ id: 'new', R: axis({ dueAt: '2026-12-20' }), P: axis({ dueAt: '2026-12-20' }) }] }));
  expect(plan.days[0]).toMatchObject({ confirmed: 1, proposed: 8 });
});

test('distinguishes empty candidate pools and admits a stable prefix', () => {
  expect(estimateNewWordCapacity({ ...input(), candidates: [] })).toMatchObject({ maxNewWordsToday: 0, reason: 'no_candidates' });
  const result = estimateNewWordCapacity({ ...input({ maxTasksPerDay: 7 }), candidates: [
    { id: 'a', band: 'common', targets: { R: 80, P: 80 }, materialAvailable: true, cooldownReady: true, timeAvailable: true },
    { id: 'b', band: 'known', targets: { R: 80, P: 80 }, materialAvailable: true, cooldownReady: true, timeAvailable: true },
  ] });
  expect(result).toMatchObject({ maxNewWordsToday: 1, admittedWordIds: ['a'], blockedWordId: 'b', blockingDate: '2026-12-20', reason: 'capacity_reached' });
  expect(result.plan.days[0].proposed).toBe(3);
});

test('simulates current learning tasks before deciding whether a new word fits today', () => {
  const currentStudy = [
    {
      id: 'in-progress-a',
      R: axis({ score: 40, dueAt: '2026-12-20' }),
      P: axis({ graduated: true, dueAt: 'infinity' }),
    },
    {
      id: 'in-progress-b',
      R: axis({ score: 20, dueAt: '2026-12-20' }),
      P: axis({ graduated: true, dueAt: 'infinity' }),
    },
  ];
  const candidate = { id: 'candidate', band: 'common' as const, targets: { R: 80, P: 80 }, materialAvailable: true, cooldownReady: true, timeAvailable: true };

  // 两个当前词今天合计需要 5 个任务：各 1 个 confirmed，另外分别预计 1 个和 2 个学习任务；候选词还需要 3 个。
  const blocked = estimateNewWordCapacity({ ...input({ maxTasksPerDay: 7, words: currentStudy }), candidates: [candidate] });
  expect(blocked).toMatchObject({ maxNewWordsToday: 0, blockedWordId: 'candidate', blockingDate: '2026-12-20', reason: 'capacity_reached' });
  expect(blocked.plan.days[0]).toMatchObject({ confirmed: 2, proposed: 3, remaining: 2 });

  // 容量提高到 8 后，先保留两个当前词的 5 个任务，再准入候选词的 3 个任务，刚好用满。
  const admitted = estimateNewWordCapacity({ ...input({ maxTasksPerDay: 8, words: currentStudy }), candidates: [candidate] });
  expect(admitted).toMatchObject({ maxNewWordsToday: 1, admittedWordIds: ['candidate'], reason: null });
  expect(admitted.plan.days[0]).toMatchObject({ confirmed: 2, proposed: 6, remaining: 0 });
});

test('reports candidate ineligibility and future bottlenecks', () => {
  const unavailable = estimateNewWordCapacity({ ...input(), candidates: [{ id: 'x', band: 'common', targets: { R: 80, P: 80 }, materialAvailable: false, cooldownReady: true, timeAvailable: true }] });
  expect(unavailable).toMatchObject({ blockedWordId: 'x', blockingDate: '2026-12-20', reason: 'candidate_unavailable' });
  const bottleneck = estimateNewWordCapacity({ ...input({ maxTasksPerDay: { '2026-12-20': 10, '2026-12-21': 0 } }), candidates: [{
    id: 'x', band: 'common', targets: { R: 80, P: 80 }, materialAvailable: true, cooldownReady: true, timeAvailable: true,
  }] });
  expect(bottleneck).toMatchObject({ maxNewWordsToday: 0, blockingDate: '2026-12-21', reason: 'capacity_reached' });
});

test('admits today only if future reviews also fit around current words due that day', () => {
  const futureReviewWords = ['current-a', 'current-b'].map(id => ({
    id,
    R: axis({ score: 80, learningComplete: true, fluencyPass: true, reviewLevel: 30, dueAt: '2026-12-21' }),
    P: axis({ graduated: true, dueAt: 'infinity' }),
  }));
  const result = estimateNewWordCapacity({
    ...input({ maxTasksPerDay: { '2026-12-20': 10, '2026-12-21': 2 }, words: futureReviewWords }),
    candidates: [{ id: 'new-word', band: 'common', targets: { R: 80, P: 80 }, materialAvailable: true, cooldownReady: true, timeAvailable: true }],
  });

  // 今天的 3 个新词任务可以放下；但新词 R/P 的 +1 天复习会与两项已排复习叠加，造成未来超额。
  expect(result).toMatchObject({
    maxNewWordsToday: 0,
    blockedWordId: 'new-word',
    blockingDate: '2026-12-21',
    reason: 'capacity_reached',
  });
  expect(result.plan.days[0]).toMatchObject({ date: '2026-12-20', remaining: 10 });
  expect(result.plan.days[1]).toMatchObject({ date: '2026-12-21', confirmed: 2, remaining: 0 });
});

test('is deterministic and does not mutate caller input', () => {
  const data = { ...input(), candidates: [{ id: 'x', band: 'unknown' as const, targets: { R: 80, P: 80 }, materialAvailable: true, cooldownReady: true, timeAvailable: true }] };
  const before = structuredClone(data);
  expect(estimateNewWordCapacity(data)).toEqual(estimateNewWordCapacity(data));
  expect(data).toEqual(before);
});

test('records the capacity decision with band, demand, baseline, and reservations', () => {
  const inputWithCandidate = { ...input(), candidates: [{ id: 'new', band: 'known' as const, targets: { R: 80, P: 80 }, materialAvailable: true, cooldownReady: true, timeAvailable: true }] };
  const events: unknown[] = [];
  const event = recordNewWordCapacityEstimate(inputWithCandidate, value => events.push(value));
  expect(events).toHaveLength(1);
  expect(event.event).toBe('capacity.new_words_estimated');
  expect(event.candidates[0]).toMatchObject({ id: 'new', band: 'known', firstDayTaskDemand: 5 });
  expect(event.before[0]).toMatchObject({ date: '2026-12-20', capacity: 10 });
  expect(event.result).toMatchObject({ admittedWordIds: ['new'], maxNewWordsToday: 1 });
  expect(event.addedConditionalReservations[0]).toMatchObject({ wordId: 'new', axis: 'R', reviewDate: '2026-12-21' });
});

test('persists the P4 decision event to logs/app.log', async () => {
  const marker = `p4-persist-${Date.now()}`;
  const inputWithCandidate = { ...input(), candidates: [{ id: marker, band: 'common' as const, targets: { R: 80, P: 80 }, materialAvailable: true, cooldownReady: true, timeAvailable: true }] };
  const event = recordNewWordCapacityEstimate(inputWithCandidate);
  await new Promise<void>((resolve, reject) => appLogger.flush(error => error ? reject(error) : resolve()));
  const logPath = process.env.LOG_FILE ?? path.join(process.cwd(), 'logs', 'app.log');
  let persistedLine: string | undefined;
  for (let attempt = 0; attempt < 20 && !persistedLine; attempt++) {
    persistedLine = readFileSync(logPath, 'utf8').split('\n').find(line => line.includes(marker));
    if (!persistedLine) await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(persistedLine).toBeDefined();
  expect(JSON.parse(persistedLine!)).toMatchObject({ event: 'capacity.new_words_estimated', candidates: [{ id: marker }], result: { admittedWordIds: [marker] } });
  console.info(`P4 event persisted to ${logPath}`);
  expect(event.event).toBe('capacity.new_words_estimated');
});
