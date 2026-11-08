import type Database from 'better-sqlite3';
import { connectionScores, fluencyScore, retrievalScore, type FluencyResult } from './new-algorithm-score';
import { localCalendarDate, localDayStart, projectRemainingReviewDates, settleAxisReview, startAxisReview, type ReviewAxisState, type ReviewLevel } from './new-algorithm-review';

type Instance = { instance_id:string; word_id:number; axis:'r'|'p'|'both'; type:'ENCODE'|'RETRIEVE'|'FLUENCY'; stage:'encode'|'choice'|'cued'|'free'|'fluency'; purpose:'introduce'|'review'|'recover'; score_before:number; status:string; material_id:string; material_version:number; snapshot_json:string };
type Attempt = { attempt_id:string; instance_id:string; status:string; exposure_json:string };
export type Judgment = { kind:'encode' } | { kind:'retrieval'; passed:boolean } | { kind:'fluency'; result:FluencyResult };
export type Settlement = { status:'completed'; scoreBefore:number; scoreAfter:number; tick:number; replay:boolean } | { status:'grading_retry'; replay:boolean };

/** Update one or both targets and return any no-longer-eligible axis to today's learning queue. */
export function updateNewAlgorithmTargets(db:Database.Database,input:{wordId:number;targetR:number;targetP:number;now:number}):{requeuedAxes:('r'|'p')[];capacityBlockedAxes:('r'|'p')[]} {
  if (![input.targetR,input.targetP].every(value=>Number.isFinite(value)&&value>=60&&value<=100) || !Number.isSafeInteger(input.now) || input.now<0) throw new RangeError('Invalid target update');
  return db.transaction(()=>{
    const word=getWordState(db,input.wordId);
    if(!word) throw new Error('Unknown word');
    const requeuedAxes:('r'|'p')[]=[];
    const capacityBlockedAxes:('r'|'p')[]=[];
    const targetChanged=(input.targetR!==word.target_r)||(input.targetP!==word.target_p);
    if(targetChanged) {
      const live=db.prepare("SELECT axis FROM task_instances WHERE word_id=? AND status IN ('issued','grading','grading_retry')").all(input.wordId) as {axis:'r'|'p'|'both'}[];
      if(live.some(instance=>instance.axis==='both'||(instance.axis==='r'&&input.targetR!==word.target_r)||(instance.axis==='p'&&input.targetP!==word.target_p))) {
        throw new Error('Cannot change an affected target while its task is active');
      }
    }
    for(const axis of ['r','p'] as const) {
      const target=axis==='r'?input.targetR:input.targetP;
      const score=word[`score_${axis}`];
      const losesEligibility=score<target && (word[`learning_complete_${axis}`]===1 || word[`review_level_${axis}`]!==null || word[`graduated_${axis}`]===1 || word[`fluency_pass_${axis}`]===1);
      if(losesEligibility) {
        db.prepare(`UPDATE words SET target_${axis}=?,fluency_pass_${axis}=0,learning_complete_${axis}=0,
          review_level_${axis}=NULL,graduated_${axis}=0,due_at_${axis}=? WHERE id=?`)
          .run(target,localDayStart(input.now,word.local_timezone),input.wordId);
        db.prepare(`UPDATE capacity_reservations SET status='cancelled' WHERE word_id=? AND axis=?
          AND reservation_kind IN ('determined','conditional') AND status='active'`).run(input.wordId,axis);
        if(reserveImmediateLearningTask(db,input.wordId,axis,word.local_timezone,input.now))requeuedAxes.push(axis);
        else capacityBlockedAxes.push(axis);
      } else {
        db.prepare(`UPDATE words SET target_${axis}=?,learning_complete_${axis}=CASE WHEN score_${axis}>=? AND fluency_pass_${axis}=1 THEN 1 ELSE 0 END WHERE id=?`)
          .run(target,target,input.wordId);
      }
    }
    db.prepare('UPDATE words SET graduated=CASE WHEN graduated_r=1 AND graduated_p=1 THEN 1 ELSE 0 END WHERE id=?').run(input.wordId);
    return {requeuedAxes,capacityBlockedAxes};
  })();
}

type WordState = {
  score_r:number; score_p:number; target_r:number; target_p:number; introduced:number;
  fluency_pass_r:number; fluency_pass_p:number; learning_complete_r:number; learning_complete_p:number;
  review_level_r:ReviewLevel|null; review_level_p:ReviewLevel|null;
  graduated_r:number; graduated_p:number; graduated:number; due_at_r:string|null; due_at_p:string|null; local_timezone:string;
};

function getWordState(db:Database.Database, wordId:number):WordState|undefined {
  return db.prepare('SELECT * FROM words WHERE id=?').get(wordId) as WordState|undefined;
}

