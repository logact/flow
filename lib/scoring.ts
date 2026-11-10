export type Axis = 'R' | 'P';
export type RetrieveStage = 'choice' | 'cued' | 'free';
export type TaskType = 'ENCODE' | 'RETRIEVE' | 'FLUENCY';
export type Outcome = 'pass' | 'fail' | 'invalid';
export interface ScoreState { R: number; P: number }
export interface ScoreEvent { task: TaskType; axis: Axis | 'both'; stage?: RetrieveStage; before: Partial<ScoreState>; result: unknown; speedWpm?: number; speedValid?: boolean; branch: string; calculated?: number; after: Partial<ScoreState>; valid: boolean; attemptId?: string }
export type EventLogger = (event: ScoreEvent) => void;
import { logger as appLogger } from './logger';
const defaultEventLogger: EventLogger = event => appLogger.info({ event: 'score.update', ...event }, 'Score updated');
export function selectTask(score: number): { task: TaskType; stage?: RetrieveStage } {
  if (score === 0) return { task: 'ENCODE' };
  if (score < 20) return { task: 'RETRIEVE', stage: 'choice' };
  if (score < 40) return { task: 'RETRIEVE', stage: 'cued' };
  if (score < 60) return { task: 'RETRIEVE', stage: 'free' };
  return { task: 'FLUENCY' };
}

type ScoreInput =
  | { task: 'ENCODE'; state: ScoreState; completed: boolean }
  | { task: 'RETRIEVE'; axis: Axis; score: number; stage: RetrieveStage; outcome: Outcome }
  | { task: 'FLUENCY'; axis: Axis; score: number; targetPassed: boolean; overallPassed: boolean; speedWpm: number; timingValid: boolean; materialValid?: boolean; interrupted?: boolean };
export interface ScoreResult { score: number | ScoreState; event: ScoreEvent }

/** Pure scoring boundary: returns the score and its audit event; performs no logging or I/O. */
export function score(input: ScoreInput, logger: EventLogger = defaultEventLogger): ScoreResult {
  let value: number | ScoreState;
  let event: ScoreEvent;
  if (input.task === 'ENCODE') {
    const after = input.completed ? { R: Math.max(5, input.state.R), P: Math.max(5, input.state.P) } : { ...input.state };
    value = after;
    event = { task: 'ENCODE', axis: 'both', before: { ...input.state }, result: input.completed, branch: input.completed ? 'completed' : 'incomplete', after, valid: true };
  } else if (input.task === 'RETRIEVE') {
    const valid = input.outcome !== 'invalid';
    const table = { choice: { pass: 20, fail: 5 }, cued: { pass: 40, fail: 5 }, free: { pass: 60, fail: 20 } } as const;
    const after = valid ? table[input.stage][input.outcome as 'pass' | 'fail'] : input.score;
    value = after;
    event = { task: 'RETRIEVE', axis: input.axis, stage: input.stage, before: { [input.axis]: input.score }, result: input.outcome, branch: valid ? `${input.stage}_${input.outcome}` : 'invalid', calculated: after, after: { [input.axis]: after }, valid };
  } else {
    const valid = input.timingValid && input.materialValid !== false && !input.interrupted && Number.isFinite(input.speedWpm) && input.speedWpm > 0;
    let after = input.score, branch = 'invalid', calculated: number | undefined;
    if (valid) {
      const threshold = input.axis === 'R' ? 150 : 25;
      if (!input.targetPassed) { after = 40; branch = 'target_failed'; }
      else if (!input.overallPassed) branch = 'overall_failed';
      else if (input.speedWpm < threshold) { after = 40; branch = 'below_threshold'; }
      else { calculated = input.axis === 'R' ? Math.min(100, 60 + (input.speedWpm - 150) / 3.75) : Math.min(100, 60 + (input.speedWpm - 25) * 40 / 35); after = calculated; branch = 'speed_formula'; }
    }
    value = after;
    event = { task: 'FLUENCY', axis: input.axis, before: { [input.axis]: input.score }, result: { targetPassed: input.targetPassed, overallPassed: input.overallPassed }, speedWpm: input.speedWpm, speedValid: valid, branch, calculated, after: { [input.axis]: after }, valid };
  }
  logger(event);
  return { score: value, event };
}
