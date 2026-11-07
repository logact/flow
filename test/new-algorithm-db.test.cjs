const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createFixture } = require('./new-algorithm-fixture.cjs');
const { initializeNewAlgorithmDb } = require(require('node:path').join(process.env.FLOW_TEST_BUILD_DIR, 'lib/new-algorithm-db.js'));
const { settleNewAlgorithmAttempt, recordFeedbackExposure } = require(require('node:path').join(process.env.FLOW_TEST_BUILD_DIR, 'lib/new-algorithm-settlement.js'));
const { importNewAlgorithmWords, confirmNewAlgorithmMeaning } = require(require('node:path').join(process.env.FLOW_TEST_BUILD_DIR, 'lib/new-algorithm-import.js'));

function frozenCase(f,{axis='r',stage='choice',score=5,type='RETRIEVE'}={}) {
  const word=f.addWord();const material=f.addMaterial(word,{axis,stage});
  f.db.prepare(`UPDATE words SET score_${axis}=? WHERE id=?`).run(score,word);
  const instance=f.nextId('instance'),attempt=f.nextId('attempt');
  f.db.prepare(`INSERT INTO task_instances(instance_id,definition_id,word_id,axis,type,stage,purpose,score_before,material_id,material_version,meaning_version,snapshot_json,status,issued_at)
    VALUES(?,?,?,?,?,?, 'review',?, ?,1,1,'{}','grading',?)`).run(instance,`${axis}-${stage}`,word,axis,type,stage,score,material.id,f.clock.now());
  f.db.prepare("INSERT INTO attempts(attempt_id,instance_id,response_json,timing_json,exposure_json,status,created_at) VALUES(?,?,'{}','{}','{\"target_seen\":true}','frozen',?)").run(attempt,instance,f.clock.now());
  return {word,instance,attempt,settle:(judgment,exposedBeforeFeedback=true)=>settleNewAlgorithmAttempt(f.db,{instanceId:instance,attemptId:attempt,judgment,exposedBeforeFeedback,now:f.clock.now()})};
}

test('new schema initializes twice with clean C1 defaults and version', () => {
  const f = createFixture();
  try {
    initializeNewAlgorithmDb(f.db);
    const id = f.addWord();
    const row = f.db.prepare('SELECT * FROM words WHERE id=?').get(id);
    assert.equal(row.score_r, 0); assert.equal(row.score_p, 0);
    assert.equal(row.half_life_r, 3600000); assert.equal(row.half_life_p, 3600000);
    for (const field of ['last_ts_r','last_ts_p','last_ts_any','last_tick_any']) assert.equal(row[field], null);
    assert.equal(row.observation_r, 0); assert.equal(row.observation_p, 0);
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value, '0');
    assert.equal(f.db.pragma('user_version', {simple:true}), 0);
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='new_algorithm_schema'").get().value, '1');
  } finally { f.close(); }
});

test('instance, attempt, event and material version uniqueness', () => {
  const f = createFixture();
  try {
    const word = f.addWord(); const material = f.addMaterial(word);
    const issue = (id, version=1) => f.db.prepare(`INSERT INTO task_instances(instance_id,definition_id,word_id,axis,type,stage,purpose,score_before,material_id,material_version,meaning_version,snapshot_json,status,issued_at)
      VALUES(?, 'r-encode', ?, 'r','ENCODE','encode','introduce',0,?, ?,1,'{}','issued',?)`).run(id,word,material.id,version,f.clock.now());
    assert.throws(() => issue('bad',2), /FOREIGN KEY/);
    issue('i1');
    assert.throws(() => issue('i1'), /UNIQUE/);
    assert.throws(() => issue('i2'), /UNIQUE/);
    const attempt = id => f.db.prepare("INSERT INTO attempts(attempt_id,instance_id,response_json,timing_json,exposure_json,status,created_at) VALUES(?,'i1','{}','{}','{}','frozen',?)").run(id,f.clock.now());
    attempt('a1'); assert.throws(() => attempt('a1'), /UNIQUE/);
    assert.throws(() => attempt('a2'), /UNIQUE/);
    const event = (id,key) => f.db.prepare("INSERT INTO events(event_id,dedupe_key,event_type,instance_id,attempt_id,word_id,axis,ts,payload_json) VALUES(?,?,'completed','i1','a1',?,'r',?,'{}')").run(id,key,word,f.clock.now());
    event('e1','complete:i1');
    assert.throws(() => event('e2','complete:i1'), /UNIQUE/);
  } finally { f.close(); }
});

