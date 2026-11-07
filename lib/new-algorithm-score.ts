/** Pure score rules from docs/algorithm.md. No memory or persistence side effects. */
export type Axis = 'r' | 'p';
export type Stage = 'encode' | 'choice' | 'cued' | 'free' | 'fluency';

export function stageForScore(score: number): Stage {
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new RangeError('score must be in [0, 100]');
  if (score === 0) return 'encode';
  if (score < 20) return 'choice';
  if (score < 40) return 'cued';
  if (score < 60) return 'free';
  return 'fluency';
}

export function retrievalScore(stage: 'choice' | 'cued' | 'free', passed: boolean): number {
  if (stage === 'choice') return passed ? 20 : 5;
  if (stage === 'cued') return passed ? 40 : 5;
  return passed ? 60 : 20;
}

/** D2 prototype parameter. Call only for a completed, evidenced target-word exposure. */
export function enhancedHalfLife(beforeMs: number): number {
  if (!Number.isFinite(beforeMs) || beforeMs <= 0) throw new RangeError('half-life must be positive');
  return beforeMs * 1.5;
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
