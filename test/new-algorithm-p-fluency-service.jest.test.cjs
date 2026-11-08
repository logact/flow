const {createNewAlgorithmDb}=require('../lib/new-algorithm-db');
const {getOrIssueNewAlgorithmTask,startNewAlgorithmPWriting,interruptNewAlgorithmPWriting,submitNewAlgorithmFluencyAnswer}=require('../lib/new-algorithm-task-service');

const NOW=Date.parse('2026-11-07T02:00:00Z');

function issuePTask() {
  const db=createNewAlgorithmDb();
  db.prepare(`INSERT INTO words(id,term,meaning,target_r,target_p,score_r,score_p,introduced,fluency_pass_r,learning_complete_r,review_level_r,due_at_r,due_at_p,local_timezone,created_at)
    VALUES(1,'target','confirmed target meaning',80,100,80,80,1,1,1,1,'2026-11-08T00:00:00.000Z','2026-11-07T00:00:00.000Z','Asia/Shanghai',1)`).run();
  db.prepare("INSERT INTO daily_capacity(local_date,timezone,capacity,completed) VALUES('2026-11-07','Asia/Shanghai',10,0)").run();
  db.prepare("INSERT INTO meta(key,value) VALUES('training_window_start:Asia/Shanghai','00:00'),('training_window_end:Asia/Shanghai','23:59')").run();
  db.prepare("INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES('p-due',1,'p','2026-11-07','Asia/Shanghai','determined',1,'active')").run();
  db.prepare(`INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at)
    VALUES('p-fluency',1,'p','fluency',1,1,'ready','{"scene_zh":"旅途中遇到变化","instructions_zh":"用英文讲述如何处理"}','{"sample":"private"}','{"target_form":"targetform","forbidden_target_forms":[]}','{}','{}',1)`).run();
  const task=getOrIssueNewAlgorithmTask(db,NOW);
  if(task.type!=='FLUENCY'||task.axis!=='p')throw new Error(`Expected P FLUENCY, got ${JSON.stringify(task)}`);
  return {db,task};
}

const writing=()=>Array.from({length:30},(_,i)=>`word${i}`).join(' ');

async function submitAtPace(wpm,{targetPassed=true,overallPassed=true}={}) {
  const {db,task}=issuePTask();
  const startedAt=NOW+1_000;
  startNewAlgorithmPWriting(db,{instanceId:task.instanceId,now:startedAt});
  const elapsedSeconds=1_800/wpm;
  const submittedAt=startedAt+Math.round(elapsedSeconds*1000);
  const result=await submitNewAlgorithmFluencyAnswer(db,{instanceId:task.instanceId,now:submittedAt,response:{text:writing(),elapsed_seconds:0.001},pEvaluator:()=>({targetPassed,overallPassed,targetEvidence:'target expression used in context',overallEvidence:'the whole scene is recalled'})});
  const state=db.prepare('SELECT score_r,score_p,fluency_pass_p,learning_complete_p,review_level_p,due_at_p,due_at_r FROM words WHERE id=1').get();
  const timing=JSON.parse(db.prepare('SELECT timing_json FROM attempts WHERE instance_id=?').get(task.instanceId).timing_json);
  db.close();
  return {task,result,state,timing,elapsedSeconds:(submittedAt-startedAt)/1000};
}

