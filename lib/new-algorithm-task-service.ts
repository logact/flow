import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { stageForScore, type FluencyResult } from './new-algorithm-score';
import { settleNewAlgorithmAttempt, type Judgment } from './new-algorithm-settlement';
import { getScheduleDecision, orderCandidates } from './new-algorithm-scheduler';
import { gradeAndSettleFrozenRetrievalAttempt, type SemanticEvaluator } from './new-algorithm-retrieval-evaluator';
import { gradeRFluency, type RFluencyEvaluator, type RFluencyGrade } from './new-algorithm-r-fluency';
import { evaluatePFluency, type PFluencyEvaluator } from './new-algorithm-p-fluency';
import { countRWords } from './new-algorithm-r-fluency';
import { rTimingProtocol, type RTimingEvent, type RTimingResult } from './new-algorithm-r-timing';

type Axis='r'|'p'|'both';
type Reservation={reservation_id:string;task_count:number;local_date:string;timezone:string;axis:Axis;reservation_kind:string};
type TaskStage='encode'|'choice'|'cued'|'free'|'fluency';
type PublicTask={instanceId:string;wordId:number;axis:Axis;type:'ENCODE'|'RETRIEVE'|'FLUENCY';stage:TaskStage;purpose:'introduce'|'review'|'recover';scoreBefore:number;issuedAt:number;payload:unknown};
type InstanceRow={instance_id:string;word_id:number;axis:Axis;type:'ENCODE'|'RETRIEVE'|'FLUENCY';stage:TaskStage;purpose:'introduce'|'review'|'recover';score_before:number;material_id:string;material_version:number;meaning_version:number;snapshot_json:string;status:string;issued_at:number;terminal_at:number|null};

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

