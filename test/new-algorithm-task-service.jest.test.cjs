const {createNewAlgorithmDb}=require('../lib/new-algorithm-db');
const {getOrIssueNewAlgorithmTask,submitNewAlgorithmTaskResponse,NewAlgorithmTaskError}=require('../lib/new-algorithm-task-service');
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
      const post=await taskRoute.POST(new Request('http://localhost/api/new-algorithm/task',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({instanceId:issued.instanceId,response:{confirmed:true}})}));
      expect(post.status).toBe(200);
      expect(db.prepare('SELECT score_r,score_p FROM words WHERE id=1').get()).toEqual({score_r:5,score_p:5});
    } finally {
      clock.mockRestore();db.close();delete global.__newAlgorithmDb;
      if(previous===undefined)delete process.env.FLOW_NEW_ALGORITHM_DB;else process.env.FLOW_NEW_ALGORITHM_DB=previous;
      fs.rmSync(directory,{recursive:true,force:true});
    }
  });
});