test('failed transaction rolls back all learning state', () => {
  const f = createFixture();
  try {
    const word = f.addWord();
    assert.throws(() => f.db.transaction(() => {
      f.db.prepare('UPDATE words SET score_r=5, half_life_r=5400000, last_ts_any=? WHERE id=?').run(f.clock.now(),word);
      f.db.prepare("UPDATE meta SET value='1' WHERE key='global_tick'").run();
      throw new Error('injected failure');
    })(), /injected failure/);
    const row = f.db.prepare('SELECT score_r,half_life_r,last_ts_any FROM words WHERE id=?').get(word);
    assert.deepEqual(row, {score_r:0,half_life_r:3600000,last_ts_any:null});
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value,'0');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM events').get().n,0);
  } finally { f.close(); }
});

test('legacy or incompatible database is refused without mutation', () => {
  const f = createFixture();
  try {
    const legacy = new Database(':memory:');
    try {
      legacy.exec('CREATE TABLE words(id INTEGER PRIMARY KEY)');
      assert.throws(() => initializeNewAlgorithmDb(legacy), /nonempty database/);
      assert.equal(legacy.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='meta'").get().n,0);
    } finally { legacy.close(); }
    f.db.prepare("UPDATE meta SET value='999' WHERE key='new_algorithm_schema'").run();
    assert.throws(() => initializeNewAlgorithmDb(f.db), /incompatible database/);
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='new_algorithm_schema'").get().value,'999');
  } finally { f.close(); }
});

test('atomic settlement updates one axis and one tick; replay does not update again', () => {
  const f = createFixture();
  try {
    const word = f.addWord(); const material = f.addMaterial(word);
    f.db.prepare(`INSERT INTO task_instances(instance_id,definition_id,word_id,axis,type,stage,purpose,score_before,material_id,material_version,meaning_version,snapshot_json,status,issued_at)
      VALUES('i1','r-encode',?,'r','ENCODE','encode','introduce',0,?,1,1,'{}','grading',?)`).run(word,material.id,f.clock.now());
    f.db.prepare("INSERT INTO attempts(attempt_id,instance_id,response_json,timing_json,exposure_json,status,created_at) VALUES('a1','i1','{}','{}','{\"target_seen\":true}','frozen',?)").run(f.clock.now());
    const input = {instanceId:'i1',attemptId:'a1',judgment:{kind:'encode'},exposedBeforeFeedback:true,now:f.clock.now()};
    assert.deepEqual(settleNewAlgorithmAttempt(f.db,input), {status:'completed',scoreBefore:0,scoreAfter:5,tick:1,replay:false});
    assert.deepEqual(settleNewAlgorithmAttempt(f.db,input), {status:'completed',scoreBefore:0,scoreAfter:5,tick:1,replay:true});
    const row = f.db.prepare('SELECT score_r,score_p,observation_r,observation_p,half_life_r,half_life_p,last_ts_r,last_ts_p,last_ts_any,last_tick_any FROM words WHERE id=?').get(word);
    assert.deepEqual(row,{score_r:5,score_p:0,observation_r:0,observation_p:0,half_life_r:5400000,half_life_p:3600000,last_ts_r:f.clock.now(),last_ts_p:null,last_ts_any:f.clock.now(),last_tick_any:1});
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value,'1');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM events').get().n,1);
  } finally { f.close(); }
});

