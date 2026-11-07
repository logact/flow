import type Database from 'better-sqlite3';

export type NewWordInput = {
  term: string;
  confirmedMeaning?: string;
  targetR?: number;
  targetP?: number;
  initialR?: number;
  initialP?: number;
  level?: 'A1'|'A2'|'B1'|'B2'|'C1'|'C2';
  freq?: number;
  freqSource?: string;
};

function finiteRange(value: number, min: number, max: number, inclusiveMax: boolean): boolean {
  return Number.isFinite(value) && value >= min && (inclusiveMax ? value <= max : value < max);
}

/** Imports directly into the isolated v1 model; an absent gloss remains unconfirmed. */
export function importNewAlgorithmWords(db: Database.Database, words: NewWordInput[], now: number): number[] {
  if (!Array.isArray(words) || !words.length || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid import batch');
  const checked = words.map(input => {
    const term = input.term?.trim();
    const meaning = input.confirmedMeaning?.trim() ?? '';
    const targetR = input.targetR ?? 80, targetP = input.targetP ?? 80;
    const scoreR = input.initialR ?? 0, scoreP = input.initialP ?? 0;
    const level = input.level ?? 'B1';
    if (!term || term.length > 200 || meaning.length > 2000) throw new Error('Invalid term or meaning');
    if (!finiteRange(targetR,60,100,true) || !finiteRange(targetP,60,100,true)) throw new Error('Target must be 60–100');
    if (!finiteRange(scoreR,0,60,false) || !finiteRange(scoreP,0,60,false)) throw new Error('Initial score must be in [0,60)');
    if (!['A1','A2','B1','B2','C1','C2'].includes(level)) throw new Error('Invalid level');
    if (input.freq !== undefined && (!Number.isFinite(input.freq) || input.freq < 0 || !input.freqSource?.trim())) throw new Error('Frequency requires a source');
    if (input.freqSource && input.freq === undefined) throw new Error('Frequency source requires a value');
    return {term,meaning,targetR,targetP,scoreR,scoreP,level,freq:input.freq ?? null,freqSource:input.freqSource?.trim() ?? null};
  });
  return db.transaction(() => {
    const insert = db.prepare(`INSERT INTO words(term,meaning,target_r,target_p,score_r,score_p,level,freq,freq_source,created_at)
      VALUES(@term,@meaning,@targetR,@targetP,@scoreR,@scoreP,@level,@freq,@freqSource,@now)`);
    return checked.map(word => Number(insert.run({...word,now}).lastInsertRowid));
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