function syncReviewReservations(db:Database.Database,wordId:number,axis:'r'|'p',state:ReviewAxisState,timeZone:string):void {
  db.prepare(`UPDATE capacity_reservations SET status='cancelled' WHERE word_id=? AND axis=?
    AND reservation_kind IN ('determined','conditional') AND status='active'`).run(wordId,axis);
  if(!state.learningComplete || state.reviewLevel===null || state.graduated || !state.dueAt) return;
  const dueDates=projectRemainingReviewDates(state.dueAt,state.reviewLevel,timeZone);
  dueDates.forEach((dueAt,index)=>{
    const date=localCalendarDate(Date.parse(dueAt),timeZone);
    const kind=index===0?'determined':'conditional';
    const reservationId=`review:${wordId}:${axis}:${kind}:${date}`;
    db.prepare(`INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status)
      VALUES(?,?,?,?,?,?,1,'active')
      ON CONFLICT(word_id,axis,local_date,timezone,reservation_kind)
      DO UPDATE SET task_count=1,status='active'`)
      .run(reservationId,wordId,axis,date,timeZone,kind);
  });
}

function reserveImmediateLearningTask(db:Database.Database,wordId:number,axis:'r'|'p',timeZone:string,now:number):boolean {
  const date=localCalendarDate(now,timeZone);
  const existing=db.prepare(`SELECT 1 FROM capacity_reservations WHERE word_id=? AND local_date=? AND timezone=? AND status='active'
    AND ((axis=? AND reservation_kind IN ('determined','conditional')) OR (axis='both' AND reservation_kind='introduction')) LIMIT 1`).get(wordId,date,timeZone,axis);
  if(existing)return true;
  const capacity=db.prepare('SELECT capacity,completed FROM daily_capacity WHERE local_date=? AND timezone=?').get(date,timeZone) as {capacity:number;completed:number}|undefined;
  if(!capacity)return false;
  const reserved=(db.prepare("SELECT COALESCE(SUM(task_count),0) n FROM capacity_reservations WHERE local_date=? AND timezone=? AND status='active'").get(date,timeZone) as {n:number}).n;
  if(capacity.completed+reserved>=capacity.capacity)return false;
  db.prepare(`INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status)
    VALUES(?,?,?,?,?,'determined',1,'active')
    ON CONFLICT(word_id,axis,local_date,timezone,reservation_kind) DO UPDATE SET reservation_id=excluded.reservation_id,task_count=1,status='active'`)
    .run(`target-change:${wordId}:${axis}:${date}`,wordId,axis,date,timeZone);
  return true;
}

function consumeCapacity(db:Database.Database, instance:Instance, now:number):void {
  let reservationId:string|undefined;
  try { reservationId = (JSON.parse(instance.snapshot_json) as {capacity_reservation_id?:string}).capacity_reservation_id; }
  catch { throw new Error('Invalid frozen task snapshot'); }
  if (!reservationId) throw new Error('Task snapshot lacks capacity_reservation_id');
  const reservation=db.prepare('SELECT * FROM capacity_reservations WHERE reservation_id=?').get(reservationId) as {
    reservation_id:string;word_id:number;axis:'r'|'p'|'both';local_date:string;timezone:string;reservation_kind:'introduction'|'determined'|'conditional';task_count:number;status:string;
  }|undefined;
  if (!reservation || reservation.status!=='active' || reservation.word_id!==instance.word_id) throw new Error('Capacity reservation is missing or inactive');
  const expectedKind=instance.purpose==='introduce'?'introduction':null;
  const axisMatches=expectedKind==='introduction'
    ? reservation.axis==='both' && ['r','p','both'].includes(instance.axis)
    : reservation.axis===instance.axis;
  if (!axisMatches || (expectedKind && reservation.reservation_kind!==expectedKind) || (!expectedKind && reservation.reservation_kind==='introduction')) throw new Error('Capacity reservation does not match task');
  const localDate=localCalendarDate(now,reservation.timezone);
  if (localDate<reservation.local_date) throw new Error('Task cannot settle before its reserved local day');
  const capacity=db.prepare('SELECT capacity,completed FROM daily_capacity WHERE local_date=? AND timezone=?').get(localDate,reservation.timezone) as {capacity:number;completed:number}|undefined;
  if (!capacity) throw new Error('Daily task capacity is not configured for settlement day');
  const activeReserved=(date:string)=>(db.prepare("SELECT COALESCE(SUM(task_count),0) n FROM capacity_reservations WHERE local_date=? AND timezone=? AND status='active'").get(date,reservation.timezone) as {n:number}).n;
  const reservedToday=activeReserved(localDate);
  if (localDate===reservation.local_date) {
    if(capacity.completed+reservedToday>capacity.capacity) throw new Error('Daily task capacity is exhausted');
  } else if(capacity.completed+reservedToday>=capacity.capacity) {
    throw new Error('Daily task capacity is exhausted');
  }
  db.prepare(`UPDATE capacity_reservations
    SET task_count=CASE WHEN task_count>1 THEN task_count-1 ELSE task_count END,
        status=CASE WHEN task_count=1 THEN 'consumed' ELSE status END
    WHERE reservation_id=? AND status='active'`).run(reservationId);
  db.prepare('UPDATE daily_capacity SET completed=completed+1 WHERE local_date=? AND timezone=?').run(localDate,reservation.timezone);
}

