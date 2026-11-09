import { describe, expect, test } from '@jest/globals';
import { score, selectTask } from '../lib/scoring';

describe('pure unified P1 scoring interface', () => {
  test.each([[0, 'choice'], [20, 'cued'], [40, 'free'], [60, undefined]])('selects task at score %s', (value, stage) => {
    expect(selectTask(value).stage).toBe(stage);
  });
  test('ENCODE returns both updated scores and an event without mutating input', () => {
    const state = { R: 0, P: 0 };
    const result = score({ task: 'ENCODE', state, completed: true });
    expect(result.score).toEqual({ R: 5, P: 5 });
    expect(state).toEqual({ R: 0, P: 0 });
    expect(result.event).toMatchObject({ task: 'ENCODE', valid: true });
  });
  test.each([['choice', 'pass', 20], ['choice', 'fail', 5], ['cued', 'pass', 40], ['cued', 'fail', 5], ['free', 'pass', 60], ['free', 'fail', 20]] as const)('RETRIEVE %s %s gives %s', (stage, outcome, expected) => {
    expect(score({ task: 'RETRIEVE', axis: 'R', score: 25, stage, outcome }).score).toBe(expected);
  });
  test('invalid RETRIEVE preserves score', () => {
    expect(score({ task: 'RETRIEVE', axis: 'P', score: 25, stage: 'cued', outcome: 'invalid' })).toMatchObject({ score: 25, event: { valid: false, branch: 'invalid' } });
  });
  test.each([['R', 150, 60], ['R', 225, 80], ['R', 300, 100], ['P', 25, 60], ['P', 42.5, 80], ['P', 60, 100]] as const)('FLUENCY %s at %s WPM gives %s', (axis, speedWpm, expected) => {
    expect(score({ task: 'FLUENCY', axis, score: 75, targetPassed: true, overallPassed: true, speedWpm, timingValid: true }).score).toBeCloseTo(expected);
  });
  test('FLUENCY failure and invalidity follow P1 rules', () => {
    expect(score({ task: 'FLUENCY', axis: 'R', score: 77, targetPassed: false, overallPassed: true, speedWpm: 150, timingValid: true })).toMatchObject({ score: 40, event: { branch: 'target_failed' } });
    expect(score({ task: 'FLUENCY', axis: 'P', score: 73, targetPassed: false, overallPassed: false, speedWpm: 30, timingValid: false })).toMatchObject({ score: 73, event: { valid: false, branch: 'invalid' } });
  });
  test('pure function returns identical results for identical inputs', () => {
    const input = { task: 'FLUENCY' as const, axis: 'R' as const, score: 75, targetPassed: true, overallPassed: true, speedWpm: 225, timingValid: true };
    expect(score(input)).toEqual(score(input));
  });
});