describe('P fluency through formal task dispatch, server timing and settlement',()=>{
  test.each([
    [24,40],
    [25,60],
    [42.5,80],
    [60,100],
  ])('%s WPM computes P %s and leaves R state alone',async(wpm,expected)=>{
    const {task,result,state,timing,elapsedSeconds}=await submitAtPace(wpm);
    expect(task).toMatchObject({axis:'p',type:'FLUENCY',stage:'fluency'});
    expect(result.settlement.scoreBefore).toBe(80);
    expect(result.settlement.scoreAfter).toBeCloseTo(expected,1);
    expect(state.score_r).toBe(80);
    expect(state.due_at_r).toBe('2026-11-08T00:00:00.000Z');
    expect(timing).toMatchObject({elapsed_seconds:elapsedSeconds,started_at:NOW+1_000,submitted_at:NOW+1_000+Math.round(1_800/wpm*1000),source:'server'});
    expect(timing.elapsed_seconds).not.toBe(0.001);
    if(expected===100)expect(state).toMatchObject({score_p:100,fluency_pass_p:1,learning_complete_p:1,review_level_p:1,due_at_p:'2026-11-07T16:00:00.000Z'});
    else expect(state).toMatchObject({fluency_pass_p:0,learning_complete_p:0,review_level_p:null});
  });

  test('target failure drops P to 40; overall-only failure leaves P unchanged',async()=>{
    const targetFailure=await submitAtPace(60,{targetPassed:false,overallPassed:true});
    expect(targetFailure.result.settlement).toMatchObject({scoreBefore:80,scoreAfter:40});
    const overallFailure=await submitAtPace(60,{targetPassed:true,overallPassed:false});
    expect(overallFailure.result.settlement).toMatchObject({scoreBefore:80,scoreAfter:80});
  });

  test('interruption clears the active start and a restart excludes the interrupted interval',async()=>{
    const {db,task}=issuePTask();
    startNewAlgorithmPWriting(db,{instanceId:task.instanceId,now:NOW+1_000});
    expect(interruptNewAlgorithmPWriting(db,{instanceId:task.instanceId,now:NOW+6_000})).toEqual({interrupted:true});
    const restartedAt=NOW+30_000;
    startNewAlgorithmPWriting(db,{instanceId:task.instanceId,now:restartedAt});
    const submittedAt=restartedAt+72_000;
    const result=await submitNewAlgorithmFluencyAnswer(db,{instanceId:task.instanceId,now:submittedAt,response:{text:writing(),elapsed_seconds:0.01},pEvaluator:()=>({targetPassed:true,overallPassed:true,targetEvidence:'target used',overallEvidence:'scene recalled'})});
    const timing=JSON.parse(db.prepare('SELECT timing_json FROM attempts WHERE instance_id=?').get(task.instanceId).timing_json);
    expect(result.settlement.scoreAfter).toBeCloseTo(60,5);
    expect(timing).toMatchObject({started_at:restartedAt,submitted_at:submittedAt,elapsed_seconds:72,source:'server'});
    db.close();
  });

  test('grading retry reuses the first server duration and exact response',async()=>{
    const {db,task}=issuePTask();
    const startedAt=NOW+1_000,submittedAt=startedAt+30_000,response={text:writing(),elapsed_seconds:9999};
    startNewAlgorithmPWriting(db,{instanceId:task.instanceId,now:startedAt});
    const first=await submitNewAlgorithmFluencyAnswer(db,{instanceId:task.instanceId,response,now:submittedAt,pEvaluator:()=>{throw Error('provider offline');}});
    expect(first).toMatchObject({action:'retry',grade:{kind:'service_error'}});
    const frozenTiming=db.prepare('SELECT timing_json FROM attempts WHERE instance_id=?').get(task.instanceId).timing_json;
    const replay=await submitNewAlgorithmFluencyAnswer(db,{instanceId:task.instanceId,response,now:submittedAt+90_000,pEvaluator:()=>({targetPassed:true,overallPassed:true,targetEvidence:'target used',overallEvidence:'scene recalled'})});
    expect(replay).toMatchObject({action:'settled',settlement:{scoreBefore:80,scoreAfter:100}});
    expect(db.prepare('SELECT timing_json FROM attempts WHERE instance_id=?').get(task.instanceId).timing_json).toBe(frozenTiming);
    expect(db.prepare('SELECT score_p FROM words WHERE id=1').get().score_p).toBe(100);
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE instance_id=? AND event_type='completed'").get(task.instanceId).n).toBe(1);
    db.close();
  });
});
