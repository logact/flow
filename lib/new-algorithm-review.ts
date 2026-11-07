export type ReviewLevel = 1 | 3 | 7 | 30;
export type ReviewAxisState = {
  reviewLevel: ReviewLevel | null;
  dueAt: string | null;
  graduated: boolean;
  fluencyPass: boolean;
  learningComplete: boolean;
  score: number;
  target: number;
};

export type ReviewSettlement = 'invalid' | 'passed' | 'failed';

const NEXT_LEVEL: Record<ReviewLevel, ReviewLevel | null> = { 1: 3, 3: 7, 7: 30, 30: null };
const DEMOTED_LEVEL: Record<ReviewLevel, ReviewLevel> = { 1: 1, 3: 1, 7: 3, 30: 7 };

function dateParts(timestamp: number, timeZone: string): [number, number, number] {
  if (!Number.isFinite(timestamp)) throw new RangeError('timestamp must be finite');
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(timestamp);
  const read = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return [read('year'), read('month'), read('day')];
}

function localDateString(timestamp: number, timeZone: string): string {
  const [year, month, day] = dateParts(timestamp, timeZone);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addCalendarDays(localDate: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match || !Number.isInteger(days)) throw new RangeError('invalid local date or day interval');
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function partsAt(timestamp: number, timeZone: string): [number, number, number, number, number, number] {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp);
  const read = (type: string) => Number(parts.find(part => part.type === type)?.value);
  return [read('year'), read('month'), read('day'), read('hour'), read('minute'), read('second')];
}

/** Convert a local calendar midnight to an instant, allowing DST offsets to vary by date. */
function localMidnightUtc(localDate: string, timeZone: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new RangeError('invalid local date');
  // Let Intl validate the IANA zone.
  new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  const wanted = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  let candidate = wanted;
  for (let i = 0; i < 4; i++) {
    const [year, month, day, hour, minute, second] = partsAt(candidate, timeZone);
    const observed = Date.UTC(year, month - 1, day, hour, minute, second);
    const delta = wanted - observed;
    candidate += delta;
    if (delta === 0) break;
  }
  if (localDateString(candidate, timeZone) !== localDate) throw new RangeError('local midnight is not representable');
  return candidate;
}

function dueAtForLocalDate(localDate: string, timeZone: string): string {
  return new Date(localMidnightUtc(localDate, timeZone)).toISOString();
}

/** Local midnight for a timestamp's user-local calendar day. */
export function localDayStart(timestamp: number, timeZone: string): string {
  return dueAtForLocalDate(localDateString(timestamp,timeZone),timeZone);
}

export function localCalendarDate(timestamp: number, timeZone: string): string {
  return localDateString(timestamp, timeZone);
}

/** Rebuild the due date and future ideal-path dates from the currently scheduled level. */
export function projectRemainingReviewDates(dueAt: string, level: ReviewLevel, timeZone: string): string[] {
  if (!Number.isFinite(Date.parse(dueAt))) throw new RangeError('invalid dueAt');
  let date = localDateString(Date.parse(dueAt), timeZone);
  const result = [dueAt];
  let current: ReviewLevel | null = NEXT_LEVEL[level];
  while (current !== null) {
    date = addCalendarDays(date, current);
    result.push(dueAtForLocalDate(date, timeZone));
    current = NEXT_LEVEL[current];
  }
  return result;
}

function validateState(state: ReviewAxisState): void {
  if (!Number.isFinite(state.score) || state.score < 0 || state.score > 100) throw new RangeError('score must be in [0, 100]');
  if (!Number.isFinite(state.target) || state.target < 60 || state.target > 100) throw new RangeError('target must be in [60, 100]');
  if (state.reviewLevel !== null && ![1, 3, 7, 30].includes(state.reviewLevel)) throw new RangeError('invalid review level');
}

/** First valid, target-meeting FLUENCY pass starts this axis at its 1-day review. */
export function startAxisReview(state: ReviewAxisState, input: { completedAt: number; timeZone: string }): ReviewAxisState {
  validateState(state);
  if (state.score < state.target) throw new Error('axis score is below target');
  const localDate = localDateString(input.completedAt, input.timeZone);
  return {
    ...state,
    reviewLevel: 1,
    dueAt: dueAtForLocalDate(addCalendarDays(localDate, 1), input.timeZone),
    graduated: false,
    fluencyPass: true,
    learningComplete: true,
  };
}

/** Apply one valid review result. Invalid/uncertain outcomes are handled as no-op by callers. */
export function settleAxisReview(
  state: ReviewAxisState,
  input: { completedAt: number; timeZone: string; result: ReviewSettlement; scoreAfter: number },
): ReviewAxisState {
  validateState(state);
  if (!Number.isFinite(input.scoreAfter) || input.scoreAfter < 0 || input.scoreAfter > 100) throw new RangeError('scoreAfter must be in [0, 100]');
  if (input.result === 'invalid') return { ...state };
  if (state.graduated || state.reviewLevel === null) throw new Error('axis is not in review');
  const localDate = localDateString(input.completedAt, input.timeZone);

  if (input.result === 'passed') {
    if (input.scoreAfter < state.target) throw new Error('a passing review must meet the current target');
    const next = NEXT_LEVEL[state.reviewLevel];
    if (next === null) {
      return { ...state, score: input.scoreAfter, reviewLevel: 30, dueAt: null, graduated: true, fluencyPass: true, learningComplete: true };
    }
    return {
      ...state,
      score: input.scoreAfter,
      reviewLevel: next,
      dueAt: dueAtForLocalDate(addCalendarDays(localDate, next), input.timeZone),
      graduated: false,
      fluencyPass: true,
      learningComplete: true,
    };
  }

  const demoted = DEMOTED_LEVEL[state.reviewLevel];
  if (input.scoreAfter < state.target) {
    return {
      ...state,
      score: input.scoreAfter,
      reviewLevel: demoted,
      dueAt: dueAtForLocalDate(localDate, input.timeZone),
      graduated: false,
      fluencyPass: false,
      learningComplete: false,
    };
  }
  return {
    ...state,
    score: input.scoreAfter,
    reviewLevel: demoted,
    dueAt: dueAtForLocalDate(addCalendarDays(localDate, demoted), input.timeZone),
    graduated: false,
  };
}

/** Ideal-path projection: each review succeeds on its due local date, with no failures. */
export function projectIdealReviewDates(firstFluencyPassAt: number, timeZone: string): string[] {
  let localDate = localDateString(firstFluencyPassAt, timeZone);
  return [1, 3, 7, 30].map(interval => {
    localDate = addCalendarDays(localDate, interval);
    return dueAtForLocalDate(localDate, timeZone);
  });
}
