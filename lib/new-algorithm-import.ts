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

export type Availability = { timezone: string; localDate: string; capacity: number; windowStart: string; windowEnd: string };

export function minimumIntroductionTasks(estimate: InitialScoreEstimate): number {
  if (estimate.requiresConnection) return 9;
  const axisTasks = (score: number) => score >= 60 ? 1 : score >= 40 ? 2 : score >= 20 ? 3 : 4;
  return axisTasks(estimate.scoreR) + axisTasks(estimate.scoreP);
}

export function setDailyAvailability(db: Database.Database, value: Availability): void {
  if (!Number.isInteger(value.capacity) || value.capacity < 0) throw new Error('Invalid daily capacity');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.localDate) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.windowStart) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value.windowEnd) || value.windowEnd <= value.windowStart) throw new Error('Invalid local training window');
  new Intl.DateTimeFormat('en', { timeZone: value.timezone }).format(0);
  db.transaction(() => {
    db.prepare(`INSERT INTO daily_capacity(local_date,timezone,capacity,completed) VALUES(?,?,?,0)
      ON CONFLICT(local_date,timezone) DO UPDATE SET capacity=excluded.capacity`).run(value.localDate,value.timezone,value.capacity);
    for (const [key, val] of [['training_window_start',value.windowStart],['training_window_end',value.windowEnd]] as const) {
      db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(`${key}:${value.timezone}`,val);
    }
  })();
}

export function canAdmitIntroduction(db: Database.Database, estimates: InitialScoreEstimate[], now: number, timezone: string): boolean {
  const local = new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const part = (type:string) => local.find(p=>p.type===type)?.value ?? '';
  const date = `${part('year')}-${part('month')}-${part('day')}`;
  const row = db.prepare('SELECT capacity,completed FROM daily_capacity WHERE local_date=? AND timezone=?').get(date,timezone) as {capacity:number;completed:number}|undefined;
  if (!row) return false;
  const start = db.prepare('SELECT value FROM meta WHERE key=?').get(`training_window_start:${timezone}`) as {value:string}|undefined;
  const end = db.prepare('SELECT value FROM meta WHERE key=?').get(`training_window_end:${timezone}`) as {value:string}|undefined;
  if (!start || !end) return false;
  const minuteNow = Number(part('hour'))*60 + Number(part('minute'));
  const minuteStart = Number(start.value.slice(0,2))*60 + Number(start.value.slice(3,5));
  const minuteEnd = Number(end.value.slice(0,2))*60 + Number(end.value.slice(3,5));
  const reserved=(db.prepare("SELECT COALESCE(SUM(task_count),0) n FROM capacity_reservations WHERE local_date=? AND timezone=? AND status='active'").get(date,timezone) as {n:number}).n;
  const tasks = estimates.reduce((sum,item)=>sum+minimumIntroductionTasks(item),0);
  const cooldownMinutes = estimates.reduce((max,item)=>Math.max(max,Math.max(0,minimumIntroductionTasks(item)-1)*20),0);
  return row.capacity-row.completed-reserved >= tasks && minuteNow >= minuteStart && minuteNow < minuteEnd && minuteEnd-minuteNow >= cooldownMinutes;
}

export function reserveIntroductionCapacity(db: Database.Database, candidates: {wordId:number;estimate:InitialScoreEstimate}[], now: number, timezone: string): boolean {
  const dateParts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const p=(type:string)=>dateParts.find(x=>x.type===type)?.value ?? '';
  const date=`${p('year')}-${p('month')}-${p('day')}`;
  if (!canAdmitIntroduction(db,candidates.map(x=>x.estimate),now,timezone)) return false;
  const insert=db.prepare(`INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status)
    VALUES(?,?, 'both', ?,?, 'introduction',?,'active')`);
  for (const candidate of candidates) {
    insert.run(`intro:${candidate.wordId}`,candidate.wordId,date,timezone,minimumIntroductionTasks(candidate.estimate));
  }
  return true;
}

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
  reserveCapacity: (tx: Database.Database, candidates: {wordId:number;estimate:InitialScoreEstimate}[], now:number, timezone:string) => boolean
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
  return db.transaction(() => {
    const dueNow = new Date(now).toISOString();
    const insert = db.prepare(`INSERT INTO words(term,meaning,target_r,target_p,score_r,score_p,introduced,due_at_r,due_at_p,level,freq,freq_source,local_timezone,created_at)
      VALUES(@term,@meaning,@targetR,@targetP,@scoreR,@scoreP,@introduced,@dueNow,@dueNow,@level,@freq,@freqSource,@timezone,@now)`);
    const ids=checked.map(({estimate: _estimate, ...word}) => Number(insert.run({...word,dueNow,now}).lastInsertRowid));
    const tz=checked[0].timezone;
    if (checked.some(row=>row.timezone!==tz)) throw new Error('IMPORT_TIMEZONE_MISMATCH');
    if (!reserveCapacity(db,checked.map((row,index)=>({wordId:ids[index],estimate:row.estimate})),now,tz)) throw new Error('CAPACITY_INSUFFICIENT');
    return ids;
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
