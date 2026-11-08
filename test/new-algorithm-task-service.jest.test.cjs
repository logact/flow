const {createNewAlgorithmDb}=require('../lib/new-algorithm-db');
const {endNewAlgorithmTask,getOrIssueNewAlgorithmTask,startNewAlgorithmPWriting,submitNewAlgorithmFluencyAnswer,submitNewAlgorithmRetrievalAnswer,submitNewAlgorithmTaskResponse,NewAlgorithmTaskError}=require('../lib/new-algorithm-task-service');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const taskRoute=require('../app/api/new-algorithm/task/route');
const runtimeDb=require('../lib/new-algorithm-runtime-db');

const NOW=Date.parse('2026-11-07T02:00:00Z');

function seed(db,{introduced=0,scoreR=0,scoreP=0,taskCount=9}={}) {
  db.prepare(`INSERT INTO words(id,term,meaning,target_r,target_p,score_r,score_p,introduced,due_at_r,due_at_p,local_timezone,created_at)
    VALUES(1,'word','confirmed meaning',80,80,?,?,?,'2026-11-07T00:00:00.000Z','2026-11-07T00:00:00.000Z','Asia/Shanghai',1)`).run(scoreR,scoreP,introduced);
  db.prepare("INSERT INTO daily_capacity(local_date,timezone,capacity,completed) VALUES('2026-11-07','Asia/Shanghai',9,0)").run();
  db.prepare("INSERT INTO meta(key,value) VALUES('training_window_start:Asia/Shanghai','00:00'),('training_window_end:Asia/Shanghai','23:59')").run();
  db.prepare(`INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status)
    VALUES('intro:1',1,'both','2026-11-07','Asia/Shanghai','introduction',?,'active')`).run(taskCount);
}