test('retrieval bands write absolute success and failure scores on both axes', () => {
  const cases=[['choice',5,20,5],['cued',20,40,5],['free',40,60,20]];
  for(const axis of ['r','p']) for(const [stage,before,success,failure] of cases) for(const [passed,expected] of [[true,success],[false,failure]]) {
    const f=createFixture();try {
      const c=frozenCase(f,{axis,stage,score:before});
      const result=c.settle({kind:'retrieval',passed});
      assert.equal(result.scoreAfter,expected,`${axis}/${stage}/${passed}`);
      const other=axis==='r'?'p':'r';
      const row=f.db.prepare(`SELECT score_${axis} AS score,score_${other} AS other,observation_${axis} AS observed,half_life_${axis} AS half_life FROM words WHERE id=?`).get(c.word);
      assert.deepEqual(row,{score:expected,other:0,observed:1,half_life:5400000});
      assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value,'1');
    } finally {f.close();}
  }
});

test('fluency directly writes lower current performance and valid unchanged result', () => {
  for(const [axis,wpm,expected] of [['r',200,60+50/3.75],['p',42.5,80]]) {
    const f=createFixture();try {
      const c=frozenCase(f,{axis,stage:'fluency',type:'FLUENCY',score:90});
      assert.equal(c.settle({kind:'fluency',result:{kind:'valid',targetPassed:true,overallPassed:true,wpm}}).scoreAfter,expected);
      assert.equal(f.db.prepare(`SELECT score_${axis} AS score FROM words WHERE id=?`).get(c.word).score,expected);
    } finally {f.close();}
  }
  const f=createFixture();try {
    const c=frozenCase(f,{stage:'fluency',type:'FLUENCY',score:80});
    assert.equal(c.settle({kind:'fluency',result:{kind:'valid',targetPassed:true,overallPassed:false,wpm:300}},false).scoreAfter,80);
    assert.equal(f.db.prepare('SELECT observation_r FROM words WHERE id=?').get(c.word).observation_r,1);
    assert.equal(f.db.prepare('SELECT half_life_r FROM words WHERE id=?').get(c.word).half_life_r,3600000);
    assert.equal(recordFeedbackExposure(f.db,{instanceId:c.instance,now:f.clock.now()}),true);
    assert.equal(recordFeedbackExposure(f.db,{instanceId:c.instance,now:f.clock.now()}),false);
    assert.equal(f.db.prepare('SELECT half_life_r FROM words WHERE id=?').get(c.word).half_life_r,5400000);
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value,'1');
  } finally {f.close();}
});

test('uncertain grading preserves frozen response and all learning state', () => {
  const f=createFixture();try {
    const c=frozenCase(f,{stage:'fluency',type:'FLUENCY',score:80});
    assert.deepEqual(c.settle({kind:'fluency',result:{kind:'uncertain'}}),{status:'grading_retry',replay:false});
    const row=f.db.prepare('SELECT score_r,half_life_r,last_ts_r,last_ts_any,last_tick_any,observation_r FROM words WHERE id=?').get(c.word);
    assert.deepEqual(row,{score_r:80,half_life_r:3600000,last_ts_r:null,last_ts_any:null,last_tick_any:null,observation_r:0});
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value,'0');
    assert.equal(f.db.prepare('SELECT status,response_json FROM attempts WHERE attempt_id=?').get(c.attempt).status,'grading_retry');
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM events WHERE event_type='completed'").get().n,0);
    assert.equal(c.settle({kind:'fluency',result:{kind:'valid',targetPassed:false,overallPassed:true,wpm:200}}).scoreAfter,40);
  } finally {f.close();}
});

