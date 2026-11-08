const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const route = require('../app/api/new-algorithm/goals/route');
const runtimeDb = require('../lib/new-algorithm-runtime-db');
let filename;
let priorFilename;
let db;

describe('new algorithm goals API', () => {
  beforeEach(() => {
    filename=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'flow-goals-api-')),'isolated.db');
    priorFilename=process.env.FLOW_NEW_ALGORITHM_DB;
    process.env.FLOW_NEW_ALGORITHM_DB=filename;
    delete global.__newAlgorithmDb;
    db=runtimeDb.getNewAlgorithmDb();
  });
  afterEach(() => {
    db.close();
    delete global.__newAlgorithmDb;
    if(priorFilename===undefined) delete process.env.FLOW_NEW_ALGORITHM_DB; else process.env.FLOW_NEW_ALGORITHM_DB=priorFilename;
    fs.rmSync(path.dirname(filename),{recursive:true,force:true});
  });
  test('requires explicit timezone instead of silently using UTC', async () => {
    const response=await route.GET(new Request('http://localhost/api/new-algorithm/goals'));
    expect(response.status).toBe(400);
  });
  test('configures capacity/window without trusting client completed count', async () => {
    const response=await route.POST(new Request('http://localhost/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'configure',timezone:'Asia/Shanghai',capacity:9,completed:8,windowStart:'08:00',windowEnd:'23:00'})}));
    expect(response.status).toBe(200);
    expect(db.prepare('select capacity,completed from daily_capacity').get()).toEqual({capacity:9,completed:0});
  });
  test('rejects malformed configure and import requests without inserting words', async () => {
    const badConfig=await route.POST(new Request('http://localhost/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'configure',timezone:'bad-zone',capacity:9,windowStart:'08:00',windowEnd:'23:00'})}));
    expect(badConfig.status).toBe(400);
    const missingTimezone=await route.POST(new Request('http://localhost/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'import',words:[{term:'word',rank:1,vocabularySize:10}]})}));
    expect(missingTimezone.status).toBe(400);
    expect(db.prepare('select count(*) n from words').get().n).toBe(0);
  });
  test('API import fails closed when no capacity has been configured', async () => {
    const response=await route.POST(new Request('http://localhost/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'import',timezone:'Asia/Shanghai',words:[{term:'word',rank:1,vocabularySize:10}]})}));
    expect(response.status).toBe(409);
    expect(db.prepare('select count(*) n from words').get().n).toBe(0);
    expect(db.prepare('select count(*) n from capacity_reservations').get().n).toBe(0);
  });
  test('target action updates the selected axis and preserves the other target', async()=>{
    db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,local_timezone,created_at) VALUES(1,'word','gloss',80,70,'UTC',1)").run();
    const response=await route.POST(new Request('http://localhost/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'target',wordId:1,targetR:90,targetP:70})}));
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({ok:true,requeuedAxes:[],capacityBlockedAxes:[]});
    expect(db.prepare('SELECT target_r,target_p FROM words WHERE id=1').get()).toEqual({target_r:90,target_p:70});
  });
  test('target action rejects invalid values and leaves targets unchanged', async()=>{
    db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,local_timezone,created_at) VALUES(1,'word','gloss',80,70,'UTC',1)").run();
    const response=await route.POST(new Request('http://localhost/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'target',wordId:1,targetR:101,targetP:70})}));
    expect(response.status).toBe(400);expect(db.prepare('SELECT target_r,target_p FROM words WHERE id=1').get()).toEqual({target_r:80,target_p:70});
  });
  test('target action refuses to change an axis while its task is live', async()=>{
    db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,local_timezone,created_at) VALUES(1,'word','gloss',80,70,'UTC',1)").run();
    db.prepare("INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) VALUES('m',1,'both','encode',1,1,'ready','{}','{}','{}','{}','{}',1)").run();
    db.prepare("INSERT INTO task_instances(instance_id,definition_id,word_id,axis,type,stage,purpose,score_before,material_id,material_version,meaning_version,snapshot_json,status,issued_at) VALUES('live','encode',1,'both','ENCODE','encode','introduce',0,'m',1,1,'{}','issued',1)").run();
    const response=await route.POST(new Request('http://localhost/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'target',wordId:1,targetR:90,targetP:70})}));
    expect(response.status).toBe(400);expect(db.prepare('SELECT target_r FROM words WHERE id=1').get().target_r).toBe(80);
  });
  test('target action reports capacity-blocked requeue without overbooking', async()=>{
    const now=Date.now();const local=new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
    db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,score_r,score_p,fluency_pass_r,learning_complete_r,review_level_r,due_at_r,local_timezone,created_at) VALUES(1,'word','gloss',80,70,80,30,1,1,1,?,'UTC',1)").run(new Date(now).toISOString());
    db.prepare('INSERT INTO daily_capacity(local_date,timezone,capacity,completed) VALUES(?,\'UTC\',0,0)').run(local);
    const response=await route.POST(new Request('http://localhost/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'target',wordId:1,targetR:90,targetP:70})}));
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({capacityBlockedAxes:['r'],requeuedAxes:[]});
    expect(db.prepare('SELECT target_r,learning_complete_r FROM words WHERE id=1').get()).toEqual({target_r:90,learning_complete_r:0});
    expect(db.prepare("SELECT count(*) n FROM capacity_reservations WHERE status='active'").get().n).toBe(0);
  });
  test('new algorithm target page uses the isolated API and exposes independent R/P controls',()=>{
    const page=fs.readFileSync(require.resolve('../app/new-algorithm/goals/page.tsx'),'utf8');
    expect(page).toContain('action:\'target\'');
    expect(page).toContain('targetR');expect(page).toContain('targetP');
    expect(page).toContain('R 阅读目标');expect(page).toContain('P 写作目标');
  });
});
