const {
  startAxisReview,
  settleAxisReview,
  projectIdealReviewDates,
  projectRemainingReviewDates,
} = require('../lib/new-algorithm-review');

const zone = 'America/Los_Angeles';
const asDate = (date, hour = 12) => Date.parse(`${date}T${String(hour).padStart(2, '0')}:00:00-08:00`);
const localDate = (iso, timeZone = zone) => new Intl.DateTimeFormat('en-CA', {
  timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(iso));
const base = {
  reviewLevel: null,
  dueAt: null,
  graduated: false,
  fluencyPass: false,
  learningComplete: false,
  score: 80,
  target: 80,
};

describe('independent review date and level transitions', () => {
  test('projects the ideal adjacent intervals through day 41', () => {
    expect(projectIdealReviewDates(asDate('2026-01-01'), zone).map(value => localDate(value))).toEqual([
      '2026-01-02', '2026-01-05', '2026-01-12', '2026-02-11',
    ]);
  });

  test('reprojects only the remaining ideal dates from the current axis level', () => {
    const initialDue = projectIdealReviewDates(asDate('2026-01-01'), zone)[0];
    expect(projectRemainingReviewDates(initialDue, 1, zone).map(value => localDate(value))).toEqual([
      '2026-01-02', '2026-01-05', '2026-01-12', '2026-02-11',
    ]);
    const levelSevenDue = projectIdealReviewDates(asDate('2026-01-01'), zone)[2];
    expect(projectRemainingReviewDates(levelSevenDue, 7, zone).map(value => localDate(value))).toEqual([
      '2026-01-12', '2026-02-11',
    ]);
  });

  test('a passing target fluency starts at level 1 and four passes graduate the axis', () => {
    let state = startAxisReview(base, { completedAt: asDate('2026-01-01'), timeZone: zone });
    expect(state.reviewLevel).toBe(1);
    expect(localDate(state.dueAt)).toBe('2026-01-02');
    for (const [date, level, nextDate] of [['2026-01-02', 3, '2026-01-05'], ['2026-01-05', 7, '2026-01-12'], ['2026-01-12', 30, '2026-02-11']]) {
      state = settleAxisReview(state, { completedAt: asDate(date), timeZone: zone, result: 'passed', scoreAfter: 82 });
      expect(state.reviewLevel).toBe(level);
      expect(localDate(state.dueAt)).toBe(nextDate);
    }
    state = settleAxisReview(state, { completedAt: asDate('2026-02-11'), timeZone: zone, result: 'passed', scoreAfter: 82 });
    expect(state.graduated).toBe(true);
    expect(state.dueAt).toBeNull();
  });

  test('valid no-score-drop failure demotes from actual settlement local day', () => {
    const state = { ...base, reviewLevel: 7, dueAt: '2026-01-10T08:00:00.000Z', fluencyPass: true, learningComplete: true };
    const after = settleAxisReview(state, { completedAt: asDate('2026-01-12'), timeZone: zone, result: 'failed', scoreAfter: 80 });
    expect(after).toMatchObject({ reviewLevel: 3, score: 80, fluencyPass: true, learningComplete: true, graduated: false });
    expect(localDate(after.dueAt)).toBe('2026-01-15');
  });

  test('a score below target returns to same-day learning and clears pass evidence', () => {
    const state = { ...base, reviewLevel: 30, dueAt: '2026-01-05T08:00:00.000Z', fluencyPass: true, learningComplete: true };
    const after = settleAxisReview(state, { completedAt: asDate('2026-01-12'), timeZone: zone, result: 'failed', scoreAfter: 40 });
    expect(after).toMatchObject({ reviewLevel: 7, score: 40, fluencyPass: false, learningComplete: false, graduated: false });
    expect(localDate(after.dueAt)).toBe('2026-01-12');
  });

  test('overdue success schedules from actual completion day, not old due date', () => {
    const state = { ...base, reviewLevel: 3, dueAt: '2026-01-05T08:00:00.000Z', fluencyPass: true, learningComplete: true };
    const after = settleAxisReview(state, { completedAt: asDate('2026-01-12'), timeZone: zone, result: 'passed', scoreAfter: 85 });
    expect(after.reviewLevel).toBe(7);
    expect(localDate(after.dueAt)).toBe('2026-01-19');
  });

  test('uses local calendar days across the spring DST boundary', () => {
    const dates = projectIdealReviewDates(Date.parse('2026-03-06T20:00:00Z'), zone);
    expect(dates.map(value => localDate(value))).toEqual(['2026-03-07', '2026-03-10', '2026-03-17', '2026-04-16']);
    expect(Date.parse(dates[1]) - Date.parse(dates[0])).toBe(71 * 60 * 60 * 1000);
  });

  test('settling R has no reference to or effect on P state', () => {
    const r = { ...base, reviewLevel: 1, dueAt: '2026-01-02T08:00:00.000Z' };
    const p = { ...base, reviewLevel: 7, dueAt: '2026-01-12T08:00:00.000Z', score: 65 };
    const beforeP = { ...p };
    const afterR = settleAxisReview(r, { completedAt: asDate('2026-01-02'), timeZone: zone, result: 'passed', scoreAfter: 85 });
    expect(afterR.reviewLevel).toBe(3);
    expect(p).toEqual(beforeP);
  });

  test('invalid result is a full state no-op', () => {
    const state = { ...base, reviewLevel: 3, dueAt: '2026-01-05T08:00:00.000Z' };
    expect(settleAxisReview(state, { completedAt: asDate('2026-01-12'), timeZone: zone, result: 'invalid', scoreAfter: 0 })).toEqual(state);
  });
});
