const { selectTask, scoreEncode, scoreRetrieve, scoreFluency } = require('../lib/scoring');

describe('P1 scoring rules', () => {
  test.each([[0, 'choice'], [19.99, 'choice'], [20, 'cued'], [39.99, 'cued'], [40, 'free'], [59.99, 'free'], [60, undefined], [100, undefined]])(
    'selects task at score %s', (score, stage) => {
      const selected = selectTask(score);
      expect(selected.task).toBe(stage ? 'RETRIEVE' : 'FLUENCY');
      expect(selected.stage).toBe(stage);
    },
  );
  test('ENCODE only selected when explicitly pending; completion raises both axes to at least 5', () => {
    expect(selectTask(0, true)).toEqual({ task: 'ENCODE' });
    const events = [];
    expect(scoreEncode({ R: 0, P: 0 }, true, e => events.push(e))).toEqual({ R: 5, P: 5 });
    expect(scoreEncode({ R: 0, P: 12 }, true)).toEqual({ R: 5, P: 12 });
    expect(scoreEncode({ R: 0, P: 0 }, false)).toEqual({ R: 0, P: 0 });
    expect(events[0]).toMatchObject({ task: 'ENCODE', axis: 'both', before: { R: 0, P: 0 }, after: { R: 5, P: 5 }, valid: true });
  });
  test.each([
    ['choice', 0, 'pass', 20], ['choice', 19, 'fail', 5],
    ['cued', 20, 'pass', 40], ['cued', 39, 'fail', 5],
    ['free', 40, 'pass', 60], ['free', 59, 'fail', 20],
  ])('RETRIEVE %s at %s, %s => %s', (stage, initial, outcome, expected) => {
    expect(scoreRetrieve(initial, stage, outcome, 'R')).toBe(expected);
  });
  test.each(['R', 'P'])('RETRIEVE independently updates %s and logs all decisions', axis => {
    const events = [];
    expect(scoreRetrieve(25, 'cued', 'pass', axis, e => events.push(e))).toBe(40);
    expect(events[0]).toMatchObject({ task: 'RETRIEVE', axis, stage: 'cued', before: { [axis]: 25 }, result: 'pass', branch: 'cued_pass', calculated: 40, after: { [axis]: 40 }, valid: true });
    expect(scoreRetrieve(25, 'cued', 'invalid', axis, e => events.push(e))).toBe(25);
    expect(events[1]).toMatchObject({ branch: 'invalid', valid: false, after: { [axis]: 25 } });
  });
  test.each([
    ['R', 150, 60], ['R', 225, 80], ['R', 300, 100], ['R', 200, 60 + 50 / 3.75],
    ['P', 25, 60], ['P', 42.5, 80], ['P', 60, 100], ['P', 40, 60 + 15 * 40 / 35],
  ])('%s fluency formula at %s wpm', (axis, speedWpm, expected) => {
    expect(scoreFluency({ axis, score: 75, targetPassed: true, overallPassed: true, speedWpm, timingValid: true })).toBeCloseTo(expected);
  });
  test.each([
    ['R', 149.99], ['P', 24.99],
  ])('%s below threshold sets 40', (axis, speedWpm) => {
    expect(scoreFluency({ axis, score: 82, targetPassed: true, overallPassed: true, speedWpm, timingValid: true })).toBe(40);
  });
  test.each(['R', 'P'])('%s covers all target/overall result combinations and logs branches', axis => {
    const threshold = axis === 'R' ? 150 : 25;
    const run = (targetPassed, overallPassed) => {
      const events = [];
      const result = scoreFluency({ axis, score: 77, targetPassed, overallPassed, speedWpm: threshold, timingValid: true }, e => events.push(e));
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ task: 'FLUENCY', axis, result: { targetPassed, overallPassed }, speedWpm: threshold, speedValid: true, after: { [axis]: result }, valid: true });
      return { result, branch: events[0].branch };
    };
    expect(run(true, true)).toEqual({ result: 60, branch: 'speed_formula' });
    expect(run(true, false)).toEqual({ result: 77, branch: 'overall_failed' });
    expect(run(false, true)).toEqual({ result: 40, branch: 'target_failed' });
    expect(run(false, false)).toEqual({ result: 40, branch: 'target_failed' });
  });
  test.each([
    { timingValid: false }, { timingValid: true, materialValid: false },
    { timingValid: true, interrupted: true }, { timingValid: true, speedWpm: 0 },
  ])('invalid fluency evidence preserves score and is logged: %j', overrides => {
    const events = [];
    const score = scoreFluency({ axis: 'P', score: 73, targetPassed: false, overallPassed: false, speedWpm: 30, timingValid: true, ...overrides }, e => events.push(e));
    expect(score).toBe(73);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ branch: 'invalid', valid: false, speedValid: false, after: { P: 73 } });
  });
});
