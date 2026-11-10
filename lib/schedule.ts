import { score, type Axis, type EventLogger } from './scoring';
import { logger as appLogger } from './logger';

export type ReviewLevel = 1 | 3 | 7 | 30;
export type DueAt = string | 'infinity';

export interface AxisSchedule {
  score: number;
  target: number;
  learningComplete: boolean;
  fluencyPass: boolean;
  reviewLevel: ReviewLevel;
  graduated: boolean;
  dueAt: DueAt;
}

export interface ScheduleEvent {
  event: 'schedule.updated'; axis: Axis; reason: string; outcome: string;
  date: string; before: AxisSchedule; after: AxisSchedule; attemptId?: string;
}

const LEVELS: ReviewLevel[] = [1, 3, 7, 30];
const FALLBACK: Record<ReviewLevel, ReviewLevel> = { 1: 1, 3: 1, 7: 3, 30: 7 };
const defaultScheduleLogger = (event: ScheduleEvent) => appLogger.info(event, 'Schedule updated');

/** Calendar arithmetic on ISO local-date values, independent of DST and UTC offset. */
export function addLocalDays(date: string, days: number): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isInteger(days)) throw new Error('Expected ISO local date and integer day count');
  const d = new Date(`${date}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface WordSchedule {
  R: AxisSchedule;
  P: AxisSchedule;
}
export interface FluencyTestResult {   
  axis: Axis; targetPassed: boolean; overallPassed: boolean; speedWpm: number;
  timingValid: boolean; materialValid?: boolean; interrupted?: boolean;
}
export interface ScheduleResult { word: WordSchedule; due: { R: boolean; P: boolean }; changedAxis: Axis }

/** Accepts a complete vocabulary state and one test result; returns the updated word and due status. */
export function schedule(input: {
  word: WordSchedule; result: FluencyTestResult; date: string;
  scoreLogger?: EventLogger; logger?: (event: ScheduleEvent) => void;
}): ScheduleResult {
  const { word, result, date } = input;
  const afterAxis = settleAxis({ ...result, state: word[result.axis], date, scoreLogger: input.scoreLogger, logger: input.logger });
  const afterWord = { ...word, [result.axis]: afterAxis };
  return { word: afterWord, due: { R: isDue(afterWord.R.dueAt, date), P: isDue(afterWord.P.dueAt, date) }, changedAxis: result.axis };
}

function settleAxis<T extends AxisSchedule>(input: FluencyTestResult & { state: T; date: string; scoreLogger?: EventLogger; logger?: (event: ScheduleEvent) => void }): T {
  const { axis, state, date } = input;
  if (!state.graduated && state.dueAt !== 'infinity' && date < state.dueAt) {
    (input.logger ?? defaultScheduleLogger)({ event: 'schedule.updated', axis, reason: 'not_due', outcome: 'unchanged', date, before: { ...state }, after: { ...state } });
    return { ...state };
  }
  const scored = score({ task: 'FLUENCY', axis, score: state.score, targetPassed: input.targetPassed, overallPassed: input.overallPassed, speedWpm: input.speedWpm, timingValid: input.timingValid, materialValid: input.materialValid, interrupted: input.interrupted }, input.scoreLogger);
  const newScore = scored.score as number;
  const valid = input.timingValid && input.materialValid !== false && !input.interrupted && Number.isFinite(input.speedWpm) && input.speedWpm > 0;
  if (!valid) {
    (input.logger ?? defaultScheduleLogger)({ event: 'schedule.updated', axis, reason: 'invalid_result', outcome: 'unchanged', date, before: { ...state }, after: { ...state } });
    return { ...state };
  }
  const before = { ...state };
  let after: T = { ...state, score: newScore };
  const passed = input.targetPassed && input.overallPassed && newScore >= state.target;
  if (state.graduated) {
    (input.logger ?? defaultScheduleLogger)({ event: 'schedule.updated', axis, reason: 'already_graduated', outcome: 'unchanged', date, before, after: { ...state } });
    return { ...state };
  }
  if (!state.learningComplete) {
    if (passed) {
      after.learningComplete = true; after.fluencyPass = true;
      after.dueAt = addLocalDays(date, state.reviewLevel);
    } else after.dueAt = date;
  } else if (passed) {
    const i = LEVELS.indexOf(state.reviewLevel);
    if (state.reviewLevel === 30) { after.graduated = true; after.dueAt = 'infinity'; }
    else { after.reviewLevel = LEVELS[i + 1]; after.dueAt = addLocalDays(date, LEVELS[i + 1]); }
  } else {
    after.reviewLevel = FALLBACK[state.reviewLevel];
    if (newScore < state.target) { after.learningComplete = false; after.fluencyPass = false; after.dueAt = date; }
    else after.dueAt = addLocalDays(date, after.reviewLevel);
  }
  (input.logger ?? defaultScheduleLogger)({ event: 'schedule.updated', axis, reason: state.learningComplete ? 'review_settlement' : 'learning_settlement', outcome: passed ? 'pass' : 'fail', date, before, after: { ...after } });
  return after;
}

function isDue(dueAt: DueAt, date: string): boolean { return dueAt !== 'infinity' && dueAt <= date; }

