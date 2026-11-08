import type Database from 'better-sqlite3';

export type MaterialDraft = {
  publicPayload: unknown;
  answerKey: unknown;
  gradingRequirements: unknown;
  timingProtocol: unknown;
  validation: unknown;
};

export type MaterialJobInput = {
  wordId: number;
  axis: 'r' | 'p' | 'both';
  stage: 'encode' | 'choice' | 'cued' | 'free' | 'fluency';
  version: number;
  meaningVersion: number;
  now: number;
};

export type MaterialProvider = (input: MaterialJobInput, meaning: string) => Promise<MaterialDraft>;
export type MaterialValidator = (input: MaterialJobInput, draft: MaterialDraft) => { valid: boolean; reason?: string };
export type ReadyMaterial = { id:string; version:number; public_payload:string; grading_requirements:string; timing_protocol:string };

export function findReadyNewAlgorithmMaterial(db: Database.Database, input: Pick<MaterialJobInput,'wordId'|'axis'|'stage'|'meaningVersion'>): ReadyMaterial | null {
  return db.prepare(`SELECT id,version,public_payload,grading_requirements,timing_protocol FROM materials
    WHERE word_id=? AND axis=? AND stage=? AND meaning_version=? AND status='ready' AND usage_count=0
    ORDER BY version DESC LIMIT 1`).get(input.wordId,input.axis,input.stage,input.meaningVersion) as ReadyMaterial | undefined ?? null;
}

const BATCH_ATTEMPTS = 2; // D5
const PROVIDER_TIMEOUT_MS = 8000; // D5

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('PROVIDER_TIMEOUT')), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Creates one versioned material job; unconfirmed glosses never produce ready judgeable material. */
export async function generateNewAlgorithmMaterial(
  db: Database.Database,
  input: MaterialJobInput,
  provider: MaterialProvider,
  validate: MaterialValidator
): Promise<{ id: string; status: 'ready' | 'failed'; attempts: number; reason?: string }> {
  const word = db.prepare('SELECT meaning,meaning_version FROM words WHERE id=?').get(input.wordId) as {meaning:string;meaning_version:number}|undefined;
  if (!word) throw new Error('Unknown word');
  if (!word.meaning.trim() || word.meaning_version !== input.meaningVersion) throw new Error('CONFIRMED_GLOSS_REQUIRED');
  if ((input.stage === 'encode') !== (input.axis === 'both')) throw new Error('AXIS_STAGE_MISMATCH');
  const id = `${input.wordId}:${input.axis}:${input.stage}:${input.version}`;
  db.prepare(`INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,generation_attempts,created_at)
    VALUES(?,?,?,?,?,?,'preparing','','','','','{}',0,?)`).run(id,input.wordId,input.axis,input.stage,input.version,input.meaningVersion,input.now);
  let lastReason = 'GENERATION_FAILED';
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= BATCH_ATTEMPTS; attempt++) {
    attemptsMade=attempt;
    try {
      const beforeCall=db.prepare('SELECT meaning,meaning_version FROM words WHERE id=?').get(input.wordId) as {meaning:string;meaning_version:number}|undefined;
      if(!beforeCall||beforeCall.meaning_version!==input.meaningVersion||beforeCall.meaning!==word.meaning){lastReason='MEANING_VERSION_CHANGED';break;}
      const draft = await withTimeout(provider(input, word.meaning), PROVIDER_TIMEOUT_MS);
      const afterCall=db.prepare('SELECT meaning,meaning_version FROM words WHERE id=?').get(input.wordId) as {meaning:string;meaning_version:number}|undefined;
      if(!afterCall||afterCall.meaning_version!==input.meaningVersion||afterCall.meaning!==word.meaning){lastReason='MEANING_VERSION_CHANGED';break;}
      const result = validate(input, draft);
      if (!result.valid) {
        lastReason = result.reason ?? 'VALIDATION_FAILED';
        db.prepare('UPDATE materials SET generation_attempts=? WHERE id=?').run(attempt,id);
        continue;
      }
      db.prepare(`UPDATE materials SET status='ready',public_payload=?,answer_key=?,grading_requirements=?,timing_protocol=?,validation_json=?,generation_attempts=? WHERE id=?`)
        .run(JSON.stringify(draft.publicPayload),JSON.stringify(draft.answerKey),JSON.stringify(draft.gradingRequirements),JSON.stringify(draft.timingProtocol),JSON.stringify(draft.validation),attempt,id);
      return {id,status:'ready',attempts:attempt};
    } catch (error) {
      lastReason = error instanceof Error ? error.message : 'GENERATION_FAILED';
      db.prepare('UPDATE materials SET generation_attempts=? WHERE id=?').run(attempt,id);
    }
  }
  db.prepare("UPDATE materials SET status='failed',generation_attempts=?,validation_json=? WHERE id=?")
    .run(attemptsMade,JSON.stringify({reason:lastReason}),id);
  return {id,status:'failed',attempts:attemptsMade,reason:lastReason};
}
