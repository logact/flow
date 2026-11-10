import { expect, test } from '@jest/globals';
import { createGoals, updateGoals, type GoalWordState } from '../lib/goals';
import { score } from '../lib/scoring';
import type { Axis } from '../lib/scoring';
import type { AxisSchedule } from '../lib/schedule';

const axis = (overrides: Partial<AxisSchedule> = {}): AxisSchedule => ({
  score: 85, target: 80, learningComplete: true, fluencyPass: true,
  reviewLevel: 3, graduated: false, dueAt: '2026-11-12', ...overrides,
});
const word = (R: AxisSchedule = axis(), P: AxisSchedule = axis()): GoalWordState => ({ R, P });
const settleAt = (axisName: Axis, wpm: number) => score({
  task: 'FLUENCY', axis: axisName, score: 80, targetPassed: true, overallPassed: true,
  speedWpm: wpm, timingValid: true, materialValid: true,
}, () => {}).score as number;

test('creates default goals and allows separate targets', () => {
  expect(createGoals()).toEqual({ R: 80, P: 80 });
  expect(createGoals({ R: 70, P: 90 })).toEqual({ R: 70, P: 90 });
});

test.each([{ R: 59, P: 80 }, { R: 101, P: 80 }, { R: 80.5, P: 80 }])('rejects invalid targets: %o', goals => {
  expect(() => createGoals(goals)).toThrow(RangeError);
});

test('raising target from 80 to 90 keeps score 85 and requeues learning today, using the matching R/P WPM', () => {
  expect(settleAt('R', 243.75)).toBeCloseTo(85);
  expect(settleAt('P', 46.875)).toBeCloseTo(85);
  const result = updateGoals({ current: { R: 80, P: 80 }, next: { R: 90, P: 90 }, words: [{ id: 'w1', state: word() }], date: '2026-11-10', logger: () => {} });
  expect(result.words[0].state.R).toMatchObject({ score: 85, target: 90, learningComplete: false, fluencyPass: false, dueAt: '2026-11-10' });
  expect(result.words[0].state.P).toMatchObject({ score: 85, target: 90, learningComplete: false, fluencyPass: false, dueAt: '2026-11-10' });
});

test('a score meeting the new goal completes learning only with a fluency pass', () => {
  expect(settleAt('R', 262.5)).toBeCloseTo(90);
  expect(settleAt('P', 51.25)).toBeCloseTo(90);
  const withEvidence = updateGoals({ current: { R: 80, P: 80 }, next: { R: 90, P: 90 }, words: [{ id: 'passed', state: word(axis({ score: 90 }), axis({ score: 90 })) }], date: '2026-11-10', logger: () => {} });
  expect(withEvidence.words[0].state.R.learningComplete).toBe(true);
  const withoutEvidence = updateGoals({ current: { R: 80, P: 80 }, next: { R: 70, P: 70 }, words: [{ id: 'no-pass', state: word(axis({ score: 90, fluencyPass: false }), axis({ score: 90, fluencyPass: false })) }], date: '2026-11-10', logger: () => {} });
  expect(withoutEvidence.words[0].state.R).toMatchObject({ learningComplete: false, fluencyPass: false });
});

test('lowering goal preserves achieved fluency evidence and marks the axis complete', () => {
  expect(settleAt('R', 187.5)).toBeCloseTo(70);
  expect(settleAt('P', 33.75)).toBeCloseTo(70);
  const result = updateGoals({ current: { R: 80, P: 80 }, next: { R: 70, P: 70 }, words: [{ id: 'w1', state: word(axis({ score: 70 }), axis({ score: 70 })) }], date: '2026-11-10', logger: () => {} });
  expect(result.words[0].state.R).toMatchObject({ score: 70, target: 70, learningComplete: true, fluencyPass: true });
});

test('raising goal above a graduated score revokes graduation and schedules today', () => {
  const graduated = axis({ score: 85, graduated: true, dueAt: 'infinity' });
  const result = updateGoals({ current: { R: 80, P: 80 }, next: { R: 90, P: 80 }, words: [{ id: 'w1', state: word(graduated) }], date: '2026-11-10', logger: () => {} });
  expect(result.words[0].state.R).toMatchObject({ graduated: false, learningComplete: false, fluencyPass: false, dueAt: '2026-11-10' });
  expect(result.words[0].state.P).toEqual(axis());
});

test('changing no target leaves schedules alone and emits an audit event', () => {
  const original = word();
  const result = updateGoals({ current: { R: 80, P: 80 }, next: { R: 80, P: 80 }, words: [{ id: 'w1', state: original }], date: '2026-11-10', logger: () => {} });
  expect(result.words[0].state).toEqual(original);
  expect(result.event).toMatchObject({ event: 'goal.updated', reason: 'created', before: { R: 80, P: 80 }, after: { R: 80, P: 80 }, words: [{ id: 'w1', changedAxes: [] }] });
});