function replayRTaskTiming(events:unknown,wordCount:number,issuedAt:number,submittedAt:number):RTimingResult {
  const invalid=(reason:string):RTimingResult=>({valid:false,readingSeconds:0,wpm:null,reason,events:[]});
  if(!Array.isArray(events)||events.length===0)return invalid('timing_events_missing');
  const allowed=new Set(['read_start','read_end','review_start','review_end','answer_start','answer_submit','interruption']);
  let priorAt=issuedAt;
  for(const value of events){
    if(!value||typeof value!=='object')return invalid('timing_event_invalid');
    const event=value as Record<string,unknown>;
    if(typeof event.type!=='string'||!allowed.has(event.type)||!Number.isSafeInteger(event.at))return invalid('timing_event_invalid');
    if((event.at as number)<issuedAt||(event.at as number)>submittedAt||(event.at as number)<priorAt)return invalid('timing_event_out_of_range');
    priorAt=event.at as number;
  }
  if((events[events.length-1] as Record<string,unknown>).type!=='answer_submit')return invalid('timing_submission_missing');
  try{return rTimingProtocol(events as RTimingEvent[],wordCount);}
  catch{return invalid('timing_protocol_invalid');}
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

export function getNewAlgorithmTaskInstance(db:Database.Database,instanceId:string):PublicTask|null {
  const row=db.prepare('SELECT * FROM task_instances WHERE instance_id=?').get(instanceId) as InstanceRow|undefined;
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

function makeCandidate(db:Database.Database,word:{id:number;term:string;meaning_version:number;local_timezone:string;introduced:number;score_r:number;score_p:number;target_r:number;target_p:number;due_at_r:string|null;due_at_p:string|null;learning_complete_r:number;learning_complete_p:number;graduated_r:number;graduated_p:number;last_ts_any:number|null;last_tick_any:number|null},axis:Axis,now:number,purpose:'introduce'|'review'|'recover'='introduce'):{task:PublicTask;reservation:Reservation;material:{id:string;version:number;public_payload:string;answer_key:string;usage_count:number}}|null {
  const date=localDate(now,word.local_timezone);
  const reservation=getReservation(db,word.id,axis,word.local_timezone,date);
  if(!reservation)return null;
  if(reservation.reservation_kind==='introduction')purpose='introduce';
  const stage:TaskStage=axis==='both'?'encode':word[`learning_complete_${axis}`]?'fluency':stageForScore(axis==='r'?word.score_r:word.score_p);
  const type=axis==='both'?'ENCODE':stage==='fluency'?'FLUENCY':'RETRIEVE';
  const material=db.prepare(`SELECT id,version,public_payload,answer_key,usage_count FROM materials
    WHERE word_id=? AND axis=? AND stage=? AND meaning_version=? AND status='ready' AND usage_count=0
    ORDER BY version DESC LIMIT 1`).get(word.id,axis,stage,word.meaning_version) as {id:string;version:number;public_payload:string;answer_key:string;usage_count:number}|undefined;
  if(!material)return null;
  const id=randomUUID();
  const payload=publicPayload(JSON.parse(material.public_payload));
  const snapshot={capacity_reservation_id:reservation.reservation_id,public_payload:payload,target:axis==='r'?word.target_r:axis==='p'?word.target_p:null};
  return {reservation,material,task:{instanceId:id,wordId:word.id,axis,type,stage,purpose,scoreBefore:axis==='r'?word.score_r:axis==='p'?word.score_p:0,issuedAt:now,payload}};
}

/** Issue the scheduler-selected task stage on the isolated schema. */
export function getOrIssueNewAlgorithmTask(db:Database.Database,now:number):PublicTask|{type:'EMPTY';reason:string;nextAvailableAt:number|null} {
  if(!Number.isSafeInteger(now)||now<0)throw new NewAlgorithmTaskError('Invalid server timestamp',400);
  return db.transaction(()=>{
    const live=liveInstance(db);if(live)return live;
    const words=db.prepare(`SELECT id,term,meaning_version,local_timezone,introduced,score_r,score_p,target_r,target_p,due_at_r,due_at_p,
      learning_complete_r,learning_complete_p,graduated_r,graduated_p,last_ts_any,last_tick_any FROM words ORDER BY id`).all() as Parameters<typeof makeCandidate>[1][];
    if(!words.length)return {type:'EMPTY' as const,reason:'scope_empty',nextAvailableAt:null};
    const decisions=[...new Set(words.map(word=>word.local_timezone))].map(timezone=>{
      const wordIds=words.filter(word=>word.local_timezone===timezone).map(word=>word.id);
      return getScheduleDecision(db,{now,today:localDate(now,timezone),timezone,wordIds});
    });
    const scheduled=decisions.flatMap(decision=>decision.kind==='candidate'?[decision.candidate]:[]);
    if(!scheduled.length){
      const empty=decisions.filter((decision):decision is Extract<typeof decision,{kind:'empty'}>=>decision.kind==='empty');
      const selected=empty.find(x=>x.reason==='cooldown_wait')??empty.find(x=>x.reason==='training_window_closed')??empty.find(x=>x.reason==='capacity_insufficient')??empty.find(x=>x.reason==='material_failed')??empty.find(x=>x.reason==='material_pending')??empty[0];
      return {type:'EMPTY' as const,reason:selected?.reason??'scope_empty',nextAvailableAt:selected?.nextAvailableAt??null};
    }
    const scheduledOrder=orderCandidates(scheduled);
    const chosen=scheduledOrder[0];
    const chosenWord=words.find(word=>word.id===chosen.wordId)!;
    const candidates:{word:typeof words[number];axis:Axis;due:string|null}[]=[];
    for(const word of words){
      if(!word.introduced&&word.score_r===0&&word.score_p===0){candidates.push({word,axis:'both',due:word.due_at_r});continue;}
      for(const axis of ['r','p'] as const){
        if(word[`graduated_${axis}`])continue;
        const due=word[`due_at_${axis}`];if(!due||Date.parse(due)>now)continue;
        candidates.push({word,axis,due});
      }
    }
    for(let i=candidates.length-1;i>=0;i--)if(candidates[i].word.id!==chosen.wordId||candidates[i].axis!==chosen.axis)candidates.splice(i,1);
    const priority=orderCandidates(candidates.map(({word,axis,due})=>({
      wordId:word.id,axis,dueDate:due?localDate(Date.parse(due),word.local_timezone):localDate(now,word.local_timezone),
      review:Boolean(axis!=='both'&&word[`learning_complete_${axis}`]),graduated:false,materialReady:true,
      kind:axis==='both'?'new' as const:'learning' as const,targetR:word.target_r,targetP:word.target_p,
      scoreR:word.score_r,scoreP:word.score_p,freq:null,freqSource:null,
      lastTick:word.last_tick_any,lastAt:word.last_ts_any,
    })));
    const rank=new Map(priority.map((candidate,index)=>[`${candidate.wordId}:${candidate.axis}`,index]));
    candidates.sort((a,b)=>(rank.get(`${a.word.id}:${a.axis}`)??Number.MAX_SAFE_INTEGER)-(rank.get(`${b.word.id}:${b.axis}`)??Number.MAX_SAFE_INTEGER));
    let earliestCooldown:number|null=null;
    let windowBlocked=false;
    for(const candidate of candidates){
      const selected=scheduledOrder.find(x=>x.wordId===candidate.word.id&&x.axis===candidate.axis);
      const purpose=selected?.kind==='review'?'review':selected?.kind==='new'?'introduce':'recover';
      const prepared=makeCandidate(db,candidate.word,candidate.axis,now,purpose);if(!prepared)continue;
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

/** Skip and exit are separate, idempotent terminal actions; neither consumes capacity or changes word state. */
export function endNewAlgorithmTask(db:Database.Database,input:{instanceId:string;action:'skip'|'exit';now:number}):{status:'skipped'|'exited';replay:boolean} {
  if(!input.instanceId||!Number.isSafeInteger(input.now)||input.now<0)throw new NewAlgorithmTaskError('Invalid task action',400);
  return db.transaction(()=>{
    const instance=db.prepare('SELECT * FROM task_instances WHERE instance_id=?').get(input.instanceId) as InstanceRow|undefined;
    if(!instance)throw new NewAlgorithmTaskError('Unknown task instance',404);
    const terminal:'skipped'|'exited'=input.action==='skip'?'skipped':'exited';
    const eventType=input.action==='skip'?'task_skipped':'task_exit';
    if(instance.status===terminal)return {status:terminal,replay:true};
    const retryAttempt=input.action==='exit'&&instance.status==='grading_retry'
      ?db.prepare("SELECT attempt_id FROM attempts WHERE instance_id=? AND status='grading_retry'").get(input.instanceId) as {attempt_id:string}|undefined:undefined;
    if(instance.status!=='issued'&&!retryAttempt)throw new NewAlgorithmTaskError('Task already has a different terminal action or frozen answer',409);
    const changed=db.prepare(`UPDATE task_instances SET status=?,terminal_at=? WHERE instance_id=? AND status ${retryAttempt?"='grading_retry'":"='issued'"}`).run(terminal,input.now,input.instanceId);
    if(changed.changes!==1)throw new NewAlgorithmTaskError('Task already has a different terminal action or frozen answer',409);
    db.prepare(`INSERT INTO events(event_id,dedupe_key,event_type,instance_id,word_id,axis,ts,payload_json)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`)
      .run(`${input.action}:${input.instanceId}`,`${eventType}:${input.instanceId}`,eventType,input.instanceId,instance.word_id,instance.axis,input.now,JSON.stringify({purpose:instance.purpose,attemptId:retryAttempt?.attempt_id??null}));
    if(retryAttempt)db.prepare("UPDATE attempts SET status='exited' WHERE attempt_id=? AND status='grading_retry'").run(retryAttempt.attempt_id);
    else db.prepare('UPDATE materials SET usage_count=MAX(0,usage_count-1) WHERE id=? AND usage_count>0').run(instance.material_id);
    return {status:terminal,replay:false};
  })();
}

/** Freeze cued/free answers before semantic grading so network failures can retry the same immutable response. */
export async function submitNewAlgorithmRetrievalAnswer(db:Database.Database,input:{instanceId:string;response:unknown;now:number;semanticEvaluator?:SemanticEvaluator}) {
  if(!input.instanceId||!Number.isSafeInteger(input.now)||input.now<0)throw new NewAlgorithmTaskError('Invalid submission',400);
  const frozen=db.transaction(()=>{
    const instance=db.prepare('SELECT * FROM task_instances WHERE instance_id=?').get(input.instanceId) as InstanceRow|undefined;
    if(!instance)throw new NewAlgorithmTaskError('Unknown task instance',404);
    if(instance.type!=='RETRIEVE'||!['cued','free'].includes(instance.stage))throw new NewAlgorithmTaskError('Task stage does not accept a text retrieval answer',409);
    const prior=db.prepare('SELECT * FROM attempts WHERE instance_id=?').get(input.instanceId) as {attempt_id:string;response_json:string;status:string}|undefined;
    if(prior){
      const saved=JSON.parse(prior.response_json) as {response:unknown};
      if(canonical(saved.response)!==canonical(input.response))throw new NewAlgorithmTaskError('INSTANCE_CONFLICT',409);
      if(instance.status==='completed'&&prior.status==='completed')return {instance,attemptId:prior.attempt_id,replay:true};
      if(!['grading','grading_retry'].includes(instance.status)||!['frozen','grading_retry'].includes(prior.status))throw new NewAlgorithmTaskError('Task is not retryable',409);
      return {instance,attemptId:prior.attempt_id,replay:false};
    }
    const answer=(input.response as {answer?:unknown}|null)?.answer;
    if(typeof answer!=='string'||!answer.trim())throw new NewAlgorithmTaskError('A non-empty answer is required',400);
    if(instance.status!=='issued')throw new NewAlgorithmTaskError('Task instance is not accepting a response',409);
    const attemptId=randomUUID();
    db.prepare("INSERT INTO attempts(attempt_id,instance_id,response_json,timing_json,exposure_json,status,created_at) VALUES(?,?,?,'{}','{}','frozen',?)")
      .run(attemptId,instance.instance_id,JSON.stringify({response:input.response}),input.now);
    db.prepare("UPDATE task_instances SET status='grading' WHERE instance_id=? AND status='issued'").run(instance.instance_id);
    return {instance,attemptId,replay:false};
  })();
  const semanticEvaluator=input.semanticEvaluator??(async ({response,targetMeaning,gradingRequirements}:{axis:'r';response:string;targetMeaning:string;gradingRequirements:Record<string,unknown>})=>{
    const {requestLlmJson}=await import('./llm');
    return requestLlmJson<{kind:'pass'|'fail'|'uncertain';reason?:string}>({
    system:'Judge whether the learner response accurately expresses the target meaning. Return kind pass, fail, or uncertain. Use uncertain when evidence is insufficient. Do not reward unrelated text.',
    user:JSON.stringify({response,targetMeaning,gradingRequirements}),
    validate:(value):value is {kind:'pass'|'fail'|'uncertain';reason?:string}=>Boolean(value&&typeof value==='object'&&['pass','fail','uncertain'].includes(String((value as {kind?:unknown}).kind))&&(!('reason'in (value as object))||typeof (value as {reason?:unknown}).reason==='string')),
    }).then(grade=>({kind:grade.kind,reason:grade.reason} as const));
  });
  const result=await gradeAndSettleFrozenRetrievalAttempt(db,{instanceId:input.instanceId,attemptId:frozen.attemptId,now:input.now,semanticEvaluator});
  if(result.action==='retry')return {action:'retry' as const,grade:result.grade,attempts:result.attempts,replay:false};
  return {action:'settled' as const,settlement:result.settlement,replay:result.replay||frozen.replay};
}

/** Fluency answers and timing are frozen together; invalid/service outcomes never tick learning state. */
export async function submitNewAlgorithmFluencyAnswer(db:Database.Database,input:{instanceId:string;response:unknown;now:number;rEvaluator?:RFluencyEvaluator;pEvaluator?:PFluencyEvaluator}) {
  if(!input.instanceId||!Number.isSafeInteger(input.now)||input.now<0)throw new NewAlgorithmTaskError('Invalid submission',400);
  const response=input.response as Record<string,unknown>|null;
  const frozen=db.transaction(()=>{
    const instance=db.prepare('SELECT * FROM task_instances WHERE instance_id=?').get(input.instanceId) as InstanceRow|undefined;
    if(!instance)throw new NewAlgorithmTaskError('Unknown task instance',404);
    if(instance.type!=='FLUENCY'||instance.stage!=='fluency'||instance.axis==='both')throw new NewAlgorithmTaskError('Task is not a fluency task',409);
    const prior=db.prepare('SELECT * FROM attempts WHERE instance_id=?').get(input.instanceId) as {attempt_id:string;response_json:string;timing_json:string;status:string}|undefined;
    if(prior){
      const saved=JSON.parse(prior.response_json) as {response:unknown;judgment?:Judgment};
      if(canonical(saved.response)!==canonical(input.response))throw new NewAlgorithmTaskError('INSTANCE_CONFLICT',409);
      if(instance.status==='completed'&&prior.status==='completed'&&saved.judgment)return {instance,attemptId:prior.attempt_id,replay:true,response:input.response,judgment:saved.judgment,timing:JSON.parse(prior.timing_json) as {valid?:boolean;reading_seconds?:number;wpm?:number|null;reason?:string;protocol?:unknown}};
      if(!['grading','grading_retry'].includes(instance.status)||!['frozen','grading_retry'].includes(prior.status))throw new NewAlgorithmTaskError('Task is not retryable',409);
      return {instance,attemptId:prior.attempt_id,replay:false,response:input.response,judgment:undefined,timing:JSON.parse(prior.timing_json) as {valid?:boolean;reading_seconds?:number;wpm?:number|null;reason?:string;protocol?:unknown}};
    }
    const wellFormed=instance.axis==='r'
      ?Array.isArray(response?.answers)&&response!.answers.length===2&&response!.answers.every(answer=>typeof answer==='string'&&answer.trim())&&Array.isArray(response?.timing_protocol)
      :typeof response?.text==='string'&&typeof response?.elapsed_seconds==='number';
    if(!wellFormed)throw new NewAlgorithmTaskError('Fluency response is incomplete',400);
    if(instance.status!=='issued')throw new NewAlgorithmTaskError('Task instance is not accepting a response',409);
    const attemptId=randomUUID();
    let timing:{protocol?:unknown;reading_seconds?:number;wpm?:number|null;valid?:boolean;reason?:string;elapsed_seconds?:number};
    if(instance.axis==='r'){
      const material=db.prepare('SELECT public_payload FROM materials WHERE id=? AND version=?').get(instance.material_id,instance.material_version) as {public_payload:string}|undefined;
      if(!material)throw new NewAlgorithmTaskError('Frozen fluency material is unavailable',409);
      const passage=JSON.parse(material.public_payload).passage;
      const replayed=replayRTaskTiming(response!.timing_protocol,countRWords(typeof passage==='string'?passage:''),instance.issued_at,input.now);
      timing={protocol:replayed.events,reading_seconds:replayed.readingSeconds,wpm:replayed.wpm,valid:replayed.valid,...(!replayed.valid?{reason:replayed.reason}:{})};
    }else timing={elapsed_seconds:Number(response!.elapsed_seconds)};
    db.prepare('INSERT INTO attempts(attempt_id,instance_id,response_json,timing_json,exposure_json,status,created_at) VALUES(?,?,?,?,?,\'frozen\',?)')
      .run(attemptId,instance.instance_id,JSON.stringify({response:input.response}),JSON.stringify(timing),'{}',input.now);
    db.prepare("UPDATE task_instances SET status='grading' WHERE instance_id=? AND status='issued'").run(instance.instance_id);
    return {instance,attemptId,replay:false,response:input.response,judgment:undefined,timing};
  })();
  let judgment:Judgment;
  if(frozen.judgment)judgment=frozen.judgment;
  else if(frozen.instance.axis==='r'){
    const material=db.prepare('SELECT public_payload,answer_key,grading_requirements FROM materials WHERE id=? AND version=?').get(frozen.instance.material_id,frozen.instance.material_version) as {public_payload:string;answer_key:string;grading_requirements:string}|undefined;
    if(!material)throw new NewAlgorithmTaskError('Frozen fluency material is unavailable',409);
    const saved=JSON.parse(material.public_payload) as {passage:string};const key=JSON.parse(material.answer_key);const requirements=JSON.parse(material.grading_requirements) as {targetMeaning:string};
    const evaluator:RFluencyEvaluator=input.rEvaluator??(async request=>{
      const {requestLlmJson}=await import('./llm');
      return requestLlmJson<RFluencyGrade>({
      system:'Evaluate whether both answers demonstrate comprehension of the passage and target word meaning. Return kind valid, invalid, uncertain, or service_error, with optional reasons.',
      user:JSON.stringify(request),
      validate:(value):value is RFluencyGrade=>{
        if(!value||typeof value!=='object')return false;
        const grade=value as Record<string,unknown>;
        if(!['valid','invalid','uncertain','service_error'].includes(String(grade.kind)))return false;
        if(grade.kind==='valid'&&typeof grade.targetPassed!=='boolean')return false;
        if(grade.kind==='valid'&&typeof grade.overallPassed!=='boolean')return false;
        return (!('wpm'in grade)||typeof grade.wpm==='number')&&(!('reasons'in grade)||Array.isArray(grade.reasons));
      },
      });
    });
    const grade=frozen.timing?.valid===true&&typeof frozen.timing.wpm==='number'?await gradeRFluency({material:{publicPayload:saved,answerKey:key,gradingRequirements:requirements,timingProtocol:{}},response:(response!.answers as [string,string]),wpm:frozen.timing.wpm,evaluator}):{kind:'invalid' as const,reasons:[frozen.timing?.reason??'READING_TIMING_INVALID']};
    judgment={kind:'fluency',result:grade};
  }else{
    const material=db.prepare('SELECT answer_key,grading_requirements FROM materials WHERE id=? AND version=?').get(frozen.instance.material_id,frozen.instance.material_version) as {answer_key:string;grading_requirements:string}|undefined;
    if(!material)throw new NewAlgorithmTaskError('Frozen fluency material is unavailable',409);
    const key=JSON.parse(material.answer_key);const requirements=JSON.parse(material.grading_requirements) as {target_form:string};
    const evaluator:PFluencyEvaluator=input.pEvaluator??(async request=>{
      const {requestLlmJson}=await import('./llm');
      return requestLlmJson({
      system:'Evaluate the English writing response on target expression and overall retelling separately. Return targetPassed, overallPassed, targetEvidence, overallEvidence. If uncertain, return kind uncertain.',
      user:JSON.stringify(request),
      validate:(value):value is {targetPassed:boolean|'uncertain';overallPassed:boolean|'uncertain';targetEvidence:string;overallEvidence:string}|{kind:'service_error'|'uncertain'}=>{
        if(!value||typeof value!=='object')return false;
        const v=value as Record<string,unknown>;
        if('kind'in v)return v.kind==='service_error'||v.kind==='uncertain';
        const verdict=(x:unknown)=>typeof x==='boolean'||x==='uncertain';
        return verdict(v.targetPassed)&&verdict(v.overallPassed)&&typeof v.targetEvidence==='string'&&typeof v.overallEvidence==='string';
      },
      });
    });
    const result=await evaluatePFluency({text:String(response!.text),elapsedSeconds:Number(response!.elapsed_seconds),targetForm:requirements.target_form,answerKey:key,evaluator});
    judgment={kind:'fluency',result:result.kind==='valid'?{kind:'valid',targetPassed:result.targetPassed,overallPassed:result.overallPassed,wpm:result.wpm}:{kind:result.kind}};
  }
  if(frozen.replay){const settlement=settleNewAlgorithmAttempt(db,{instanceId:input.instanceId,attemptId:frozen.attemptId,judgment,exposedBeforeFeedback:false,now:input.now});return {action:'settled' as const,settlement,replay:true};}
  db.prepare('UPDATE attempts SET response_json=? WHERE attempt_id=?').run(JSON.stringify({response:input.response,judgment}),frozen.attemptId);
  const settlement=settleNewAlgorithmAttempt(db,{instanceId:input.instanceId,attemptId:frozen.attemptId,judgment,exposedBeforeFeedback:false,now:input.now});
  return settlement.status==='grading_retry'?{action:'retry' as const,grade:(judgment as Extract<Judgment,{kind:'fluency'}>).result,replay:false}:{action:'settled' as const,settlement,replay:false};
}
