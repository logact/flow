import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { stageForScore, type FluencyResult } from './new-algorithm-score';
import { settleNewAlgorithmAttempt, type Judgment } from './new-algorithm-settlement';

type Axis='r'|'p'|'both';
type Reservation={reservation_id:string;task_count:number;local_date:string;timezone:string;axis:Axis;reservation_kind:string};
type PublicTask={instanceId:string;wordId:number;axis:Axis;type:'ENCODE'|'RETRIEVE';stage:'encode'|'choice';purpose:'introduce'|'review'|'recover';scoreBefore:number;issuedAt:number;payload:unknown};
type InstanceRow={instance_id:string;word_id:number;axis:Axis;type:'ENCODE'|'RETRIEVE';stage:'encode'|'choice';purpose:'introduce'|'review'|'recover';score_before:number;material_id:string;material_version:number;meaning_version:number;snapshot_json:string;status:string;issued_at:number;terminal_at:number|null};

export class NewAlgorithmTaskError extends Error {
  constructor(message:string,readonly status:number){super(message);}
}

function localDate(timestamp:number,timezone:string):string {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(timestamp);
  const get=(name:string)=>parts.find(x=>x.type===name)?.value??'';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function inTrainingWindow(db:Database.Database,now:number,timezone:string):boolean {
  const start=db.prepare('SELECT value FROM meta WHERE key=?').get(`training_window_start:${timezone}`) as {value:string}|undefined;
  const end=db.prepare('SELECT value FROM meta WHERE key=?').get(`training_window_end:${timezone}`) as {value:string}|undefined;
  if(!start||!end)return false;
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const value=(name:string)=>Number(parts.find(x=>x.type===name)?.value);
  const minute=value('hour')*60+value('minute');
  const toMinute=(time:string)=>Number(time.slice(0,2))*60+Number(time.slice(3,5));
  return minute>=toMinute(start.value)&&minute<toMinute(end.value);
}

function canonical(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object') return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

function publicPayload(value:unknown):unknown {
  if(Array.isArray(value))return value.map(publicPayload);
  if(!value||typeof value!=='object')return value;
  return Object.fromEntries(Object.entries(value as Record<string,unknown>)
    .filter(([key])=>!['answer_index','answerindex','correct_index','correctindex','answer_key','answerkey','correct_answer','correctanswer'].includes(key.toLowerCase()))
    .map(([key,nested])=>[key,publicPayload(nested)]));
}

function publicFromRow(row:InstanceRow):PublicTask {
  const snapshot=JSON.parse(row.snapshot_json) as {public_payload?:unknown};
  return {instanceId:row.instance_id,wordId:row.word_id,axis:row.axis,type:row.type,stage:row.stage,purpose:row.purpose,scoreBefore:row.score_before,issuedAt:row.issued_at,payload:snapshot.public_payload};
}

function liveInstance(db:Database.Database):PublicTask|null {
  const row=db.prepare("SELECT * FROM task_instances WHERE status IN ('issued','grading','grading_retry') LIMIT 1").get() as InstanceRow|undefined;
  return row?publicFromRow(row):null;
}

function getReservation(db:Database.Database,wordId:number,axis:Axis,timezone:string,date:string):Reservation|null {
  const capacity=db.prepare('SELECT capacity,completed FROM daily_capacity WHERE local_date=? AND timezone=?').get(date,timezone) as {capacity:number;completed:number}|undefined;
  if(!capacity)return null;
  const reserved=(db.prepare("SELECT COALESCE(SUM(task_count),0) n FROM capacity_reservations WHERE local_date=? AND timezone=? AND status='active'").get(date,timezone) as {n:number}).n;
  if(capacity.completed+reserved>capacity.capacity)return null;
  const row=db.prepare(`SELECT reservation_id,task_count,local_date,timezone,axis,reservation_kind FROM capacity_reservations
    WHERE word_id=? AND local_date=? AND timezone=? AND status='active' AND task_count>0
      AND ((reservation_kind='introduction' AND axis='both') OR (reservation_kind IN ('determined','conditional') AND axis=?))
    ORDER BY CASE reservation_kind WHEN 'determined' THEN 0 WHEN 'introduction' THEN 1 ELSE 2 END LIMIT 1`)
    .get(wordId,date,timezone,axis==='both'?'r':axis) as Reservation|undefined;
  return row??null;
}

function cooldown(db:Database.Database,word:{id:number;last_ts_any:number|null;last_tick_any:number|null},now:number):number|null {
  if(word.last_ts_any===null||word.last_tick_any===null)return null;
  const tick=Number((db.prepare("SELECT value FROM meta WHERE key='global_tick'").get() as {value:string}).value);
  if(tick-word.last_tick_any>=7||now-word.last_ts_any>=20*60*1000)return null;
  return word.last_ts_any+20*60*1000;
}

function makeCandidate(db:Database.Database,word:{id:number;term:string;meaning_version:number;local_timezone:string;introduced:number;score_r:number;score_p:number;target_r:number;target_p:number;due_at_r:string|null;due_at_p:string|null;learning_complete_r:number;learning_complete_p:number;graduated_r:number;graduated_p:number;last_ts_any:number|null;last_tick_any:number|null},axis:Axis,now:number):{task:PublicTask;reservation:Reservation;material:{id:string;version:number;public_payload:string;answer_key:string;usage_count:number}}|null {
  const date=localDate(now,word.local_timezone);
  const reservation=getReservation(db,word.id,axis,word.local_timezone,date);
  if(!reservation)return null;
  const stage=axis==='both'?'encode':stageForScore(axis==='r'?word.score_r:word.score_p);
  if(stage!=='encode'&&stage!=='choice')return null;
  const type=axis==='both'?'ENCODE':'RETRIEVE';
  const material=db.prepare(`SELECT id,version,public_payload,answer_key,usage_count FROM materials
    WHERE word_id=? AND axis=? AND stage=? AND meaning_version=? AND status='ready' AND usage_count=0
    ORDER BY version DESC LIMIT 1`).get(word.id,axis,stage,word.meaning_version) as {id:string;version:number;public_payload:string;answer_key:string;usage_count:number}|undefined;
  if(!material)return null;
  const id=randomUUID();
  const payload=publicPayload(JSON.parse(material.public_payload));
  const snapshot={capacity_reservation_id:reservation.reservation_id,public_payload:payload,target:axis==='r'?word.target_r:axis==='p'?word.target_p:null};
  return {reservation,material,task:{instanceId:id,wordId:word.id,axis,type,stage,purpose:'introduce',scoreBefore:axis==='r'?word.score_r:axis==='p'?word.score_p:0,issuedAt:now,payload}};
}

/** Issue only connection and choice tasks on the isolated schema; later nodes add other stages and full priority. */
export function getOrIssueNewAlgorithmTask(db:Database.Database,now:number):PublicTask|{type:'EMPTY';reason:string;nextAvailableAt:number|null} {
  if(!Number.isSafeInteger(now)||now<0)throw new NewAlgorithmTaskError('Invalid server timestamp',400);
  return db.transaction(()=>{
    const live=liveInstance(db);if(live)return live;
    const words=db.prepare(`SELECT id,term,meaning_version,local_timezone,introduced,score_r,score_p,target_r,target_p,due_at_r,due_at_p,
      learning_complete_r,learning_complete_p,graduated_r,graduated_p,last_ts_any,last_tick_any FROM words ORDER BY id`).all() as Parameters<typeof makeCandidate>[1][];
    const candidates:{word:typeof words[number];axis:Axis;due:string|null}[]=[];
    for(const word of words){
      if(!word.introduced&&word.score_r===0&&word.score_p===0){candidates.push({word,axis:'both',due:word.due_at_r});continue;}
      for(const axis of ['r','p'] as const){
        if(word[`graduated_${axis}`]||word[`learning_complete_${axis}`])continue;
        const due=word[`due_at_${axis}`];if(!due||Date.parse(due)>now)continue;
        if(stageForScore(word[`score_${axis}`])==='choice')candidates.push({word,axis,due});
      }
    }
    candidates.sort((a,b)=>(Date.parse(a.due??'')-Date.parse(b.due??''))||a.word.id-b.word.id||(a.axis==='r'?-1:a.axis==='both'?-2:1)-(b.axis==='r'?-1:b.axis==='both'?-2:1));
    let earliestCooldown:number|null=null;
    let windowBlocked=false;
    for(const candidate of candidates){
      const prepared=makeCandidate(db,candidate.word,candidate.axis,now);if(!prepared)continue;
      if(!inTrainingWindow(db,now,candidate.word.local_timezone)){windowBlocked=true;continue;}
      const wait=candidate.axis==='both'?null:cooldown(db,candidate.word,now);
      if(wait!==null){earliestCooldown=earliestCooldown===null?wait:Math.min(wait,earliestCooldown);continue;}
      const {task,reservation,material}=prepared;
      db.prepare(`INSERT INTO task_instances(instance_id,definition_id,word_id,axis,type,stage,purpose,score_before,material_id,material_version,meaning_version,snapshot_json,status,issued_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?, 'issued',?)`)
        .run(task.instanceId,`new-algorithm-${task.type.toLowerCase()}-${task.stage}`,task.wordId,task.axis,task.type,task.stage,task.purpose,task.scoreBefore,material.id,material.version,candidate.word.meaning_version,
          JSON.stringify({capacity_reservation_id:reservation.reservation_id,public_payload:task.payload}),now);
      const updated=db.prepare("UPDATE materials SET usage_count=usage_count+1 WHERE id=? AND status='ready' AND usage_count=0").run(material.id);
      if(updated.changes!==1)throw new NewAlgorithmTaskError('Material was claimed concurrently',409);
      return task;
    }
    return {type:'EMPTY' as const,reason:earliestCooldown!==null?'cooldown_wait':windowBlocked?'training_window_closed':'materials_unavailable',nextAvailableAt:earliestCooldown};
  })();
}

function responseJudgment(db:Database.Database,instance:InstanceRow,response:unknown):Judgment {
  if(!response||typeof response!=='object'||Array.isArray(response))throw new NewAlgorithmTaskError('Invalid response',400);
  const value=response as Record<string,unknown>;
  if(instance.type==='ENCODE'){
    if(value.confirmed!==true)throw new NewAlgorithmTaskError('Connection confirmation is required',400);
    return {kind:'encode'};
  }
  if(instance.type!=='RETRIEVE'||instance.stage!=='choice')throw new NewAlgorithmTaskError('Unsupported task stage',409);
  if(!Number.isSafeInteger(value.selected_index)||Number(value.selected_index)<0)throw new NewAlgorithmTaskError('selected_index is required',400);
  const row=db.prepare('SELECT answer_key,public_payload FROM materials WHERE id=? AND version=? AND word_id=? AND axis=? AND stage=?').get(instance.material_id,instance.material_version,instance.word_id,instance.axis,instance.stage) as {answer_key:string;public_payload:string}|undefined;
  if(!row)throw new NewAlgorithmTaskError('Frozen material is missing',409);
  const key=JSON.parse(row.answer_key) as Record<string,unknown>;
  const correct=key.correct_index??key.correctIndex??key.answer_index??key.answerIndex;
  const payload=JSON.parse(row.public_payload) as {options?:unknown};
  if(!Number.isSafeInteger(correct)||Number(correct)<0||!Array.isArray(payload.options)||Number(value.selected_index)>=payload.options.length||Number(correct)>=payload.options.length)throw new NewAlgorithmTaskError('Choice material lacks a valid private answer key',409);
  return {kind:'retrieval',passed:Number(value.selected_index)===Number(correct)};
}

/** Persist the first response before settlement; exact repeats replay and conflicting repeats fail. */
export function submitNewAlgorithmTaskResponse(db:Database.Database,input:{instanceId:string;response:unknown;now:number}):{settlement:unknown;replay:boolean} {
  if(!input.instanceId||!Number.isSafeInteger(input.now)||input.now<0)throw new NewAlgorithmTaskError('Invalid submission',400);
  return db.transaction(()=>{
    const instance=db.prepare('SELECT * FROM task_instances WHERE instance_id=?').get(input.instanceId) as InstanceRow|undefined;
    if(!instance)throw new NewAlgorithmTaskError('Unknown task instance',404);
    const prior=db.prepare('SELECT * FROM attempts WHERE instance_id=? AND status IN (\'frozen\',\'completed\')').get(input.instanceId) as {attempt_id:string;response_json:string;status:string}|undefined;
    if(instance.status==='completed'&&prior?.status==='completed'){
      const saved=JSON.parse(prior.response_json) as {response:unknown;judgment:Judgment};
      if(canonical(saved.response)!==canonical(input.response))throw new NewAlgorithmTaskError('INSTANCE_CONFLICT',409);
      const settlement=settleNewAlgorithmAttempt(db,{instanceId:instance.instance_id,attemptId:prior.attempt_id,judgment:saved.judgment,exposedBeforeFeedback:false,now:input.now});
      return {settlement,replay:true};
    }
    if(instance.status!=='issued'||prior)throw new NewAlgorithmTaskError('Task instance is not accepting a response',409);
    const judgment=responseJudgment(db,instance,input.response);
    const attemptId=randomUUID();
    db.prepare(`INSERT INTO attempts(attempt_id,instance_id,response_json,timing_json,exposure_json,status,created_at)
      VALUES(?,?,?,'{}','{}','frozen',?)`).run(attemptId,instance.instance_id,JSON.stringify({response:input.response,judgment}),input.now);
    db.prepare("UPDATE task_instances SET status='grading' WHERE instance_id=? AND status='issued'").run(instance.instance_id);
    const settlement=settleNewAlgorithmAttempt(db,{instanceId:instance.instance_id,attemptId,judgment,exposedBeforeFeedback:false,now:input.now});
    return {settlement,replay:false};
  })();
}
