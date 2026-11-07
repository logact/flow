/** Pure score rules from docs/algorithm.md. No memory or persistence side effects. */
export type Axis = 'r' | 'p';
export type Stage = 'encode' | 'choice' | 'cued' | 'free' | 'fluency';

export function stageForScore(score: number): Stage {
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new RangeError('score must be in [0, 100]');
  if (score < 20) return 'choice';
  if (score < 40) return 'cued';
  if (score < 60) return 'free';
  return 'fluency';
}

export function needsConnection(scoreR: number, scoreP: number, introduced: boolean): boolean {
  validateScore(scoreR);
  validateScore(scoreP);
  return !introduced && scoreR === 0 && scoreP === 0;
}

function validateScore(score: number): void {
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new RangeError('score must be in [0, 100]');
}

export type ConnectionOutcome = { scoreR: number; scoreP: number; tickDelta: 0 | 1 };

/** The one word-level connection initializes a double-zero word once. */
export function connectionScores(scoreR: number, scoreP: number, completed: boolean): ConnectionOutcome {
  validateScore(scoreR);
  validateScore(scoreP);
  if (!completed) return { scoreR, scoreP, tickDelta: 0 };
  if (scoreR !== 0 || scoreP !== 0) throw new Error('Connection is valid only before a double-zero word is introduced');
  return { scoreR: Math.max(scoreR, 5), scoreP: Math.max(scoreP, 5), tickDelta: 1 };
}

export function retrievalScore(stage: 'choice' | 'cued' | 'free', passed: boolean): number {
  if (stage === 'choice') return passed ? 20 : 5;
  if (stage === 'cued') return passed ? 40 : 5;
  return passed ? 60 : 20;
}

export type FluencyResult =
  | { kind: 'invalid' | 'uncertain' | 'service_error' }
  | { kind: 'valid'; targetPassed: boolean; overallPassed: boolean; wpm: number };

export type ScoreOutcome =
  | { kind: 'no_change'; reason: 'invalid' | 'uncertain' | 'service_error' | 'overall_failed'; score: number }
  | { kind: 'scored'; reason: 'target_failed' | 'slow' | 'fluent'; score: number };

export function fluencyScore(axis: Axis, before: number, result: FluencyResult): ScoreOutcome {
  if (!Number.isFinite(before) || before < 0 || before > 100) throw new RangeError('before must be in [0, 100]');
  if (result.kind !== 'valid') return { kind: 'no_change', reason: result.kind, score: before };
  if (!Number.isFinite(result.wpm) || result.wpm < 0) throw new RangeError('wpm must be finite and nonnegative');
  if (!result.targetPassed) return { kind: 'scored', reason: 'target_failed', score: 40 };
  if (!result.overallPassed) return { kind: 'no_change', reason: 'overall_failed', score: before };
  const threshold = axis === 'r' ? 150 : 25;
  if (result.wpm < threshold) return { kind: 'scored', reason: 'slow', score: 40 };
  const score = axis === 'r'
    ? Math.min(100, 60 + (result.wpm - 150) / 3.75)
    : Math.min(100, 60 + (result.wpm - 25) * 40 / 35);
  return { kind: 'scored', reason: 'fluent', score };
}
