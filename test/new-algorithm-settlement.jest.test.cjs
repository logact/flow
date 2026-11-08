const {createNewAlgorithmDb}=require('../lib/new-algorithm-db');
const {settleNewAlgorithmAttempt,updateNewAlgorithmTargets}=require('../lib/new-algorithm-settlement');
const {getScheduleDecision}=require('../lib/new-algorithm-scheduler');

function fixture({axis='both',type='ENCODE',stage='encode',purpose='introduce',score=0,scoreR=0,scoreP=0,targetR=80,targetP=80,reviewR=null,reviewP=null,dueR=null,dueP=null,taskCount=9,reservationKind='introduction',reservationAxis='both',snapshotId='reservation-1'}={}) {
  const db=createNewAlgorithmDb();
  db.prepare(`INSERT INTO words(id,term,meaning,target_r,target_p,score_r,score_p,introduced,fluency_pass_r,fluency_pass_p,learning_complete_r,learning_complete_p,review_level_r,review_level_p,graduated_r,graduated_p,due_at_r,due_at_p,local_timezone,created_at)
    VALUES(1,'word','gloss',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(targetR,targetP,scoreR,scoreP,axis==='both'?0:1,reviewR===null?0:1,reviewP===null?0:1,reviewR===null?0:1,reviewP===null?0:1,reviewR,reviewP,0,0,dueR,dueP,'Asia/Shanghai');
  db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('material',1,?,?,1,1,'ready','{}','{}','{}','{}','{}',1)").run(axis,stage);
  db.prepare(`INSERT INTO task_instances(instance_id,definition_id,word_id,axis,type,stage,purpose,score_before,material_id,material_version,meaning_version,snapshot_json,status,issued_at)
    VALUES('instance','definition',1,?,?,?,?,?,'material',1,1,?,'grading',10)`).run(axis,type,stage,purpose,score,JSON.stringify(snapshotId?{capacity_reservation_id:snapshotId}:{}));
  db.prepare("INSERT INTO attempts(attempt_id,instance_id,response_json,timing_json,exposure_json,status,created_at) VALUES('attempt','instance','{}','{}','{}','frozen',10)").run();
  db.prepare("INSERT INTO daily_capacity(local_date,timezone,capacity,completed) VALUES('2026-11-08','Asia/Shanghai',20,0)").run();
  if(snapshotId) db.prepare(`INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status)
    VALUES(?,1,?,'2026-11-08','Asia/Shanghai',?,?, 'active')`).run(snapshotId,reservationAxis,reservationKind,taskCount);
  return db;
}

describe('database-backed new algorithm settlement',()=>{
  test('connection updates both axes, consumes its exact reservation and counts once on replay',()=>{
    const db=fixture();
    const input={instanceId:'instance',attemptId:'attempt',judgment:{kind:'encode'},exposedBeforeFeedback:false,now:Date.parse('2026-11-08T02:00:00Z')};
    expect(settleNewAlgorithmAttempt(db,input)).toMatchObject({status:'completed',scoreBefore:0,scoreAfter:5,tick:1,replay:false});
    expect(db.prepare('SELECT score_r,score_p,introduced,last_tick_any FROM words WHERE id=1').get()).toEqual({score_r:5,score_p:5,introduced:1,last_tick_any:1});
    expect(db.prepare('SELECT task_count,status FROM capacity_reservations').get()).toEqual({task_count:8,status:'active'});
    expect(db.prepare('SELECT completed FROM daily_capacity').get().completed).toBe(1);
    expect(settleNewAlgorithmAttempt(db,input)).toMatchObject({status:'completed',tick:1,replay:true});
    expect(db.prepare('SELECT task_count,status FROM capacity_reservations').get()).toEqual({task_count:8,status:'active'});
    expect(db.prepare('SELECT completed FROM daily_capacity').get().completed).toBe(1);
    db.close();
  });

  test('a task completed after local midnight moves capacity usage to the actual local day',()=>{
    const db=fixture();
    db.prepare("INSERT INTO daily_capacity(local_date,timezone,capacity,completed) VALUES('2026-11-09','Asia/Shanghai',2,0)").run();
    settleNewAlgorithmAttempt(db,{instanceId:'instance',attemptId:'attempt',judgment:{kind:'encode'},exposedBeforeFeedback:false,now:Date.parse('2026-11-08T17:00:00Z')});
    expect(db.prepare('SELECT local_date,completed FROM daily_capacity ORDER BY local_date').all()).toEqual([
      {local_date:'2026-11-08',completed:0},
      {local_date:'2026-11-09',completed:1},
    ]);
    expect(db.prepare('SELECT task_count,status FROM capacity_reservations').get()).toEqual({task_count:8,status:'active'});
    db.close();
  });

  test('a valid target-axis FLUENCY pass starts only that axis review schedule',()=>{
    const db=fixture({axis:'r',type:'FLUENCY',stage:'fluency',score:60,scoreR:60,scoreP:45,purpose:'introduce',taskCount:3,reservationAxis:'both'});
    const now=Date.parse('2026-11-08T02:00:00Z');
    settleNewAlgorithmAttempt(db,{instanceId:'instance',attemptId:'attempt',judgment:{kind:'fluency',result:{kind:'valid',targetPassed:true,overallPassed:true,wpm:225}},exposedBeforeFeedback:false,now});
    const word=db.prepare('SELECT score_r,score_p,fluency_pass_r,learning_complete_r,review_level_r,due_at_r,due_at_p FROM words WHERE id=1').get();
    expect(word.score_r).toBe(80);
    expect(word.score_p).toBe(45);
    expect(word.fluency_pass_r).toBe(1);
    expect(word.learning_complete_r).toBe(1);
    expect(word.review_level_r).toBe(1);
    expect(word.due_at_r).toBe('2026-11-08T16:00:00.000Z');
    expect(word.due_at_p).toBeNull();
    expect(db.prepare("SELECT axis,local_date,reservation_kind,task_count,status FROM capacity_reservations WHERE reservation_kind<>'introduction' ORDER BY local_date,reservation_kind").all()).toEqual([
      {axis:'r',local_date:'2026-11-09',reservation_kind:'determined',task_count:1,status:'active'},
      {axis:'r',local_date:'2026-11-12',reservation_kind:'conditional',task_count:1,status:'active'},
      {axis:'r',local_date:'2026-11-19',reservation_kind:'conditional',task_count:1,status:'active'},
      {axis:'r',local_date:'2026-12-19',reservation_kind:'conditional',task_count:1,status:'active'},
    ]);
    db.close();
  });

  test('review failure without score drop demotes the axis from actual settlement day',()=>{
    const db=fixture({axis:'r',type:'FLUENCY',stage:'fluency',purpose:'review',score:90,scoreR:90,scoreP:70,reviewR:3,reviewP:1,dueR:'2026-11-08T16:00:00.000Z',dueP:'2026-11-09T16:00:00.000Z',taskCount:1,reservationKind:'determined',reservationAxis:'r'});
    settleNewAlgorithmAttempt(db,{instanceId:'instance',attemptId:'attempt',judgment:{kind:'fluency',result:{kind:'valid',targetPassed:true,overallPassed:false,wpm:220}},exposedBeforeFeedback:false,now:Date.parse('2026-11-08T02:00:00Z')});
    expect(db.prepare('SELECT score_r,fluency_pass_r,learning_complete_r,review_level_r,due_at_r,due_at_p FROM words WHERE id=1').get()).toEqual({score_r:90,fluency_pass_r:1,learning_complete_r:1,review_level_r:1,due_at_r:'2026-11-08T16:00:00.000Z',due_at_p:'2026-11-09T16:00:00.000Z'});
    expect(db.prepare('SELECT task_count,status FROM capacity_reservations').get()).toEqual({task_count:1,status:'consumed'});
    expect(db.prepare("SELECT axis,local_date,reservation_kind,status FROM capacity_reservations WHERE reservation_kind<>'introduction' ORDER BY local_date,reservation_kind").all()).toEqual([
      {axis:'r',local_date:'2026-11-08',reservation_kind:'determined',status:'consumed'},
      {axis:'r',local_date:'2026-11-09',reservation_kind:'determined',status:'active'},
      {axis:'r',local_date:'2026-11-12',reservation_kind:'conditional',status:'active'},
      {axis:'r',local_date:'2026-11-19',reservation_kind:'conditional',status:'active'},
      {axis:'r',local_date:'2026-12-19',reservation_kind:'conditional',status:'active'},
    ]);
    db.prepare("INSERT INTO daily_capacity(local_date,timezone,capacity,completed) VALUES('2026-11-09','Asia/Shanghai',20,0)").run();
    db.prepare("INSERT INTO meta(key,value) VALUES('training_window_start:Asia/Shanghai','00:00'),('training_window_end:Asia/Shanghai','23:59')").run();
    expect(getScheduleDecision(db,{now:Date.parse('2026-11-09T02:00:00Z'),today:'2026-11-09',timezone:'Asia/Shanghai'})).toMatchObject({kind:'candidate',candidate:{wordId:1,axis:'r',kind:'review',dueDate:'2026-11-09'}});
    db.close();
  });

  test('review pass advances from level 30 to independent axis graduation',()=>{
    const db=fixture({axis:'r',type:'FLUENCY',stage:'fluency',purpose:'review',score:90,scoreR:90,scoreP:70,reviewR:30,reviewP:1,dueR:'2026-11-08T16:00:00.000Z',dueP:'2026-11-09T16:00:00.000Z',taskCount:1,reservationKind:'determined',reservationAxis:'r'});
    settleNewAlgorithmAttempt(db,{instanceId:'instance',attemptId:'attempt',judgment:{kind:'fluency',result:{kind:'valid',targetPassed:true,overallPassed:true,wpm:263}},exposedBeforeFeedback:false,now:Date.parse('2026-11-08T02:00:00Z')});
    expect(db.prepare('SELECT review_level_r,graduated_r,graduated,due_at_r,due_at_p FROM words WHERE id=1').get()).toEqual({review_level_r:30,graduated_r:1,graduated:0,due_at_r:null,due_at_p:'2026-11-09T16:00:00.000Z'});
    db.close();
  });

  test('raising one target above its score cancels only its review reservations and returns it to today',()=>{
    const db=fixture({axis:'r',type:'FLUENCY',stage:'fluency',purpose:'review',score:90,scoreR:90,scoreP:85,targetR:90,targetP:80,reviewR:3,reviewP:7,dueR:'2026-11-10T16:00:00.000Z',dueP:'2026-11-14T16:00:00.000Z',taskCount:1,reservationKind:'determined',reservationAxis:'r'});
    db.prepare("INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES('conditional-r',1,'r','2026-11-12','Asia/Shanghai','conditional',1,'active')").run();
    db.prepare("INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES('review-p',1,'p','2026-11-14','Asia/Shanghai','determined',1,'active')").run();
    db.prepare("UPDATE task_instances SET status='completed' WHERE instance_id='instance'").run();
    db.prepare("UPDATE attempts SET status='completed' WHERE attempt_id='attempt'").run();
    const changed=updateNewAlgorithmTargets(db,{wordId:1,targetR:95,targetP:80,now:Date.parse('2026-11-08T02:00:00Z')});
    expect(changed).toEqual({requeuedAxes:['r'],capacityBlockedAxes:[]});
    expect(db.prepare('SELECT target_r,fluency_pass_r,learning_complete_r,review_level_r,graduated_r,due_at_r,review_level_p,due_at_p FROM words WHERE id=1').get()).toEqual({target_r:95,fluency_pass_r:0,learning_complete_r:0,review_level_r:null,graduated_r:0,due_at_r:'2026-11-07T16:00:00.000Z',review_level_p:7,due_at_p:'2026-11-14T16:00:00.000Z'});
    expect(db.prepare('SELECT reservation_id,status FROM capacity_reservations ORDER BY reservation_id').all()).toEqual([{reservation_id:'conditional-r',status:'cancelled'},{reservation_id:'review-p',status:'active'},{reservation_id:'target-change:1:r:2026-11-08',status:'active'}]);
    db.prepare("INSERT INTO meta(key,value) VALUES('training_window_start:Asia/Shanghai','00:00'),('training_window_end:Asia/Shanghai','23:59')").run();
    expect(getScheduleDecision(db,{now:Date.parse('2026-11-08T02:00:00Z'),today:'2026-11-08',timezone:'Asia/Shanghai'})).toMatchObject({kind:'candidate',candidate:{wordId:1,axis:'r',dueDate:'2026-11-08'}});
    db.close();
  });

  test('target increase reports when another axis occupies all remaining daily capacity',()=>{
    const db=fixture({axis:'r',type:'FLUENCY',stage:'fluency',score:90,scoreR:90,scoreP:85,targetR:90,targetP:80,reviewR:3,reviewP:7,dueR:'2026-11-10T16:00:00.000Z',dueP:'2026-11-14T16:00:00.000Z',taskCount:1,reservationKind:'determined',reservationAxis:'r'});
    db.prepare("UPDATE daily_capacity SET capacity=1").run();
    db.prepare("INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES('other-axis-p',1,'p','2026-11-08','Asia/Shanghai','determined',1,'active')").run();
    db.prepare("UPDATE task_instances SET status='completed' WHERE instance_id='instance'").run();
    db.prepare("UPDATE attempts SET status='completed' WHERE attempt_id='attempt'").run();
    const changed=updateNewAlgorithmTargets(db,{wordId:1,targetR:95,targetP:80,now:Date.parse('2026-11-08T02:00:00Z')});
    expect(changed).toEqual({requeuedAxes:[],capacityBlockedAxes:['r']});
    expect(db.prepare('SELECT reservation_id,status FROM capacity_reservations ORDER BY reservation_id').all()).toEqual([{reservation_id:'other-axis-p',status:'active'},{reservation_id:'reservation-1',status:'cancelled'}]);
    db.close();
  });

  test('target change is rejected while an affected axis task is live',()=>{
    const db=fixture({axis:'r',type:'FLUENCY',stage:'fluency',score:90,scoreR:90});
    expect(()=>updateNewAlgorithmTargets(db,{wordId:1,targetR:95,targetP:80,now:Date.parse('2026-11-08T02:00:00Z')})).toThrow('task is active');
    expect(db.prepare('SELECT target_r FROM words WHERE id=1').get().target_r).toBe(80);
    db.close();
  });

  test('invalid FLUENCY does not consume capacity, change scores or advance tick',()=>{
    const db=fixture({axis:'r',type:'FLUENCY',stage:'fluency',score:60,scoreR:60,scoreP:45,taskCount:3,reservationAxis:'both'});
    const result=settleNewAlgorithmAttempt(db,{instanceId:'instance',attemptId:'attempt',judgment:{kind:'fluency',result:{kind:'invalid'}},exposedBeforeFeedback:false,now:Date.parse('2026-11-08T02:00:00Z')});
    expect(result).toEqual({status:'grading_retry',replay:false});
    expect(db.prepare('SELECT score_r,review_level_r,due_at_r FROM words WHERE id=1').get()).toEqual({score_r:60,review_level_r:null,due_at_r:null});
    expect(db.prepare('SELECT task_count,status FROM capacity_reservations').get()).toEqual({task_count:3,status:'active'});
    expect(db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value).toBe('0');
    db.close();
  });

  test('missing reservation link rolls back every settlement write',()=>{
    const db=fixture({snapshotId:null});
    expect(()=>settleNewAlgorithmAttempt(db,{instanceId:'instance',attemptId:'attempt',judgment:{kind:'encode'},exposedBeforeFeedback:false,now:Date.parse('2026-11-08T02:00:00Z')})).toThrow('capacity_reservation_id');
    expect(db.prepare('SELECT status FROM task_instances WHERE instance_id=\'instance\'').get().status).toBe('grading');
    expect(db.prepare('SELECT status FROM attempts WHERE attempt_id=\'attempt\'').get().status).toBe('frozen');
    expect(db.prepare('SELECT score_r,score_p,introduced FROM words WHERE id=1').get()).toMatchObject({score_r:0,score_p:0,introduced:0});
    expect(db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value).toBe('0');
    db.close();
  });
});
