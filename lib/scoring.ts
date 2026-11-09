export type Axis = 'R' | 'P';
export type RetrieveStage = 'choice' | 'cued' | 'free';
export type TaskType = 'ENCODE' | 'RETRIEVE' | 'FLUENCY';
export type Outcome = 'pass' | 'fail' | 'invalid';

export interface ScoreState { R: number; P: number }
export interface ScoreEvent {
  task: TaskType; axis: Axis | 'both'; stage?: RetrieveStage;
  before: Partial<ScoreState>; result: unknown; speedWpm?: number;
  speedValid?: boolean; branch: string; calculated?: number;
  after: Partial<ScoreState>; valid: boolean;
}
export type EventLogger = (event: ScoreEvent) => void;
import { logger as appLogger } from './logger';
const defaultEventLogger: EventLogger = event => appLogger.info({ event: 'score.update', ...event }, 'Score updated');

export function selectTask(score: number, encodePending = false): { task: TaskType; stage?: RetrieveStage } {
  if (encodePending) return { task: 'ENCODE' };
  if (score < 20) return { task: 'RETRIEVE', stage: 'choice' };
  if (score < 40) return { task: 'RETRIEVE', stage: 'cued' };
  if (score < 60) return { task: 'RETRIEVE', stage: 'free' };
  return { task: 'FLUENCY' };
}

export function scoreEncode(state: ScoreState, completed: boolean, logger: EventLogger = defaultEventLogger): ScoreState {
  const after = completed ? { R: Math.max(5, state.R), P: Math.max(5, state.P) } : { ...state };
  logger?.({ task: 'ENCODE', axis: 'both', before: { ...state }, result: completed, branch: completed ? 'completed' : 'incomplete', after, valid: true });
  return after;
}

const retrieveScores: Record<RetrieveStage, { pass: number; fail: number }> = {
  choice: { pass: 20, fail: 5 }, cued: { pass: 40, fail: 5 }, free: { pass: 60, fail: 20 },
};
export function scoreRetrieve(score: number, stage: RetrieveStage, outcome: Outcome, axis: Axis, logger: EventLogger = defaultEventLogger): number {
  const valid = outcome !== 'invalid';
  const after = valid ? retrieveScores[stage][outcome] : score;
  logger?.({ task: 'RETRIEVE', axis, stage, before: { [axis]: score }, result: outcome, branch: valid ? `${stage}_${outcome}` : 'invalid', calculated: after, after: { [axis]: after }, valid });
  return after;
}

export function scoreFluency(input: { axis: Axis; score: number; targetPassed: boolean; overallPassed: boolean; speedWpm: number; timingValid: boolean; materialValid?: boolean; interrupted?: boolean }, logger: EventLogger = defaultEventLogger): number {
  const { axis, score, targetPassed, overallPassed, speedWpm } = input;
  const valid = input.timingValid && input.materialValid !== false && !input.interrupted && Number.isFinite(speedWpm) && speedWpm > 0;
  let after = score, branch = 'invalid', calculated: number | undefined;
  if (valid) {
    const threshold = axis === 'R' ? 150 : 25;
    if (!targetPassed) { after = 40; branch = 'target_failed'; }
    else if (!overallPassed) branch = 'overall_failed';
    else if (speedWpm < threshold) { after = 40; branch = 'below_threshold'; }
    else {
      calculated = axis === 'R' ? Math.min(100, 60 + (speedWpm - 150) / 3.75) : Math.min(100, 60 + (speedWpm - 25) * 40 / 35);
      after = calculated; branch = 'speed_formula';
    }
  }
  logger?.({ task: 'FLUENCY', axis, before: { [axis]: score }, result: { targetPassed, overallPassed }, speedWpm, speedValid: valid, branch, calculated, after: { [axis]: after }, valid });
  return after;
}
