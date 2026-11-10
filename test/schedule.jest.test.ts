import { expect, test } from '@jest/globals';
import { addLocalDays, schedule, type AxisSchedule, type WordSchedule } from '../lib/schedule';

const base = (overrides: Partial<AxisSchedule> = {}): AxisSchedule => ({ score: 80, target: 80, learningComplete: false, fluencyPass: false, reviewLevel: 1, graduated: false, dueAt: '2026-01-01', ...overrides });
const word = (R: AxisSchedule = base(), P: AxisSchedule = base()): WordSchedule => ({ R, P });
const run = (R: AxisSchedule, date = '2026-01-01', speedWpm = 244) => schedule({ word: word(R), date, result: { axis: 'R', targetPassed: true, overallPassed: true, speedWpm, timingValid: true } });

test('settlement returns full word state and due status; learning failure remains due today', () => {
  const result = schedule({ word: word(), date: '2026-11-09', result: { axis: 'R', targetPassed: true, overallPassed: true, speedWpm: 149, timingValid: true } });
  expect(result.word.R).toMatchObject({ score: 40, dueAt: '2026-11-09' });
  expect(result.due.R).toBe(true);
  expect(result.word.P).toEqual(base());
});

test('goal fluency starts first review one local day later', () => {
  expect(run(base(), '2026-11-09').word.R).toMatchObject({ learningComplete: true, reviewLevel: 1, dueAt: '2026-11-10' });
});

test.each([[1, 3], [3, 7], [7, 30]] as const)('successful level %i advances to %i day interval', (current, next) => {
  const result = run(base({ learningComplete: true, fluencyPass: true, reviewLevel: current }), '2026-11-09');
  expect(result.word.R).toMatchObject({ reviewLevel: next, dueAt: addLocalDays('2026-11-09', next) });
});

test.each([[1, 1], [3, 1], [7, 3], [30, 7]] as const)('failed review at %i falls back to %i and returns to today', (current, next) => {
  const result = schedule({ word: word(base({ learningComplete: true, fluencyPass: true, reviewLevel: current })), date: '2026-11-09', result: { axis: 'R', targetPassed: false, overallPassed: true, speedWpm: 150, timingValid: true } });
  expect(result.word.R).toMatchObject({ score: 40, reviewLevel: next, learningComplete: false, fluencyPass: false, dueAt: '2026-11-09' });
});

test('regression: recovery after a failed 30-day review keeps the fallback 7-day interval', () => {
  const failed = schedule({
    word: word(base({ learningComplete: true, fluencyPass: true, reviewLevel: 30, dueAt: '2026-11-09' })),
    date: '2026-11-09', result: { axis: 'R', targetPassed: false, overallPassed: true, speedWpm: 150, timingValid: true },
  }).word;
  expect(failed.R).toMatchObject({ reviewLevel: 7, learningComplete: false, dueAt: '2026-11-09' });

  const recovered = schedule({
    word: failed, date: '2026-11-09',
    result: { axis: 'R', targetPassed: true, overallPassed: true, speedWpm: 225, timingValid: true },
  }).word;
  expect(recovered.R).toMatchObject({ reviewLevel: 7, learningComplete: true, fluencyPass: true, dueAt: '2026-11-16' });
});

test('regression: a valid passing result before dueAt cannot graduate an axis', () => {
  const initial = word(base({ learningComplete: true, fluencyPass: true, reviewLevel: 30, dueAt: '2026-12-10' }));
  const result = schedule({
    word: initial, date: '2026-11-10',
    result: { axis: 'R', targetPassed: true, overallPassed: true, speedWpm: 225, timingValid: true },
  });
  expect(result.word).toEqual(initial);
  expect(result.word.R.graduated).toBe(false);
});

test('30-day pass graduates only target axis with infinity due date', () => {
  const result = run(base({ learningComplete: true, fluencyPass: true, reviewLevel: 30 }), '2026-11-09');
  expect(result.word.R).toMatchObject({ graduated: true, dueAt: 'infinity' });
  expect(result.word.P).toEqual(base());
  expect(result.due.R).toBe(false);
});

test('invalid result preserves word state and logs event', () => {
  const events: unknown[] = [];
  const initial = word(base({ learningComplete: true, reviewLevel: 7 }));
  const result = schedule({ word: initial, date: '2026-11-09', result: { axis: 'R', targetPassed: false, overallPassed: false, speedWpm: 0, timingValid: false }, logger: e => events.push(e) });
  expect(result.word).toEqual(initial);
  expect(events[0]).toMatchObject({ reason: 'invalid_result' });
});

test('date arithmetic handles month/year boundaries and reports overdue axes', () => {
  expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
  expect(addLocalDays('2027-02-27', 3)).toBe('2027-03-02');
  expect(schedule({ word: word(base({ dueAt: 'infinity' }), base({ dueAt: '2026-11-08' })), date: '2026-11-09', result: { axis: 'P', targetPassed: true, overallPassed: true, speedWpm: 30, timingValid: true } }).due.R).toBe(false);
});

test('score and schedule use the same P1 fluency scoring result', () => {
  const scoreEvents: any[] = [];
  const result = schedule({ word: word(base({ learningComplete: true, reviewLevel: 3 })), date: '2026-11-09', result: { axis: 'R', targetPassed: true, overallPassed: true, speedWpm: 225, timingValid: true }, scoreLogger: e => scoreEvents.push(e) });
  expect(scoreEvents[0].after.R).toBeCloseTo(80);
  expect(result.word.R).toMatchObject({ score: 80, reviewLevel: 7, dueAt: '2026-11-16' });
});
