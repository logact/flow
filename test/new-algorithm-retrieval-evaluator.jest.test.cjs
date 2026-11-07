const {gradeRetrieval,normalizePAnswer,validateRetrievalMaterial,InvalidRetrievalMaterialError,generateNewAlgorithmRetrievalMaterial,toRetrievalSettlementDecision,gradeAndSettleFrozenRetrievalAttempt}=require('../lib/new-algorithm-retrieval-evaluator');
const {createNewAlgorithmDb}=require('../lib/new-algorithm-db');

function material(axis,stage){
  const base={axis,stage,publicPayload:{prompt:`${axis}-${stage} prompt`},gradingRequirements:{}};
  if(stage==='choice')return {...base,publicPayload:{...base.publicPayload,options:['first','second']},answerKey:{correct_index:1}};
  if(axis==='r')return {...base,answerKey:{target_meaning:'the intended sense'}};
  return {...base,answerKey:{target_form:'carry',allowed_inflections:['carries','carried','carrying']}};
}

function frozenAttemptDb(){
  const db=createNewAlgorithmDb();
  db.prepare(`INSERT INTO words(id,term,meaning,target_r,target_p,score_r,score_p,introduced,due_at_r,due_at_p,local_timezone,created_at)
    VALUES(1,'word','sense',80,80,20,5,1,'2026-11-07T00:00:00.000Z','2026-11-07T00:00:00.000Z','Asia/Shanghai',1)`).run();
  db.prepare("INSERT INTO daily_capacity(local_date,timezone,capacity,completed) VALUES('2026-11-07','Asia/Shanghai',9,0)").run();
  db.prepare("INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES('intro:1',1,'both','2026-11-07','Asia/Shanghai','introduction',5,'active')").run();
  db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('cued-r',1,'r','cued',1,1,'ready','{\"prompt\":\"Explain the word\"}','{\"target_meaning\":\"sense\"}','{}','{}','{}',1)").run();
  db.prepare(`INSERT INTO task_instances(instance_id,definition_id,word_id,axis,type,stage,purpose,score_before,material_id,material_version,meaning_version,snapshot_json,status,issued_at)
    VALUES('instance-r','retrieve-r',1,'r','RETRIEVE','cued','introduce',20,'cued-r',1,1,'{\"capacity_reservation_id\":\"intro:1\"}','grading',2)`).run();
  db.prepare("INSERT INTO attempts(attempt_id,instance_id,response_json,timing_json,exposure_json,status,created_at) VALUES('attempt-r','instance-r','{\"answer\":\"synonym\"}','{}','{}','frozen',2)").run();
  return db;
}

