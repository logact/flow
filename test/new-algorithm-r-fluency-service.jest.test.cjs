const {createNewAlgorithmDb}=require('../lib/new-algorithm-db');
const {getOrIssueNewAlgorithmTask,submitNewAlgorithmFluencyAnswer}=require('../lib/new-algorithm-task-service');

const NOW=Date.parse('2026-11-07T02:00:00Z');

function issueRTask(scoreR=80,scoreP=35) {
  const db=createNewAlgorithmDb();
  db.prepare(`INSERT INTO words(id,term,meaning,target_r,target_p,score_r,score_p,introduced,due_at_r,local_timezone,created_at)
    VALUES(1,'target','confirmed target meaning',100,80,?,?,1,'2026-11-07T00:00:00.000Z','Asia/Shanghai',1)`).run(scoreR,scoreP);
  db.prepare("INSERT INTO daily_capacity(local_date,timezone,capacity,completed) VALUES('2026-11-07','Asia/Shanghai',5,0)").run();
  db.prepare("INSERT INTO meta(key,value) VALUES('training_window_start:Asia/Shanghai','00:00'),('training_window_end:Asia/Shanghai','23:59')").run();
  db.prepare("INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES('r-due',1,'r','2026-11-07','Asia/Shanghai','determined',1,'active')").run();
  const passage=Array(100).fill('target').join(' ');
  db.prepare(`INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at)
    VALUES('r-fluency',1,'r','fluency',1,1,'ready',?,'{"questions":[{"answer":"one","evidence":"line one"},{"answer":"two","evidence":"line two"}]}','{"targetMeaning":"confirmed target meaning","targetForms":["target"]}','{}','{}',1)`)
    .run(JSON.stringify({passage,questions:[{prompt:'Question one?'},{prompt:'Question two?'}]}));
  const task=getOrIssueNewAlgorithmTask(db,NOW);
  if(task.type!=='FLUENCY')throw new Error(`Expected FLUENCY, got ${JSON.stringify(task)}`);
  return {db,task};
}

async function submitAtWpm(wpm,{targetPassed=true,overallPassed=true}={}) {
  const {db,task}=issueRTask();
  const readMs=Math.round(6_000_000/wpm);
  const started=NOW+1,ended=started+readMs,submitted=ended+10_000;
  const result=await submitNewAlgorithmFluencyAnswer(db,{instanceId:task.instanceId,now:submitted,response:{
    answers:['answer one','answer two'],
    timing_protocol:[{type:'read_start',at:started},{type:'read_end',at:ended},{type:'answer_start',at:ended},{type:'answer_submit',at:submitted}],
    timing_valid:true,reading_seconds:readMs/1000,wpm,
  },rEvaluator:()=>({kind:'valid',targetPassed,overallPassed})});
  const state=db.prepare('SELECT score_r,score_p,fluency_pass_r,learning_complete_r,review_level_r,due_at_r FROM words WHERE id=1').get();
  const timing=JSON.parse(db.prepare('SELECT timing_json FROM attempts WHERE instance_id=?').get(task.instanceId).timing_json);
  db.close();
  return {result,state,timing};
}

describe('R fluency through formal task dispatch, timing replay and settlement',()=>{
  test.each([
    [149,40],
    [150,60],
    [200,73.33333333333333],
    [225,79.999],
    [300,100],
  ])('%s WPM computes R %s from the frozen 100-word material and leaves P unchanged',async(wpm,expected)=>{
    const {result,state,timing}=await submitAtWpm(wpm);
    expect(result.action).toBe('settled');
    expect(result.settlement.scoreBefore).toBe(80);
    expect(result.settlement.scoreAfter).toBeCloseTo(expected,2);
    expect(state.score_r).toBeCloseTo(expected,2);
    expect(state.score_p).toBe(35);
    expect(timing.valid).toBe(true);
    expect(timing.wpm).toBeCloseTo(wpm,1);
    if(wpm===300)expect(state).toMatchObject({fluency_pass_r:1,learning_complete_r:1,review_level_r:1,due_at_r:'2026-11-07T16:00:00.000Z'});
    else expect(state).toMatchObject({fluency_pass_r:0,learning_complete_r:0,review_level_r:null});
  });

  test('target failure sets R to 40; overall-only failure keeps the score and still records a valid attempt',async()=>{
    const targetFailure=await submitAtWpm(200,{targetPassed:false,overallPassed:true});
    expect(targetFailure.result.settlement).toMatchObject({scoreBefore:80,scoreAfter:40});
    expect(targetFailure.state).toMatchObject({score_r:40,score_p:35,fluency_pass_r:0,learning_complete_r:0});
    const overallFailure=await submitAtWpm(200,{targetPassed:true,overallPassed:false});
    expect(overallFailure.result.settlement).toMatchObject({scoreBefore:80,scoreAfter:80});
    expect(overallFailure.state).toMatchObject({score_r:80,score_p:35});
  });
});