test('settlement failure rolls back terminal, score, tick and event', () => {
  const f=createFixture();try {
    const c=frozenCase(f);
    f.db.exec("CREATE TRIGGER reject_completion BEFORE INSERT ON events WHEN NEW.event_type='completed' BEGIN SELECT RAISE(ABORT,'injected event failure'); END");
    assert.throws(()=>c.settle({kind:'retrieval',passed:true}),/injected event failure/);
    assert.equal(f.db.prepare('SELECT score_r FROM words WHERE id=?').get(c.word).score_r,5);
    assert.equal(f.db.prepare('SELECT status FROM task_instances WHERE instance_id=?').get(c.instance).status,'grading');
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value,'0');
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM events').get().n,0);
  } finally {f.close();}
});

test('unproven exposure cannot increase half-life or complete the task', () => {
  const f=createFixture();try {
    const c=frozenCase(f);
    f.db.prepare("UPDATE attempts SET exposure_json='{}' WHERE attempt_id=?").run(c.attempt);
    assert.throws(()=>c.settle({kind:'retrieval',passed:false}),/lacks frozen evidence/);
    assert.equal(f.db.prepare('SELECT half_life_r FROM words WHERE id=?').get(c.word).half_life_r,3600000);
    assert.equal(f.db.prepare('SELECT status FROM task_instances WHERE instance_id=?').get(c.instance).status,'grading');
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value,'0');
  } finally {f.close();}
});

test('invalid terminal attempt cannot settle or enhance memory', () => {
  const f=createFixture();try {
    const c=frozenCase(f);
    f.db.prepare("UPDATE task_instances SET status='invalid',terminal_at=? WHERE instance_id=?").run(f.clock.now(),c.instance);
    f.db.prepare("UPDATE attempts SET status='invalid' WHERE attempt_id=?").run(c.attempt);
    assert.throws(()=>c.settle({kind:'retrieval',passed:false}),/not ready for grading/);
    assert.throws(()=>recordFeedbackExposure(f.db,{instanceId:c.instance,now:f.clock.now()}),/Only a completed/);
    assert.deepEqual(f.db.prepare('SELECT score_r,score_p,half_life_r,half_life_p,last_ts_any,last_tick_any FROM words WHERE id=?').get(c.word),{score_r:5,score_p:0,half_life_r:3600000,half_life_p:3600000,last_ts_any:null,last_tick_any:null});
    assert.equal(f.db.prepare("SELECT value FROM meta WHERE key='global_tick'").get().value,'0');
  } finally {f.close();}
});

test('new import uses direct targets and scores; invalid batch writes nothing', () => {
  const f=createFixture();try {
    const [id]=importNewAlgorithmWords(f.db,[{term:'atlas',initialR:59.9,targetP:100,freq:12,freqSource:'book'}],f.clock.now());
    const row=f.db.prepare('SELECT meaning,target_r,target_p,score_r,score_p,observation_r,observation_p,level,freq_source FROM words WHERE id=?').get(id);
    assert.deepEqual(row,{meaning:'',target_r:80,target_p:100,score_r:59.9,score_p:0,observation_r:0,observation_p:0,level:'B1',freq_source:'book'});
    for(const bad of [{term:'bad',initialR:60},{term:'bad',targetP:59},{term:'bad',freq:1}]) {
      assert.throws(()=>importNewAlgorithmWords(f.db,[{term:'valid'},bad],f.clock.now()));
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM words').get().n,1);
  } finally {f.close();}
});

test('confirmed gloss invalidates older material versions', () => {
  const f=createFixture();try {
    const [word]=importNewAlgorithmWords(f.db,[{term:'bank'}],f.clock.now());
    assert.equal(f.db.prepare('SELECT meaning FROM words WHERE id=?').get(word).meaning,'');
    assert.equal(confirmNewAlgorithmMeaning(f.db,word,'河岸'),2);
    const old=f.addMaterial(word,{meaning_version:2});
    assert.equal(confirmNewAlgorithmMeaning(f.db,word,'银行'),3);
    assert.equal(f.db.prepare('SELECT status FROM materials WHERE id=?').get(old.id).status,'invalidated');
    assert.equal(confirmNewAlgorithmMeaning(f.db,word,'银行'),3);
  } finally {f.close();}
});
