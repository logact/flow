import { logger as appLogger } from './logger';
import type { Axis } from './scoring';
import type { WordSchedule } from './schedule';

export const DEFAULT_GOAL = 80;
export const MIN_GOAL = 60;
export const MAX_GOAL = 100;

/** User-owned targets. Targets are independent from a word's observed scores. */
export interface GoalSet {
  R: number;
  P: number;
}

export interface GoalWordState extends WordSchedule {}

export interface GoalUpdateEvent {
  event: 'goal.updated';
  reason: 'created' | 'target_changed';
  before: GoalSet | null;
  after: GoalSet;
  words: Array<{ id: string; before: GoalWordState; after: GoalWordState; changedAxes: Axis[] }>;
}

export type GoalLogger = (event: GoalUpdateEvent) => void;
const defaultLogger: GoalLogger = event => appLogger.info(event, 'Learning goals updated');

export function createGoals(input: Partial<GoalSet> = {}): GoalSet {
  const goals = { R: input.R ?? DEFAULT_GOAL, P: input.P ?? DEFAULT_GOAL };
  validateGoals(goals);
  return goals;
}

/**
 * Change personal targets and reconcile each supplied word's completion state.
 * Scores are evidence and are never rewritten by a goal change. An axis that no
 * longer meets its goal returns to same-day learning; a newly met goal only
 * completes learning when a valid fluency pass already exists.
 */
export function updateGoals(input: {
  current: GoalSet;
  next: GoalSet;
  words?: Array<{ id: string; state: GoalWordState }>;
  date: string;
  logger?: GoalLogger;
}): { goals: GoalSet; words: Array<{ id: string; state: GoalWordState }>; event: GoalUpdateEvent } {
  validateGoals(input.current);
  validateGoals(input.next);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new RangeError('date must be an ISO local date');
  const goals = { ...input.next };
  const updated = (input.words ?? []).map(({ id, state }) => {
    const before = cloneState(state);
    const after = cloneState(state);
    const changedAxes: Axis[] = [];
    (['R', 'P'] as const).forEach(axis => {
      const target = goals[axis];
      const oldTarget = input.current[axis];
      const s = after[axis];
      s.target = target;
      if (target === oldTarget) return;
      changedAxes.push(axis);
      if (s.graduated && s.score < target) {
        s.graduated = false;
        s.learningComplete = false;
        s.fluencyPass = false;
        s.dueAt = input.date;
      } else if (s.score < target) {
        s.learningComplete = false;
        s.fluencyPass = false;
        s.dueAt = input.date;
      } else if (!s.fluencyPass) {
        s.learningComplete = false;
        if (s.dueAt === 'infinity') s.dueAt = input.date;
      } else {
        s.learningComplete = true;
      }
    });
    return { id, state: after, audit: { id, before, after: cloneState(after), changedAxes } };
  });
  const event: GoalUpdateEvent = {
    event: 'goal.updated', reason: input.current.R === goals.R && input.current.P === goals.P ? 'created' : 'target_changed',
    before: { ...input.current }, after: goals, words: updated.map(item => item.audit),
  };
  (input.logger ?? defaultLogger)(event);
  return { goals, words: updated.map(({ id, state }) => ({ id, state })), event };
}

function validateGoals(goals: GoalSet): void {
  for (const axis of ['R', 'P'] as const) {
    if (!Number.isInteger(goals?.[axis]) || goals[axis] < MIN_GOAL || goals[axis] > MAX_GOAL) {
      throw new RangeError(`goal ${axis} must be an integer from ${MIN_GOAL} to ${MAX_GOAL}`);
    }
  }
}

function cloneState(state: GoalWordState): GoalWordState {
  return { R: { ...state.R }, P: { ...state.P } };
}
