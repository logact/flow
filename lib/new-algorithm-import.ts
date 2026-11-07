import type Database from 'better-sqlite3';

export type InitialScoreEstimate = {
  scoreR: 0 | 20 | 40 | 60;
  scoreP: 0 | 5 | 20 | 40;
  tier: 'common' | 'familiar' | 'uncommon' | 'unknown';
  requiresConnection: boolean;
};

/** Implements the V/rank table in algorithm.md; rank must be comparable with V. */
export function estimateInitialScores(vocabularySize?: number, rank?: number, comparable = true): InitialScoreEstimate {
  if (!comparable || !Number.isFinite(vocabularySize) || (vocabularySize ?? 0) <= 0 || !Number.isFinite(rank) || (rank ?? 0) <= 0) {
    return { scoreR: 0, scoreP: 0, tier: 'unknown', requiresConnection: true };
  }
  const v = vocabularySize as number;
  const r = rank as number;
  if (r <= 0.5 * v) return { scoreR: 60, scoreP: 40, tier: 'common', requiresConnection: false };
  if (r <= v) return { scoreR: 40, scoreP: 20, tier: 'familiar', requiresConnection: false };
  if (r <= 1.5 * v) return { scoreR: 20, scoreP: 5, tier: 'uncommon', requiresConnection: false };
  return { scoreR: 0, scoreP: 0, tier: 'unknown', requiresConnection: true };
}

export type NewWordInput = {
  term: string;
  confirmedMeaning?: string;
  targetR?: number;
  targetP?: number;
  vocabularySize?: number;
  rank?: number;
  rankComparable?: boolean;
  level?: 'A1'|'A2'|'B1'|'B2'|'C1'|'C2';
  freq?: number;
  freqSource?: string;
  timezone: string;
};

function finiteRange(value: number, min: number, max: number): boolean {
  return Number.isFinite(value) && value >= min && value <= max;
}

/**
 * Import into the isolated prototype schema. A caller must provide a capacity
 * reservation callback; O1 intentionally has no implicit capacity default.
 */
export function importNewAlgorithmWords(
  db: Database.Database,
  words: NewWordInput[],
  now: number,
  reserveCapacity: (estimates: InitialScoreEstimate[]) => boolean
): number[] {
  if (!Array.isArray(words) || !words.length || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid import batch');
  if (typeof reserveCapacity !== 'function') throw new Error('CAPACITY_GATE_PENDING: O1 must provide an explicit capacity reservation');
  const checked = words.map(input => {
    const term = input.term?.trim();
    const meaning = input.confirmedMeaning?.trim() ?? '';
    const targetR = input.targetR ?? 80, targetP = input.targetP ?? 80;
    const level = input.level ?? 'B1';
    const estimate = estimateInitialScores(input.vocabularySize, input.rank, input.rankComparable !== false);
    if (!term || term.length > 200 || meaning.length > 2000) throw new Error('Invalid term or meaning');
    if (!finiteRange(targetR,60,100) || !finiteRange(targetP,60,100)) throw new Error('Target must be 60–100');
    if (!input.timezone?.trim()) throw new Error('An explicit IANA timezone is required');
    if (!['A1','A2','B1','B2','C1','C2'].includes(level)) throw new Error('Invalid level');
    if (input.freq !== undefined && (!Number.isFinite(input.freq) || input.freq < 0 || !input.freqSource?.trim())) throw new Error('Frequency requires a source');
    if (input.freqSource && input.freq === undefined) throw new Error('Frequency source requires a value');
    return {term,meaning,targetR,targetP,scoreR:estimate.scoreR,scoreP:estimate.scoreP,introduced:estimate.requiresConnection?0:1,level,freq:input.freq ?? null,freqSource:input.freqSource?.trim() ?? null,timezone:input.timezone.trim(),estimate};
  });
  if (!reserveCapacity(checked.map(row => row.estimate))) throw new Error('CAPACITY_INSUFFICIENT');
  return db.transaction(() => {
    const dueNow = new Date(now).toISOString();
    const insert = db.prepare(`INSERT INTO words(term,meaning,target_r,target_p,score_r,score_p,introduced,due_at_r,due_at_p,level,freq,freq_source,local_timezone,created_at)
      VALUES(@term,@meaning,@targetR,@targetP,@scoreR,@scoreP,@introduced,@dueNow,@dueNow,@level,@freq,@freqSource,@timezone,@now)`);
    return checked.map(({estimate: _estimate, ...word}) => Number(insert.run({...word,dueNow,now}).lastInsertRowid));
  })();
}

/** Only an explicit confirmed edit makes a gloss available to future material jobs. */
export function confirmNewAlgorithmMeaning(db: Database.Database, wordId: number, meaning: string): number {
  const normalized = meaning?.trim();
  if (!normalized) throw new Error('Confirmed meaning is required');
  return db.transaction(() => {
    const row = db.prepare('SELECT meaning,meaning_version FROM words WHERE id=?').get(wordId) as {meaning:string;meaning_version:number}|undefined;
    if (!row) throw new Error('Unknown word');
    if (row.meaning === normalized) return row.meaning_version;
    const version = row.meaning_version + 1;
    db.prepare('UPDATE words SET meaning=?,meaning_version=? WHERE id=?').run(normalized,version,wordId);
    db.prepare("UPDATE materials SET status='invalidated' WHERE word_id=? AND meaning_version<>? AND status IN ('preparing','ready','failed')").run(wordId,version);
    return version;
  })();
}
