import type Database from 'better-sqlite3';
import { connectionScores, fluencyScore, retrievalScore, type FluencyResult } from './new-algorithm-score';

type Instance = { instance_id:string; word_id:number; axis:'r'|'p'|'both'; type:'ENCODE'|'RETRIEVE'|'FLUENCY'; stage:'encode'|'choice'|'cued'|'free'|'fluency'; score_before:number; status:string; material_id:string; material_version:number };
type Attempt = { attempt_id:string; instance_id:string; status:string; exposure_json:string };
export type Judgment = { kind:'encode' } | { kind:'retrieval'; passed:boolean } | { kind:'fluency'; result:FluencyResult };
export type Settlement = { status:'completed'; scoreBefore:number; scoreAfter:number; tick:number; replay:boolean } | { status:'grading_retry'; replay:boolean };

/** Completes a frozen attempt in one SQLite transaction. Caller owns answer validation. */
export function settleNewAlgorithmAttempt(db: Database.Database, input: {instanceId:string; attemptId:string; judgment:Judgment; exposedBeforeFeedback:boolean; now:number}): Settlement {
  return db.transaction((): Settlement => {
    const instance = db.prepare('SELECT * FROM task_instances WHERE instance_id=?').get(input.instanceId) as Instance|undefined;
    const attempt = db.prepare('SELECT * FROM attempts WHERE attempt_id=? AND instance_id=?').get(input.attemptId,input.instanceId) as Attempt|undefined;
    if (!instance || !attempt) throw new Error('Unknown instance or attempt');
    if (instance.status === 'completed' && attempt.status === 'completed') {
      const event = db.prepare("SELECT payload_json FROM events WHERE dedupe_key=?").get(`completed:${input.instanceId}`) as {payload_json:string}|undefined;
      if (!event) throw new Error('Completed instance lacks event');
      const saved = JSON.parse(event.payload_json) as {score_before:number;score_after:number;tick:number};
      return {status:'completed',scoreBefore:saved.score_before,scoreAfter:saved.score_after,tick:saved.tick,replay:true};
    }
    if (!['grading','grading_retry'].includes(instance.status) || !['frozen','grading_retry'].includes(attempt.status)) throw new Error('Instance is not ready for grading');
    if (!Number.isSafeInteger(input.now) || input.now < 0) throw new RangeError('Invalid timestamp');
    const exposure = JSON.parse(attempt.exposure_json) as {target_seen?:unknown};
    if (input.exposedBeforeFeedback && exposure.target_seen !== true) throw new Error('Target exposure lacks frozen evidence');
    let scoreAfter: number;
    let scoreBefore = instance.score_before;
    let targetAxis: 'r'|'p'|'both' = instance.axis;
    if (instance.type === 'ENCODE' && instance.stage === 'encode' && instance.axis === 'both' && input.judgment.kind === 'encode') scoreAfter = 5;
    else if (instance.type === 'RETRIEVE' && ['choice','cued','free'].includes(instance.stage) && input.judgment.kind === 'retrieval') scoreAfter = retrievalScore(instance.stage as 'choice'|'cued'|'free',input.judgment.passed);
    else if (instance.type === 'FLUENCY' && instance.stage === 'fluency' && input.judgment.kind === 'fluency') {
      if (instance.axis === 'both') throw new Error('FLUENCY must target one axis');
      const outcome = fluencyScore(instance.axis,instance.score_before,input.judgment.result);
      if (input.judgment.result.kind !== 'valid') {
        db.prepare("UPDATE task_instances SET status='grading_retry' WHERE instance_id=?").run(input.instanceId);
        db.prepare("UPDATE attempts SET status='grading_retry',grading_attempts=grading_attempts+1 WHERE attempt_id=?").run(input.attemptId);
        db.prepare('INSERT INTO events(event_id,dedupe_key,event_type,instance_id,attempt_id,word_id,axis,ts,payload_json) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING').run(`retry:${input.attemptId}`,`grading_retry:${input.attemptId}`,'grading_retry',input.instanceId,input.attemptId,instance.word_id,instance.axis,input.now,JSON.stringify({reason:input.judgment.result.kind}));
        return {status:'grading_retry',replay:false};
      }
      scoreAfter = outcome.score;
    } else throw new Error('Judgment does not match instance');
    const axis = instance.axis;
    let word: {score_r:number;score_p:number;target_r:number;target_p:number;introduced:number}|undefined;
    if (axis === 'both') {
      word = db.prepare('SELECT score_r,score_p,target_r,target_p,introduced FROM words WHERE id=?').get(instance.word_id) as typeof word;
      if (!word || word.score_r !== 0 || word.score_p !== 0 || word.introduced !== 0) throw new Error('Connection is only valid for an unintroduced double-zero word');
      scoreBefore = 0;
    } else {
      word = db.prepare(`SELECT score_${axis} AS score_r,score_p,target_r,target_p,introduced FROM words WHERE id=?`).get(instance.word_id) as typeof word;
      if (!word || word[`score_${axis}`] !== instance.score_before) throw new Error('Score changed after issue');
    }
    const global = db.prepare("SELECT value FROM meta WHERE key='global_tick'").get() as {value:string};
    const tick = Number(global.value) + 1;
    if (!Number.isSafeInteger(tick)) throw new Error('Invalid global tick');
    if (axis === 'both') {
      const connection = connectionScores(word!.score_r, word!.score_p, true);
      db.prepare('UPDATE words SET score_r=?,score_p=?,introduced=1,last_ts_any=?,last_tick_any=? WHERE id=?').run(connection.scoreR,connection.scoreP,input.now,tick,instance.word_id);
      scoreAfter = connection.scoreR;
      targetAxis = 'both';
    } else {
      const fluencyPass = instance.type === 'FLUENCY' && input.judgment.kind === 'fluency' && input.judgment.result.kind === 'valid' && scoreAfter >= word![`target_${axis}`];
      db.prepare(`UPDATE words SET score_${axis}=?,fluency_pass_${axis}=CASE WHEN ? THEN 1 WHEN ? < target_${axis} THEN 0 ELSE fluency_pass_${axis} END,learning_complete_${axis}=CASE WHEN ? >= target_${axis} AND (fluency_pass_${axis}=1 OR ?) THEN 1 ELSE 0 END,last_ts_any=?,last_tick_any=?,introduced=1 WHERE id=?`).run(scoreAfter,fluencyPass ? 1 : 0,scoreAfter,scoreAfter,fluencyPass ? 1 : 0,input.now,tick,instance.word_id);
    }
    db.prepare("UPDATE meta SET value=? WHERE key='global_tick'").run(String(tick));
    db.prepare("UPDATE task_instances SET status='completed',terminal_at=? WHERE instance_id=?").run(input.now,input.instanceId);
    db.prepare("UPDATE attempts SET status='completed' WHERE attempt_id=?").run(input.attemptId);
    const payload = {score_before:scoreBefore,score_after:scoreAfter,tick,material_id:instance.material_id,material_version:instance.material_version};
    db.prepare('INSERT INTO events(event_id,dedupe_key,event_type,instance_id,attempt_id,word_id,axis,ts,payload_json) VALUES(?,?,?,?,?,?,?,?,?)').run(`completed:${input.instanceId}`,`completed:${input.instanceId}`,'completed',input.instanceId,input.attemptId,instance.word_id,targetAxis,input.now,JSON.stringify(payload));
    return {status:'completed',scoreBefore,scoreAfter,tick,replay:false};
  })();
}