describe('new algorithm retrieval material contracts',()=>{
  test.each([['r','choice'],['r','cued'],['r','free'],['p','choice'],['p','cued'],['p','free']])('validates the %s/%s frozen material contract without inventing content',(axis,stage)=>{
    expect(validateRetrievalMaterial(material(axis,stage))).toMatchObject({axis,stage});
  });

  test.each([['r','choice'],['p','choice']])('%s choice grades only the frozen correct index',(axis,stage)=>{
    const frozen=material(axis,stage);
    expect(gradeRetrieval({material:frozen,response:{selected_index:1}})).resolves.toEqual({kind:'pass'});
    expect(gradeRetrieval({material:frozen,response:{selected_index:0}})).resolves.toEqual({kind:'fail'});
  });

  test('R cued/free use the injected meaning judge and preserve uncertain/service errors',async()=>{
    const frozen=material('r','cued');
    const calls=[];
    const pass=await gradeRetrieval({material:frozen,response:{answer:'a natural synonym'},semanticEvaluator:async input=>{calls.push(input);return {kind:'pass'};}});
    expect(pass).toEqual({kind:'pass'});
    expect(calls[0]).toMatchObject({axis:'r',targetMeaning:'the intended sense',response:'a natural synonym'});
    expect(await gradeRetrieval({material:material('r','free'),response:{answer:'ambiguous'},semanticEvaluator:()=>({kind:'uncertain',reason:'ambiguous'})})).toEqual({kind:'uncertain',reason:'ambiguous'});
    expect(await gradeRetrieval({material:frozen,response:{answer:'valid'},semanticEvaluator:()=>{throw Error('offline');}})).toEqual({kind:'service_error',reason:'SEMANTIC_EVALUATOR_FAILED'});
    expect(await gradeRetrieval({material:frozen,response:{answer:'valid'} })).toEqual({kind:'service_error',reason:'SEMANTIC_EVALUATOR_UNAVAILABLE'});
  });

  test.each([
    [{kind:'pass'},{action:'settle',judgment:{kind:'retrieval',passed:true}}],
    [{kind:'fail'},{action:'settle',judgment:{kind:'retrieval',passed:false}}],
    [{kind:'uncertain',reason:'ambiguous'},{action:'retry',reason:'ambiguous'}],
    [{kind:'service_error',reason:'offline'},{action:'retry',reason:'offline'}],
  ])('maps %s without converting retryable outcomes into failures',(grade,expected)=>{
    expect(toRetrievalSettlementDecision(grade)).toEqual(expected);
  });

  test('uncertain result persists retry without state change, then a pass settles and exact replay returns the saved result',async()=>{
    const db=frozenAttemptDb();
    const uncertain=await gradeAndSettleFrozenRetrievalAttempt(db,{instanceId:'instance-r',attemptId:'attempt-r',now:Date.parse('2026-11-07T03:00:00Z'),semanticEvaluator:()=>({kind:'uncertain',reason:'ambiguous'})});
    expect(uncertain).toMatchObject({action:'retry',grade:{kind:'uncertain'},attempts:1});
    expect(db.prepare('SELECT score_r,score_p FROM words WHERE id=1').get()).toEqual({score_r:20,score_p:5});
    expect(db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value).toBe('0');
    expect(db.prepare('SELECT task_count,status FROM capacity_reservations').get()).toEqual({task_count:5,status:'active'});
    expect(db.prepare('SELECT status,grading_attempts FROM attempts WHERE attempt_id=\'attempt-r\'').get()).toEqual({status:'grading_retry',grading_attempts:1});
    expect(db.prepare('SELECT status FROM task_instances WHERE instance_id=\'instance-r\'').get().status).toBe('grading_retry');
    expect(db.prepare("SELECT count(*) n FROM events WHERE event_type='grading_retry'").get().n).toBe(1);
    const settled=await gradeAndSettleFrozenRetrievalAttempt(db,{instanceId:'instance-r',attemptId:'attempt-r',now:Date.parse('2026-11-07T03:01:00Z'),semanticEvaluator:()=>({kind:'pass'})});
    expect(settled).toMatchObject({action:'settled',grade:{kind:'pass'},settlement:{scoreAfter:40,replay:false}});
    expect(db.prepare('SELECT score_r,score_p FROM words WHERE id=1').get()).toEqual({score_r:40,score_p:5});
    const replay=await gradeAndSettleFrozenRetrievalAttempt(db,{instanceId:'instance-r',attemptId:'attempt-r',now:Date.parse('2026-11-07T03:02:00Z')});
    expect(replay).toMatchObject({action:'settled',grade:{kind:'pass'},settlement:{scoreAfter:40,replay:true},replay:true});
    expect(db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value).toBe('1');
    db.close();
  });

  test('service error persists retry event but changes no score, tick, or capacity',async()=>{
    const db=frozenAttemptDb();
    const result=await gradeAndSettleFrozenRetrievalAttempt(db,{instanceId:'instance-r',attemptId:'attempt-r',now:Date.parse('2026-11-07T03:00:00Z'),semanticEvaluator:()=>{throw Error('offline');}});
    expect(result).toMatchObject({action:'retry',grade:{kind:'service_error'},attempts:1});
    expect(db.prepare('SELECT score_r,score_p FROM words WHERE id=1').get()).toEqual({score_r:20,score_p:5});
    expect(db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value).toBe('0');
    expect(db.prepare('SELECT completed FROM daily_capacity').get().completed).toBe(0);
    expect(db.prepare('SELECT task_count,status FROM capacity_reservations').get()).toEqual({task_count:5,status:'active'});
    expect(db.prepare("SELECT count(*) n FROM events WHERE event_type='grading_retry'").get().n).toBe(1);
    db.close();
  });

  test('does not invoke semantic evaluator after the two-attempt retry bound',async()=>{
    const db=frozenAttemptDb();let calls=0;
    const evaluator=()=>{calls++;return {kind:'uncertain',reason:'ambiguous'};};
    await gradeAndSettleFrozenRetrievalAttempt(db,{instanceId:'instance-r',attemptId:'attempt-r',now:Date.parse('2026-11-07T03:00:00Z'),semanticEvaluator:evaluator});
    await gradeAndSettleFrozenRetrievalAttempt(db,{instanceId:'instance-r',attemptId:'attempt-r',now:Date.parse('2026-11-07T03:01:00Z'),semanticEvaluator:evaluator});
    expect(calls).toBe(2);
    const third=await gradeAndSettleFrozenRetrievalAttempt(db,{instanceId:'instance-r',attemptId:'attempt-r',now:Date.parse('2026-11-07T03:02:00Z'),semanticEvaluator:evaluator});
    expect(third).toMatchObject({action:'retry',attempts:2,grade:{kind:'service_error',reason:'GRADING_RETRY_LIMIT'}});
    expect(calls).toBe(2);
    expect(db.prepare('SELECT score_r FROM words WHERE id=1').get().score_r).toBe(20);
    expect(db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value).toBe('0');
    db.close();
  });

  test('P ignores only case and outer whitespace and honors an explicit inflection allowlist',async()=>{
    const frozen=material('p','free');
    expect(normalizePAnswer('  CARRY  ')).toBe('carry');
    expect(await gradeRetrieval({material:frozen,response:{answer:'  CARRY  '}})).toEqual({kind:'pass'});
    expect(await gradeRetrieval({material:frozen,response:{answer:'carried'}})).toEqual({kind:'pass'});
    expect(await gradeRetrieval({material:frozen,response:{answer:'car ry'}})).toEqual({kind:'fail'});
    expect(await gradeRetrieval({material:frozen,response:{answer:'carry!'}})).toEqual({kind:'fail'});
  });

  test('producer wrapper validates a provider draft before making it ready',async()=>{
    const db=createNewAlgorithmDb();
    db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,local_timezone,created_at) VALUES(1,'word','sense',80,80,'UTC',1)").run();
    const draft={publicPayload:{prompt:'Describe the action'},answerKey:{target_form:'carry',allowed_inflections:['carried']},gradingRequirements:{},timingProtocol:{protocol:'none'},validation:{source:'fixture'}};
    const result=await generateNewAlgorithmRetrievalMaterial(db,{wordId:1,axis:'p',stage:'free',version:1,meaningVersion:1,now:2},async()=>draft);
    expect(result).toMatchObject({status:'ready',attempts:1});
    expect(db.prepare('SELECT status,generation_attempts FROM materials').get()).toEqual({status:'ready',generation_attempts:1});
    db.close();
  });

  test('producer retries a malformed draft once and becomes ready only after validation',async()=>{
    const db=createNewAlgorithmDb();db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,local_timezone,created_at) VALUES(1,'word','sense',80,80,'UTC',1)").run();
    let calls=0;
    const bad={publicPayload:{prompt:'Pick',options:['same',' SAME ']},answerKey:{correct_index:0},gradingRequirements:{},timingProtocol:{},validation:{}};
    const good={publicPayload:{prompt:'Pick',options:['sense A','sense B']},answerKey:{correct_index:1},gradingRequirements:{},timingProtocol:{},validation:{}};
    const result=await generateNewAlgorithmRetrievalMaterial(db,{wordId:1,axis:'r',stage:'choice',version:1,meaningVersion:1,now:2},async()=>++calls===1?bad:good);
    expect(result).toMatchObject({status:'ready',attempts:2});
    expect(calls).toBe(2);
    db.close();
  });

  test('producer fails closed after two invalid drafts and never marks material ready',async()=>{
    const db=createNewAlgorithmDb();db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,local_timezone,created_at) VALUES(1,'word','sense',80,80,'UTC',1)").run();
    const result=await generateNewAlgorithmRetrievalMaterial(db,{wordId:1,axis:'p',stage:'cued',version:1,meaningVersion:1,now:2},async()=>({publicPayload:{prompt:'Use carry'},answerKey:{target_form:'carry',allowed_inflections:[]},gradingRequirements:{},timingProtocol:{},validation:{}}));
    expect(result).toMatchObject({status:'failed',attempts:2,reason:'P_TARGET_FORM_LEAK'});
    expect(db.prepare('SELECT status,generation_attempts FROM materials').get()).toEqual({status:'failed',generation_attempts:2});
    db.close();
  });

  test.each([
    [{axis:'r',stage:'choice',publicPayload:{prompt:'x',options:['a','b']},answerKey:{correct_index:2},gradingRequirements:{}},'CHOICE_KEY_INVALID'],
    [{axis:'r',stage:'choice',publicPayload:{prompt:'x',options:[' Meaning ','meaning']},answerKey:{correct_index:0},gradingRequirements:{}},'CHOICE_OPTIONS_DUPLICATE'],
    [{axis:'p',stage:'free',publicPayload:{prompt:'x'},answerKey:{target_form:'go'},gradingRequirements:{}},'P_INFLECTION_ALLOWLIST_REQUIRED'],
    [{axis:'r',stage:'free',publicPayload:{prompt:'x',answer_index:1},answerKey:{target_meaning:'sense'},gradingRequirements:{}},'PUBLIC_ANSWER_LEAK'],
    [{axis:'p',stage:'cued',publicPayload:{prompt:'x',options:['a','b']},answerKey:{target_form:'go',allowed_inflections:[]},gradingRequirements:{}},'NON_CHOICE_OPTIONS_FORBIDDEN'],
    [{axis:'p',stage:'free',publicPayload:{prompt:'Use the word carry in your answer'},answerKey:{target_form:'carry',allowed_inflections:['carries']},gradingRequirements:{}},'P_TARGET_FORM_LEAK'],
  ])('fails closed for malformed material with %s', async (value,reason)=>{
    expect(()=>validateRetrievalMaterial(value)).toThrow(new InvalidRetrievalMaterialError(reason));
    await expect(gradeRetrieval({material:value,response:{answer:'x'}})).resolves.toMatchObject({kind:'service_error',reason});
  });
});