describe('isolated new algorithm task service',()=>{
  test('issues one connection instance, freezes reservation id and persists dual-axis answer once',()=>{
    const db=createNewAlgorithmDb();seed(db);
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('encode',1,'both','encode',1,1,'ready','{\"text\":\"word meaning\"}','{}','{}','{}','{}',1)").run();
    const first=getOrIssueNewAlgorithmTask(db,NOW);
    const second=getOrIssueNewAlgorithmTask(db,NOW+10);
    expect(first).toMatchObject({type:'ENCODE',axis:'both',stage:'encode',wordId:1});
    expect(second.instanceId).toBe(first.instanceId);
    expect(db.prepare('SELECT json_extract(snapshot_json,\'$.capacity_reservation_id\') id FROM task_instances').get().id).toBe('intro:1');
    expect(submitNewAlgorithmTaskResponse(db,{instanceId:first.instanceId,response:{confirmed:true},now:NOW+100})).toMatchObject({replay:false,settlement:{scoreAfter:5}});
    expect(submitNewAlgorithmTaskResponse(db,{instanceId:first.instanceId,response:{confirmed:true},now:NOW+200})).toMatchObject({replay:true,settlement:{scoreAfter:5}});
    expect(()=>submitNewAlgorithmTaskResponse(db,{instanceId:first.instanceId,response:{confirmed:false},now:NOW+300})).toThrow(NewAlgorithmTaskError);
    expect(db.prepare('SELECT score_r,score_p,introduced FROM words WHERE id=1').get()).toEqual({score_r:5,score_p:5,introduced:1});
    expect(db.prepare('SELECT task_count,status FROM capacity_reservations').get()).toEqual({task_count:8,status:'active'});
    expect(db.prepare('SELECT completed FROM daily_capacity').get().completed).toBe(1);
    expect(db.prepare('SELECT count(*) n FROM events WHERE event_type=\'completed\'').get().n).toBe(1);
    db.close();
  });

  test('issues a due choice task for one axis, hides the answer key and settles only that axis',()=>{
    const db=createNewAlgorithmDb();seed(db,{introduced:1,scoreR:0,scoreP:5,taskCount:3});
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('choice-r',1,'r','choice',1,1,'ready','{\"question\":\"meaning?\",\"options\":[\"a\",\"b\",\"c\"],\"answer_index\":2}','{\"correct_index\":2}','{}','{}','{}',1)").run();
    const task=getOrIssueNewAlgorithmTask(db,NOW);
    expect(task).toMatchObject({type:'RETRIEVE',axis:'r',stage:'choice',scoreBefore:0,payload:{options:['a','b','c']}});
    expect(JSON.stringify(task)).not.toContain('answer_index');
    expect(JSON.stringify(task)).not.toContain('correct_index');
    expect(submitNewAlgorithmTaskResponse(db,{instanceId:task.instanceId,response:{selected_index:2},now:NOW+100})).toMatchObject({settlement:{scoreAfter:20},replay:false});
    expect(db.prepare('SELECT score_r,score_p FROM words WHERE id=1').get()).toEqual({score_r:20,score_p:5});
    expect(db.prepare('SELECT task_count,status FROM capacity_reservations').get()).toEqual({task_count:2,status:'active'});
    db.close();
  });

  test('formal task issuance uses scheduler priority: due learning precedes a new-word introduction',()=>{
    const db=createNewAlgorithmDb();seed(db);
    db.prepare("UPDATE daily_capacity SET capacity=10").run();
    db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,score_r,score_p,introduced,due_at_r,due_at_p,local_timezone,created_at) VALUES(2,'due','due meaning',80,80,0,20,1,'2026-11-07T00:00:00.000Z','2026-11-07T00:00:00.000Z','Asia/Shanghai',2)").run();
    db.prepare("INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES('due-r',2,'r','2026-11-07','Asia/Shanghai','determined',1,'active')").run();
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('encode-first',1,'both','encode',1,1,'ready','{}','{}','{}','{}','{}',1),('choice-due',2,'r','choice',1,1,'ready','{\"options\":[\"a\",\"b\"]}','{\"correct_index\":0}','{}','{}','{}',1)").run();
    const task=getOrIssueNewAlgorithmTask(db,NOW);
    expect(task).toMatchObject({wordId:2,axis:'r',stage:'choice'});
    db.close();
  });

  test('a wrong choice lowers only the issued axis to the normative failure score',()=>{
    const db=createNewAlgorithmDb();seed(db,{introduced:1,scoreR:0,scoreP:20,taskCount:3});
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('choice-r-wrong',1,'r','choice',1,1,'ready','{\"options\":[\"a\",\"b\",\"c\"]}','{\"correct_index\":2}','{}','{}','{}',1)").run();
    const task=getOrIssueNewAlgorithmTask(db,NOW);
    submitNewAlgorithmTaskResponse(db,{instanceId:task.instanceId,response:{selected_index:0},now:NOW+100});
    expect(db.prepare('SELECT score_r,score_p FROM words WHERE id=1').get()).toEqual({score_r:5,score_p:20});
    db.close();
  });

  test('dispatches a cued retrieval task and freezes then grades the original text response',async()=>{
    const db=createNewAlgorithmDb();seed(db,{introduced:1,scoreR:5,scoreP:20,taskCount:3});
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('cued-p',1,'p','cued',1,1,'ready','{\"prompt\":\"Use the hint\"}','{\"target_form\":\"carry\",\"allowed_inflections\":[\"carries\"]}','{}','{}','{}',1)").run();
    const task=getOrIssueNewAlgorithmTask(db,NOW);
    expect(task).toMatchObject({type:'RETRIEVE',axis:'p',stage:'cued'});
    const result=await submitNewAlgorithmRetrievalAnswer(db,{instanceId:task.instanceId,response:{answer:'carry'},now:NOW+100});
    expect(result).toMatchObject({action:'settled',settlement:{scoreAfter:40,replay:false}});
    expect(JSON.parse(db.prepare('SELECT response_json FROM attempts').get().response_json).response).toEqual({answer:'carry'});
    const tick=db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value;
    expect(await submitNewAlgorithmRetrievalAnswer(db,{instanceId:task.instanceId,response:{answer:'carry'},now:NOW+200})).toMatchObject({action:'settled',replay:true});
    expect(db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value).toBe(tick);
    db.close();
  });

  test('an empty text answer is rejected before it can become a frozen attempt',async()=>{
    const db=createNewAlgorithmDb();seed(db,{introduced:1,scoreR:5,scoreP:20,taskCount:3});
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('cued-empty',1,'p','cued',1,1,'ready','{\"prompt\":\"Use the hint\"}','{\"target_form\":\"carry\",\"allowed_inflections\":[]}','{}','{}','{}',1)").run();
    const task=getOrIssueNewAlgorithmTask(db,NOW);
    await expect(submitNewAlgorithmRetrievalAnswer(db,{instanceId:task.instanceId,response:{answer:'  '},now:NOW+1})).rejects.toThrow(NewAlgorithmTaskError);
    expect(db.prepare('SELECT count(*) n FROM attempts').get().n).toBe(0);
    expect(db.prepare('SELECT status FROM task_instances WHERE instance_id=?').get(task.instanceId).status).toBe('issued');
    db.close();
  });

  test('refresh after material recovery changes EMPTY into a dispatchable task',()=>{
    const db=createNewAlgorithmDb();seed(db);
    expect(getOrIssueNewAlgorithmTask(db,NOW)).toMatchObject({type:'EMPTY',reason:'material_pending'});
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('encode-recovered',1,'both','encode',1,1,'ready','{}','{}','{}','{}','{}',1)").run();
    expect(getOrIssueNewAlgorithmTask(db,NOW+1)).toMatchObject({type:'ENCODE',axis:'both'});
    db.close();
  });

  test('explicit exit closes a grading-retry attempt; skip cannot close it',()=>{
    const db=createNewAlgorithmDb();seed(db);
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('encode-exit',1,'both','encode',1,1,'ready','{}','{}','{}','{}','{}',1)").run();
    const task=getOrIssueNewAlgorithmTask(db,NOW);
    db.prepare("UPDATE task_instances SET status='grading_retry' WHERE instance_id=?").run(task.instanceId);
    db.prepare("INSERT INTO attempts(attempt_id,instance_id,response_json,timing_json,exposure_json,status,created_at) VALUES('retry-attempt',?,'{}','{}','{}','grading_retry',?)").run(task.instanceId,NOW);
    expect(()=>endNewAlgorithmTask(db,{instanceId:task.instanceId,action:'skip',now:NOW+1})).toThrow(NewAlgorithmTaskError);
    expect(endNewAlgorithmTask(db,{instanceId:task.instanceId,action:'exit',now:NOW+2})).toEqual({status:'exited',replay:false});
    expect(db.prepare("SELECT status FROM attempts WHERE attempt_id='retry-attempt'").get().status).toBe('exited');
    expect(db.prepare("SELECT count(*) n FROM events WHERE event_type='task_exit'").get().n).toBe(1);
    db.close();
  });

  test('dispatches an axis-specific fluency review when that axis is due',()=>{
    const db=createNewAlgorithmDb();seed(db,{introduced:1,scoreR:80,scoreP:20,taskCount:3});
    db.prepare("UPDATE capacity_reservations SET status='cancelled' WHERE reservation_id='intro:1'").run();
    db.prepare("UPDATE words SET learning_complete_r=1,review_level_r=1,due_at_r='2026-11-07T00:00:00.000Z' WHERE id=1").run();
    db.prepare("INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES('review-r',1,'r','2026-11-07','Asia/Shanghai','determined',1,'active')").run();
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('fluency-r',1,'r','fluency',1,1,'ready','{\"passage\":\"text\",\"questions\":[{\"prompt\":\"q1\"},{\"prompt\":\"q2\"}]}','{\"questions\":[{\"answer\":\"a\",\"evidence\":\"e\"},{\"answer\":\"b\",\"evidence\":\"e\"}]}','{\"targetMeaning\":\"gloss\",\"targetForms\":[\"word\"]}','{}','{}',1)").run();
    const issued=getOrIssueNewAlgorithmTask(db,NOW);
    expect(issued).toMatchObject({type:'FLUENCY',axis:'r',stage:'fluency',purpose:'review'});
    db.close();
  });

  test('a semantic grading failure keeps one immutable answer and retry settles without a second tick',async()=>{
    const db=createNewAlgorithmDb();seed(db,{introduced:1,scoreR:20,scoreP:5,taskCount:3});
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('cued-r-retry',1,'r','cued',1,1,'ready','{\"prompt\":\"Explain the word\"}','{\"target_meaning\":\"to carry\"}','{}','{}','{}',1)").run();
    const task=getOrIssueNewAlgorithmTask(db,NOW);
    const first=await submitNewAlgorithmRetrievalAnswer(db,{instanceId:task.instanceId,response:{answer:'transport'},now:NOW+1,semanticEvaluator:()=>{throw Error('offline');}});
    expect(first).toMatchObject({action:'retry',grade:{kind:'service_error'},attempts:1});
    expect(db.prepare("SELECT status,score_r FROM task_instances JOIN words ON words.id=task_instances.word_id WHERE instance_id=?").get(task.instanceId)).toEqual({status:'grading_retry',score_r:20});
    const attemptId=db.prepare('SELECT attempt_id FROM attempts WHERE instance_id=?').get(task.instanceId).attempt_id;
    await expect(submitNewAlgorithmRetrievalAnswer(db,{instanceId:task.instanceId,response:{answer:'different'},now:NOW+2,semanticEvaluator:()=>({kind:'pass'})})).rejects.toThrow('INSTANCE_CONFLICT');
    const retry=await submitNewAlgorithmRetrievalAnswer(db,{instanceId:task.instanceId,response:{answer:'transport'},now:NOW+3,semanticEvaluator:()=>({kind:'pass'})});
    expect(retry).toMatchObject({action:'settled',settlement:{scoreAfter:40,replay:false}});
    expect(db.prepare('SELECT attempt_id FROM attempts WHERE instance_id=?').get(task.instanceId).attempt_id).toBe(attemptId);
    expect(db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value).toBe('1');
    db.close();
  });

  test('R fluency replays timing on the server and ignores forged client timing fields',async()=>{
    const db=createNewAlgorithmDb();seed(db,{introduced:1,scoreR:60,scoreP:20,taskCount:3});
    db.prepare("UPDATE capacity_reservations SET status='cancelled' WHERE reservation_id='intro:1'").run();
    db.prepare("UPDATE words SET learning_complete_r=1,review_level_r=1,due_at_r='2026-11-07T00:00:00.000Z' WHERE id=1").run();
    db.prepare("INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES('review-r-fluency',1,'r','2026-11-07','Asia/Shanghai','determined',1,'active')").run();
    const passage=Array(100).fill('word').join(' ');
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('r-fluency-grade',1,'r','fluency',1,1,'ready',?,'{\"questions\":[{\"answer\":\"a\",\"evidence\":\"e\"},{\"answer\":\"b\",\"evidence\":\"e\"}]}','{\"targetMeaning\":\"gloss\",\"targetForms\":[\"word\"]}','{}','{}',1)").run(JSON.stringify({passage,questions:[{prompt:'q1'},{prompt:'q2'}]}));
    const task=getOrIssueNewAlgorithmTask(db,NOW);
    const result=await submitNewAlgorithmFluencyAnswer(db,{instanceId:task.instanceId,response:{answers:['first','second'],timing_protocol:[
      {type:'read_start',at:NOW+1},{type:'read_end',at:NOW+20_001},{type:'answer_start',at:NOW+20_001},{type:'answer_submit',at:NOW+60_000},
    ],timing_valid:false,reading_seconds:0.01,wpm:1},now:NOW+60_000,rEvaluator:()=>({kind:'valid',targetPassed:true,overallPassed:true})});
    expect(result).toMatchObject({action:'settled',settlement:{scoreBefore:60,scoreAfter:100}});
    expect(JSON.parse(db.prepare('SELECT timing_json FROM attempts').get().timing_json)).toEqual({protocol:[
      {type:'read_start',at:NOW+1,segment:1},{type:'read_end',at:NOW+20_001,segment:1},{type:'answer_start',at:NOW+20_001},{type:'answer_submit',at:NOW+60_000},
    ],reading_seconds:20,wpm:300,valid:true});
    db.close();
  });

  test('an interrupted R timing trace cannot score even when the client claims valid and fast reading',async()=>{
    const db=createNewAlgorithmDb();seed(db,{introduced:1,scoreR:60,scoreP:20,taskCount:3});
    db.prepare("UPDATE capacity_reservations SET status='cancelled' WHERE reservation_id='intro:1'").run();
    db.prepare("INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES('review-r-interrupted',1,'r','2026-11-07','Asia/Shanghai','determined',1,'active')").run();
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('r-fluency-interrupted',1,'r','fluency',1,1,'ready',?,'{\"questions\":[{\"answer\":\"a\",\"evidence\":\"e\"},{\"answer\":\"b\",\"evidence\":\"e\"}]}','{\"targetMeaning\":\"gloss\",\"targetForms\":[\"word\"]}','{}','{}',1)").run(JSON.stringify({passage:Array(100).fill('word').join(' '),questions:[{prompt:'q1'},{prompt:'q2'}]}));
    const task=getOrIssueNewAlgorithmTask(db,NOW);
    const result=await submitNewAlgorithmFluencyAnswer(db,{instanceId:task.instanceId,response:{answers:['first','second'],timing_protocol:[
      {type:'read_start',at:NOW+1},{type:'interruption',at:NOW+10_001},{type:'answer_submit',at:NOW+20_000},
    ],timing_valid:true,reading_seconds:1,wpm:6000},now:NOW+20_000,rEvaluator:()=>({kind:'valid',targetPassed:true,overallPassed:true})});
    expect(result).toMatchObject({action:'retry',grade:{kind:'invalid',reasons:['interrupted']}});
    expect(db.prepare('SELECT score_r,last_tick_any FROM words WHERE id=1').get()).toEqual({score_r:60,last_tick_any:null});
    expect(JSON.parse(db.prepare('SELECT timing_json FROM attempts').get().timing_json)).toMatchObject({valid:false,reason:'interrupted',wpm:null});
    db.close();
  });

  test('P fluency passes separate target and retelling judgments into scoring',async()=>{
    const db=createNewAlgorithmDb();seed(db,{introduced:1,scoreR:20,scoreP:60,taskCount:3});
    db.prepare("UPDATE capacity_reservations SET status='cancelled' WHERE reservation_id='intro:1'").run();
    db.prepare("UPDATE words SET learning_complete_p=1,review_level_p=1,due_at_p='2026-11-07T00:00:00.000Z' WHERE id=1").run();
    db.prepare("INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES('review-p-fluency',1,'p','2026-11-07','Asia/Shanghai','determined',1,'active')").run();
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('p-fluency-grade',1,'p','fluency',1,1,'ready','{\"scene_zh\":\"场景\",\"instructions_zh\":\"写作\"}','{\"answer\":\"private\"}','{\"target_form\":\"targetform\",\"forbidden_target_forms\":[]}','{}','{}',1)").run();
    const task=getOrIssueNewAlgorithmTask(db,NOW);
    startNewAlgorithmPWriting(db,{instanceId:task.instanceId,now:NOW+100});
    const text=Array.from({length:30},(_,i)=>`word${String.fromCharCode(97+i%26)}${i}`).join(' ');
    const result=await submitNewAlgorithmFluencyAnswer(db,{instanceId:task.instanceId,response:{text,elapsed_seconds:1},now:NOW+60_100,pEvaluator:()=>({targetPassed:true,overallPassed:true,targetEvidence:'target used',overallEvidence:'meaning clear'})});
    expect(result.action).toBe('settled');expect(result.settlement.scoreBefore).toBe(60);expect(result.settlement.scoreAfter).toBeCloseTo(65.71428571428571,10);
    expect(JSON.parse(db.prepare('SELECT response_json FROM attempts').get().response_json).response.text).toBe(text);
    expect(JSON.parse(db.prepare('SELECT timing_json FROM attempts').get().timing_json)).toMatchObject({elapsed_seconds:60,started_at:NOW+100,submitted_at:NOW+60_100,source:'server'});
    db.close();
  });

  test('skip is idempotent, leaves learning state and capacity unchanged, and allows the same material to return',()=>{
    const db=createNewAlgorithmDb();seed(db);
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('encode-skip',1,'both','encode',1,1,'ready','{}','{}','{}','{}','{}',1)").run();
    const task=getOrIssueNewAlgorithmTask(db,NOW);
    expect(endNewAlgorithmTask(db,{instanceId:task.instanceId,action:'skip',now:NOW+1})).toEqual({status:'skipped',replay:false});
    expect(endNewAlgorithmTask(db,{instanceId:task.instanceId,action:'skip',now:NOW+2})).toEqual({status:'skipped',replay:true});
    expect(db.prepare('SELECT score_r,score_p,introduced,last_tick_any FROM words WHERE id=1').get()).toEqual({score_r:0,score_p:0,introduced:0,last_tick_any:null});
    expect(db.prepare('SELECT completed FROM daily_capacity').get().completed).toBe(0);
    expect(db.prepare("SELECT count(*) n FROM events WHERE event_type='task_skipped'").get().n).toBe(1);
    expect(getOrIssueNewAlgorithmTask(db,NOW+3)).toMatchObject({wordId:1,axis:'both',stage:'encode'});
    db.close();
  });

  test('skip, exit, and submission race have exactly one winning terminal state',()=>{
    const db=createNewAlgorithmDb();seed(db);
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('encode-race',1,'both','encode',1,1,'ready','{}','{}','{}','{}','{}',1)").run();
    const task=getOrIssueNewAlgorithmTask(db,NOW);
    endNewAlgorithmTask(db,{instanceId:task.instanceId,action:'exit',now:NOW+1});
    expect(()=>endNewAlgorithmTask(db,{instanceId:task.instanceId,action:'skip',now:NOW+2})).toThrow(NewAlgorithmTaskError);
    expect(()=>submitNewAlgorithmTaskResponse(db,{instanceId:task.instanceId,response:{confirmed:true},now:NOW+3})).toThrow(NewAlgorithmTaskError);
    expect(db.prepare("SELECT status FROM task_instances WHERE instance_id=?").get(task.instanceId).status).toBe('exited');
    expect(db.prepare("SELECT event_type FROM events WHERE instance_id=?").all(task.instanceId).map(x=>x.event_type)).toEqual(['task_exit']);
    db.close();
  });

  test('returns an explicit empty result when ready material is unavailable',()=>{
    const db=createNewAlgorithmDb();seed(db,{introduced:1,scoreR:0,scoreP:5,taskCount:3});
    expect(getOrIssueNewAlgorithmTask(db,NOW)).toEqual({type:'EMPTY',reason:'material_pending',nextAvailableAt:null});
    expect(db.prepare('SELECT count(*) n FROM task_instances').get().n).toBe(0);
    db.close();
  });

  test('reports cooldown only for candidates with an available reservation and ready material',()=>{
    const db=createNewAlgorithmDb();seed(db,{introduced:1,scoreR:0,scoreP:20,taskCount:3});
    db.prepare('UPDATE words SET last_ts_any=?,last_tick_any=0 WHERE id=1').run(NOW-5*60*1000);
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('choice-r-cooldown',1,'r','choice',1,1,'ready','{\"options\":[\"a\",\"b\"]}','{\"correct_index\":0}','{}','{}','{}',1)").run();
    expect(getOrIssueNewAlgorithmTask(db,NOW)).toEqual({type:'EMPTY',reason:'cooldown_wait',nextAvailableAt:null});
    db.close();
    const unavailable=createNewAlgorithmDb();seed(unavailable,{introduced:1,scoreR:0,scoreP:20,taskCount:3});
    unavailable.prepare('UPDATE words SET last_ts_any=?,last_tick_any=0 WHERE id=1').run(NOW-5*60*1000);
    expect(getOrIssueNewAlgorithmTask(unavailable,NOW)).toEqual({type:'EMPTY',reason:'material_pending',nextAvailableAt:null});
    unavailable.close();
  });

  test('does not issue outside the configured local training window',()=>{
    const db=createNewAlgorithmDb();seed(db);
    db.prepare("UPDATE meta SET value='11:00' WHERE key='training_window_start:Asia/Shanghai'").run();
    db.prepare("UPDATE meta SET value='20:00' WHERE key='training_window_end:Asia/Shanghai'").run();
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('encode-window',1,'both','encode',1,1,'ready','{\"text\":\"word\"}','{}','{}','{}','{}',1)").run();
    expect(getOrIssueNewAlgorithmTask(db,NOW)).toEqual({type:'EMPTY',reason:'training_window_closed',nextAvailableAt:Date.parse('2026-11-07T03:00:00.000Z')});
    expect(db.prepare('SELECT count(*) n FROM task_instances').get().n).toBe(0);
    db.close();
  });

  test('HTTP route uses a temporary isolated DB for GET and POST',async()=>{
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'flow-new-task-api-'));
    const filename=path.join(directory,'prototype.db');
    const previous=process.env.FLOW_NEW_ALGORITHM_DB;
    process.env.FLOW_NEW_ALGORITHM_DB=filename;
    delete global.__newAlgorithmDb;
    const db=runtimeDb.getNewAlgorithmDb();
    const now=Date.now();
    const clock=jest.spyOn(Date,'now').mockReturnValue(now);
    const date=new Intl.DateTimeFormat('en-US',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
    const local=`${date.find(x=>x.type==='year').value}-${date.find(x=>x.type==='month').value}-${date.find(x=>x.type==='day').value}`;
    db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,local_timezone,created_at,due_at_r,due_at_p) VALUES(1,'word','gloss',80,80,'UTC',? ,?,?)").run(now,new Date(now).toISOString(),new Date(now).toISOString());
    db.prepare('INSERT INTO daily_capacity(local_date,timezone,capacity,completed) VALUES(?,?,9,0)').run(local,'UTC');
    db.prepare("INSERT INTO meta(key,value) VALUES('training_window_start:UTC','00:00'),('training_window_end:UTC','23:59')").run();
    db.prepare("INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count) VALUES('intro-api',1,'both',?,'UTC','introduction',9)").run(local);
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('encode-api',1,'both','encode',1,1,'ready','{\"text\":\"gloss\"}','{}','{}','{}','{}',?)").run(now);
    try {
      const get=await taskRoute.GET();
      expect(get.status).toBe(200);
      const issued=await get.json();
      expect(issued).toMatchObject({type:'ENCODE',axis:'both'});
      const recovered=await taskRoute.GET(new Request(`http://localhost/api/new-algorithm/task?instanceId=${issued.instanceId}`));
      expect(await recovered.json()).toMatchObject({instanceId:issued.instanceId,axis:'both'});
      const post=await taskRoute.POST(new Request('http://localhost/api/new-algorithm/task',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({instanceId:issued.instanceId,response:{confirmed:true}})}));
      expect(post.status).toBe(200);
      expect(db.prepare('SELECT score_r,score_p FROM words WHERE id=1').get()).toEqual({score_r:5,score_p:5});
      const replay=await taskRoute.POST(new Request('http://localhost/api/new-algorithm/task',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({instanceId:issued.instanceId,response:{confirmed:true}})}));
      expect(await replay.json()).toMatchObject({replay:true,settlement:{tick:1}});
    } finally {
      clock.mockRestore();db.close();delete global.__newAlgorithmDb;
      if(previous===undefined)delete process.env.FLOW_NEW_ALGORITHM_DB;else process.env.FLOW_NEW_ALGORITHM_DB=previous;
      fs.rmSync(directory,{recursive:true,force:true});
    }
  });
});
