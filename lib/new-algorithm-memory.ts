/** Pure memory and cooldown rules from docs/algorithm.md. Times are milliseconds. */
export function memoryRetention(now: number, lastAxisAt: number | null, halfLifeMs: number): number | null {
  if (!Number.isFinite(halfLifeMs) || halfLifeMs <= 0) throw new RangeError('half-life must be positive');
  if (lastAxisAt === null) return null;
  if (!Number.isFinite(now) || !Number.isFinite(lastAxisAt) || now < lastAxisAt) throw new RangeError('invalid axis time');
  return 0.5 ** ((now - lastAxisAt) / halfLifeMs);
}

export function sharedCooldown(now: number, lastAnyAt: number | null, tick: number, lastAnyTick: number | null): number | null {
  if (lastAnyAt === null && lastAnyTick === null) return null;
  if (lastAnyAt === null || lastAnyTick === null) throw new RangeError('shared cooldown anchors must occur together');
  if (!Number.isFinite(now) || !Number.isFinite(lastAnyAt) || now < lastAnyAt ||
      !Number.isSafeInteger(tick) || !Number.isSafeInteger(lastAnyTick) || tick < lastAnyTick) {
    throw new RangeError('invalid shared cooldown anchors');
  }
  return Math.min(0.5 ** ((tick - lastAnyTick) / 7), 0.5 ** ((now - lastAnyAt) / 1_200_000));
}

export type MemoryGate = 'emergency' | 'ordinary' | 'waiting';

/** Candidate gate only; material availability and scheduler priority are separate. */
export function memoryGate(input: {
  introduced: boolean;
  observed: boolean;
  retention: number | null;
  cooldown: number | null;
  hasDemand: boolean;
}): MemoryGate {
  const { introduced, observed, retention, cooldown, hasDemand } = input;
  if (!introduced) return 'waiting';
  if (observed && retention !== null && retention < 0.2) return 'emergency';
  if (hasDemand && (retention === null || retention <= 0.9) && (cooldown === null || cooldown <= 0.5)) return 'ordinary';
  return 'waiting';
}