function persistAxisSettlement(db:Database.Database, instance:Instance, word:WordState, scoreAfter:number, input:{now:number; tick:number; judgment:Judgment}):void {
  if (instance.axis==='both') return;
  const axis=instance.axis;
  const isFluency=instance.type==='FLUENCY' && instance.stage==='fluency' && input.judgment.kind==='fluency';
  if (instance.purpose==='review' && !isFluency) throw new Error('Scheduled review must be a FLUENCY task');
  const state:ReviewAxisState={
    score:word[`score_${axis}`], target:word[`target_${axis}`],
    reviewLevel:word[`review_level_${axis}`], dueAt:word[`due_at_${axis}`],
    graduated:word[`graduated_${axis}`]===1, fluencyPass:word[`fluency_pass_${axis}`]===1,
    learningComplete:word[`learning_complete_${axis}`]===1,
  };
  let next=state;
  if (isFluency && input.judgment.kind==='fluency' && input.judgment.result.kind==='valid') {
    const outcome=fluencyScore(axis,instance.score_before,input.judgment.result);
    if (instance.purpose==='review') {
      if (state.reviewLevel===null || state.graduated) throw new Error('Axis has no active review schedule');
      const passed=outcome.kind==='scored' && outcome.reason==='fluent' && outcome.score>=state.target;
      next=settleAxisReview(state,{completedAt:input.now,timeZone:word.local_timezone,result:passed?'passed':'failed',scoreAfter});
    } else if (outcome.kind==='scored' && outcome.reason==='fluent' && outcome.score>=state.target) {
      next=startAxisReview({...state,score:scoreAfter},{completedAt:input.now,timeZone:word.local_timezone});
    } else {
      next={...state,score:scoreAfter,fluencyPass:scoreAfter<state.target?false:state.fluencyPass,learningComplete:scoreAfter<state.target?false:state.learningComplete};
    }
  } else if (scoreAfter<state.target) {
    next={...state,score:scoreAfter,fluencyPass:false,learningComplete:false};
  } else {
    next={...state,score:scoreAfter};
  }
  db.prepare(`UPDATE words SET score_${axis}=?,fluency_pass_${axis}=?,learning_complete_${axis}=?,
    review_level_${axis}=?,due_at_${axis}=?,graduated_${axis}=?,
    graduated=CASE WHEN graduated_${axis === 'r' ? 'p' : 'r'}=1 AND ?=1 THEN 1 ELSE 0 END,
    last_ts_${axis}=?,last_ts_any=?,last_tick_any=?,introduced=1 WHERE id=?`)
    .run(next.score,next.fluencyPass?1:0,next.learningComplete?1:0,next.reviewLevel,next.dueAt,next.graduated?1:0,next.graduated?1:0,input.now,input.now,input.tick,instance.word_id);
  syncReviewReservations(db,instance.word_id,axis,next,word.local_timezone);
}

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
    let word: WordState|undefined;
    if (axis === 'both') {
      word = getWordState(db,instance.word_id);
      if (!word || word.score_r !== 0 || word.score_p !== 0 || word.introduced !== 0) throw new Error('Connection is only valid for an unintroduced double-zero word');
      scoreBefore = 0;
    } else {
      word = getWordState(db,instance.word_id);
      if (!word || word[`score_${axis}`] !== instance.score_before) throw new Error('Score changed after issue');
    }
    const global = db.prepare("SELECT value FROM meta WHERE key='global_tick'").get() as {value:string};
    const tick = Number(global.value) + 1;
    if (!Number.isSafeInteger(tick)) throw new Error('Invalid global tick');
    consumeCapacity(db,instance,input.now);
    if (axis === 'both') {
      const connection = connectionScores(word!.score_r, word!.score_p, true);
      db.prepare('UPDATE words SET score_r=?,score_p=?,introduced=1,last_ts_any=?,last_tick_any=? WHERE id=?').run(connection.scoreR,connection.scoreP,input.now,tick,instance.word_id);
      db.prepare('UPDATE words SET last_ts_r=?,last_ts_p=? WHERE id=?').run(input.now,input.now,instance.word_id);
      scoreAfter = connection.scoreR;
      targetAxis = 'both';
    } else {
      persistAxisSettlement(db,instance,word!,scoreAfter,{now:input.now,tick,judgment:input.judgment});
    }
    db.prepare("UPDATE meta SET value=? WHERE key='global_tick'").run(String(tick));
    db.prepare("UPDATE task_instances SET status='completed',terminal_at=? WHERE instance_id=?").run(input.now,input.instanceId);
    db.prepare("UPDATE attempts SET status='completed' WHERE attempt_id=?").run(input.attemptId);
    const payload = {score_before:scoreBefore,score_after:scoreAfter,tick,material_id:instance.material_id,material_version:instance.material_version};
    db.prepare('INSERT INTO events(event_id,dedupe_key,event_type,instance_id,attempt_id,word_id,axis,ts,payload_json) VALUES(?,?,?,?,?,?,?,?,?)').run(`completed:${input.instanceId}`,`completed:${input.instanceId}`,'completed',input.instanceId,input.attemptId,instance.word_id,targetAxis,input.now,JSON.stringify(payload));
    return {status:'completed',scoreBefore,scoreAfter,tick,replay:false};
  })();
}
