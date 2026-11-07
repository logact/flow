const Database = require('better-sqlite3');
const { createNewAlgorithmDb, initializeNewAlgorithmDb } = require('../lib/new-algorithm-db');

describe('new algorithm schema', () => {
  test('initializes idempotently in an isolated in-memory database', () => {
    const db = createNewAlgorithmDb();
    expect(() => initializeNewAlgorithmDb(db)).not.toThrow();
    expect(db.prepare("select value from meta where key='new_algorithm_schema'").get().value).toBe('3');
    db.close();
  });
  test('rejects a nonempty unversioned or incompatible database transactionally', () => {
    const db = new Database(':memory:'); db.exec('create table legacy(id integer)');
    expect(() => initializeNewAlgorithmDb(db)).toThrow(/nonempty/);
    expect(db.prepare("select name from sqlite_master where name='meta'").get()).toBeUndefined(); db.close();
    for (const version of ['1', '2']) {
      const wrong = new Database(':memory:');
      wrong.exec(`create table meta(key text primary key,value text); insert into meta values('new_algorithm_schema','${version}')`);
      expect(() => initializeNewAlgorithmDb(wrong)).toThrow(/incompatible/);
      expect(wrong.prepare("select count(*) n from sqlite_master where type='table' and name='words'").get().n).toBe(0);
      expect(wrong.prepare("select value from meta where key='new_algorithm_schema'").get().value).toBe(version);
      wrong.close();
    }
  });
  test('stores independent axis schedule and graduation state and both-axis connection', () => {
    const db = createNewAlgorithmDb();
    db.prepare(`insert into words(id,term,meaning,target_r,target_p,created_at,review_level_r,review_level_p,fluency_pass_r,fluency_pass_p,graduated_r,due_at_r,due_at_p,local_timezone)
      values(1,'word','gloss',80,80,1,3,1,1,1,1,'2026-11-08T00:00:00Z','2026-11-09T00:00:00Z','Asia/Shanghai')`).run();
    db.prepare(`insert into materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at)
      values('m',1,'both','encode',1,1,'ready','{}','{}','{}','{}','{}',1)`).run();
    db.prepare(`insert into task_instances(instance_id,definition_id,word_id,axis,type,stage,purpose,score_before,material_id,material_version,meaning_version,snapshot_json,status,issued_at)
      values('i','d',1,'both','ENCODE','encode','introduce',0,'m',1,1,'{}','completed',1)`).run();
    expect(() => db.prepare(`insert into task_instances(instance_id,definition_id,word_id,axis,type,stage,purpose,score_before,material_id,material_version,meaning_version,snapshot_json,status,issued_at)
      values('i2','d',1,'both','ENCODE','encode','introduce',0,'m',1,1,'{}','completed',2)`).run()).toThrow();
    expect(db.prepare('select review_level_r,review_level_p,graduated_r,due_at_r,due_at_p from words where id=1').get()).toMatchObject({review_level_r:3,review_level_p:1,graduated_r:1,due_at_r:'2026-11-08T00:00:00Z',due_at_p:'2026-11-09T00:00:00Z'});
    db.close();
  });
  test('stores positive integer task counts including 3, 5, 7 and 9', () => {
    const db = createNewAlgorithmDb();
    db.prepare("insert into words(id,term,meaning,target_r,target_p,created_at,local_timezone) values(1,'w','g',80,80,1,'Asia/Shanghai')").run();
    const insert = db.prepare("insert into capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count) values(?,1,'r',?,'Asia/Shanghai','determined',?)");
    for (const count of [3, 5, 7, 9]) insert.run(`r${count}`, `2026-11-${String(count).padStart(2, '0')}`, count);
    expect(db.prepare('select task_count from capacity_reservations order by task_count').all().map(row => row.task_count)).toEqual([3, 5, 7, 9]);
    expect(() => insert.run('zero', '2026-11-10', 0)).toThrow();
    expect(() => insert.run('fraction', '2026-11-11', 2.5)).toThrow();
    db.close();
  });
  test('enforces introduction versus per-axis review reservation constraints', () => {
    const db = createNewAlgorithmDb();
    db.prepare("insert into words(id,term,meaning,target_r,target_p,created_at,local_timezone) values(1,'w','g',80,80,1,'Asia/Shanghai')").run();
    const insert = db.prepare("insert into capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count) values(?,1,?,'2026-11-08','Asia/Shanghai',?,?)");
    insert.run('intro', 'both', 'introduction', 9);
    insert.run('review-r', 'r', 'determined', 3);
    insert.run('review-p', 'p', 'conditional', 5);
    expect(() => insert.run('intro-axis-r', 'r', 'introduction', 9)).toThrow();
    expect(() => insert.run('review-axis-both', 'both', 'determined', 3)).toThrow();
    expect(() => insert.run('unknown-kind', 'both', 'other', 3)).toThrow();
    db.close();
  });
  test('enforces reservation uniqueness, foreign keys, live-instance uniqueness and event dedupe', () => {
    const db=createNewAlgorithmDb();
    db.prepare("insert into words(id,term,meaning,target_r,target_p,created_at,local_timezone) values(1,'w','g',80,80,1,'Asia/Shanghai')").run();
    db.prepare("insert into daily_capacity(local_date,timezone,capacity) values('2026-11-08','Asia/Shanghai',9)").run();
    expect(()=>db.prepare("insert into daily_capacity(local_date,timezone,capacity) values('2026-11-08','Asia/Shanghai',4)").run()).toThrow();
    expect(()=>db.prepare("insert into daily_capacity(local_date,timezone,capacity) values('2026-11-09','Asia/Shanghai',-1)").run()).toThrow();
    db.prepare("insert into capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count) values('r1',1,'r','2026-11-08','Asia/Shanghai','determined',3)").run();
    db.prepare("insert into capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count) values('r4',1,'r','2026-11-08','Asia/Shanghai','conditional',5)").run();
    expect(db.prepare("select count(*) n from capacity_reservations where word_id=1").get().n).toBe(2);
    expect(()=>db.prepare("insert into capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count) values('r2',1,'r','2026-11-08','Asia/Shanghai','determined',3)").run()).toThrow();
    expect(()=>db.prepare("insert into capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count) values('r3',99,'r','2026-11-08','Asia/Shanghai','conditional',5)").run()).toThrow();
    db.prepare("insert into materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at) values('m',1,'r','choice',1,1,'ready','{}','{}','{}','{}','{}',1)").run();
    db.prepare("insert into task_instances(instance_id,definition_id,word_id,axis,type,stage,purpose,score_before,material_id,material_version,meaning_version,snapshot_json,status,issued_at) values('live','d',1,'r','RETRIEVE','choice','introduce',0,'m',1,1,'{}','issued',1)").run();
    expect(()=>db.prepare("insert into task_instances(instance_id,definition_id,word_id,axis,type,stage,purpose,score_before,material_id,material_version,meaning_version,snapshot_json,status,issued_at) values('live2','d',1,'r','RETRIEVE','choice','introduce',0,'m',1,1,'{}','issued',2)").run()).toThrow();
    const instance=db.prepare("select instance_id from task_instances where instance_id='live'").get();
    db.prepare("insert into attempts(attempt_id,instance_id,response_json,timing_json,exposure_json,status,created_at) values('a1',?,'{}','{}','{}','invalid',1)").run(instance.instance_id);
    expect(()=>db.prepare("insert into attempts(attempt_id,instance_id,response_json,timing_json,exposure_json,status,created_at) values('a2',?,'{}','{}','{}','frozen',2)").run(instance.instance_id)).not.toThrow();
    db.prepare("insert into events(event_id,dedupe_key,event_type,ts,payload_json) values('e1','k','done',1,'{}')").run();
    expect(()=>db.prepare("insert into events(event_id,dedupe_key,event_type,ts,payload_json) values('e2','k','done',2,'{}')").run()).toThrow();
    db.close();
  });
  test('rolls back all writes on transaction failure', () => {
    const db=createNewAlgorithmDb();
    expect(()=>db.transaction(()=>{db.prepare("insert into words(id,term,meaning,target_r,target_p,created_at,local_timezone) values(1,'w','g',80,80,1,'Asia/Shanghai')").run(); throw Error('fail');})()).toThrow('fail');
    expect(db.prepare('select count(*) n from words').get().n).toBe(0); db.close();
  });
});
