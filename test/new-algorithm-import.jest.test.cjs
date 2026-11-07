const { createNewAlgorithmDb } = require('../lib/new-algorithm-db');
const { estimateInitialScores, importNewAlgorithmWords, confirmNewAlgorithmMeaning, minimumIntroductionTasks, setDailyAvailability, canAdmitIntroduction, reserveIntroductionCapacity } = require('../lib/new-algorithm-import');
const { generateNewAlgorithmMaterial, findReadyNewAlgorithmMaterial } = require('../lib/new-algorithm-material-jobs');

function reserveWithOpenCapacity(db, candidates, now, timezone) {
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(now);
  const p=(type)=>parts.find(x=>x.type===type)?.value ?? '';
  setDailyAvailability(db,{timezone,localDate:`${p('year')}-${p('month')}-${p('day')}`,capacity:1000,windowStart:'00:00',windowEnd:'23:59'});
  return reserveIntroductionCapacity(db,candidates,now,timezone);
}

describe('new algorithm import', () => {
  test.each([
    [4000, 2000, [60, 40, false]],
    [4000, 2001, [40, 20, false]],
    [4000, 4000, [40, 20, false]],
    [4000, 4001, [20, 5, false]],
    [4000, 6000, [20, 5, false]],
    [4000, 6001, [0, 0, true]],
    [undefined, 1, [0, 0, true, true]],
    [4000, 1000, [0, 0, true, false]],
  ])('maps V=%s rank=%s to starting scores', (v, rank, expected) => {
    const result = estimateInitialScores(v, rank, expected[3]);
    expect([result.scoreR, result.scoreP, result.requiresConnection]).toEqual(expected.slice(0, 3));
  });

  test('imports estimates only after explicit capacity reservation and assigns due-now state', () => {
    const db = createNewAlgorithmDb();
    const rows = [
      { term: 'common', confirmedMeaning: '常见', vocabularySize: 4000, rank: 1000, timezone: 'Asia/Shanghai' },
      { term: 'unknown', confirmedMeaning: '未知', vocabularySize: 4000, rank: 7000, timezone: 'Asia/Shanghai' },
    ];
    expect(() => importNewAlgorithmWords(db, rows, 1794000000000)).toThrow(/CAPACITY_GATE_PENDING/);
    expect(db.prepare('select count(*) as n from words').get().n).toBe(0);
    const ids = importNewAlgorithmWords(db, rows, 1794000000000, (tx,candidates,now,tz) => reserveWithOpenCapacity(tx,candidates,now,tz));
    expect(ids).toHaveLength(2);
    expect(db.prepare('select score_r,score_p,introduced,due_at_r,due_at_p,local_timezone from words where id=?').get(ids[0])).toMatchObject({ score_r: 60, score_p: 40, introduced: 1, due_at_r: new Date(1794000000000).toISOString(), due_at_p: new Date(1794000000000).toISOString(), local_timezone: 'Asia/Shanghai' });
    expect(db.prepare('select score_r,score_p,introduced from words where id=?').get(ids[1])).toMatchObject({ score_r: 0, score_p: 0, introduced: 0 });
    db.close();
  });

  test.each([[4000,1000,3,40],[4000,3000,5,80],[4000,5000,7,120],[4000,7000,9,160]])('O1 admission uses capacity and conservative cooldown floor for rank %s', (v,rank,tasks,minutes) => {
    const db=createNewAlgorithmDb();
    setDailyAvailability(db,{timezone:'Asia/Shanghai',localDate:'2026-11-07',capacity:tasks,windowStart:'08:00',windowEnd:'23:00'});
    const estimate=estimateInitialScores(v,rank);
    const now=Date.parse('2026-11-07T00:00:00Z');
    expect(minimumIntroductionTasks(estimate)).toBe(tasks);
    expect(canAdmitIntroduction(db,[estimate],now,'Asia/Shanghai')).toBe(true);
    db.prepare('update daily_capacity set completed=? where local_date=?').run(1,'2026-11-07');
    expect(canAdmitIntroduction(db,[estimate],now,'Asia/Shanghai')).toBe(false);
    db.close();
  });

  test('O1 rejects admission before the configured window starts',()=>{
    const db=createNewAlgorithmDb();
    setDailyAvailability(db,{timezone:'Asia/Shanghai',localDate:'2026-11-07',capacity:9,windowStart:'09:00',windowEnd:'23:00'});
    expect(canAdmitIntroduction(db,[estimateInitialScores(4000,7000)],Date.parse('2026-11-07T00:00:00Z'),'Asia/Shanghai')).toBe(false);
    db.close();
  });

  test('O1 accepts the window start and exact cooldown floor, but rejects the exclusive end',()=>{
    const db=createNewAlgorithmDb();
    setDailyAvailability(db,{timezone:'UTC',localDate:'2026-11-07',capacity:9,windowStart:'20:00',windowEnd:'22:40'});
    const estimate=estimateInitialScores(4000,7000);
    expect(canAdmitIntroduction(db,[estimate],Date.parse('2026-11-07T20:00:00Z'),'UTC')).toBe(true);
    expect(canAdmitIntroduction(db,[estimate],Date.parse('2026-11-07T22:40:00Z'),'UTC')).toBe(false);
    db.close();
  });

  test('O1 reservations count against capacity and failed admission rolls back word inserts',()=>{
    const db=createNewAlgorithmDb();
    setDailyAvailability(db,{timezone:'Asia/Shanghai',localDate:'2026-11-07',capacity:9,windowStart:'08:00',windowEnd:'23:00'});
    const now=Date.parse('2026-11-07T00:00:00Z');
    const one=[{term:'first',vocabularySize:4000,rank:7000,timezone:'Asia/Shanghai'}];
    const ids=importNewAlgorithmWords(db,one,now,(tx,candidates,tzNow,tz)=>reserveIntroductionCapacity(tx,candidates,tzNow,tz));
    expect(ids).toHaveLength(1);
    expect(db.prepare('select axis,reservation_kind,task_count,status from capacity_reservations').get()).toEqual({axis:'both',reservation_kind:'introduction',task_count:9,status:'active'});
    expect(canAdmitIntroduction(db,[estimateInitialScores(4000,1000)],now,'Asia/Shanghai')).toBe(false);
    expect(()=>importNewAlgorithmWords(db,[{term:'second',vocabularySize:4000,rank:1000,timezone:'Asia/Shanghai'}],now,
      (tx,candidates,tzNow,tz)=>reserveIntroductionCapacity(tx,candidates,tzNow,tz))).toThrow('CAPACITY_INSUFFICIENT');
    expect(db.prepare('select count(*) n from words').get().n).toBe(1);
    expect(db.prepare('select sum(task_count) n from capacity_reservations where status=\'active\'').get().n).toBe(9);
    db.close();
  });

  test('confirmed gloss changes invalidate older materials atomically', () => {
    const db = createNewAlgorithmDb();
    const id = importNewAlgorithmWords(db, [{ term: 'word', confirmedMeaning: '旧义', vocabularySize: 4000, rank: 1000, timezone: 'UTC' }], 1, (tx,candidates,now,tz) => reserveWithOpenCapacity(tx,candidates,now,tz))[0];
    db.prepare(`insert into materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at)
      values('old',?,'r','choice',1,1,'ready','{}','{}','{}','{}','{}',1)`).run(id);
    expect(confirmNewAlgorithmMeaning(db, id, '新义')).toBe(2);
    expect(db.prepare('select status,meaning_version from materials where id=\'old\'').get()).toEqual({ status: 'invalidated', meaning_version: 1 });
    expect(confirmNewAlgorithmMeaning(db, id, '新义')).toBe(2);
    db.close();
  });

  test('material generation requires confirmed gloss and stops after the D5 batch limit', async () => {
    const db = createNewAlgorithmDb();
    const id = importNewAlgorithmWords(db, [{ term: 'word', vocabularySize: 4000, rank: 7000, timezone: 'UTC' }], 1, (tx,candidates,now,tz) => reserveWithOpenCapacity(tx,candidates,now,tz))[0];
    const input = { wordId: id, axis: 'r', stage: 'choice', version: 1, meaningVersion: 1, now: 2 };
    await expect(generateNewAlgorithmMaterial(db, input, async () => { throw Error('must not run'); }, () => ({ valid: true }))).rejects.toThrow('CONFIRMED_GLOSS_REQUIRED');
    const meaningVersion = confirmNewAlgorithmMeaning(db, id, 'a meaning');
    input.meaningVersion = meaningVersion;
    let calls = 0;
    const result = await generateNewAlgorithmMaterial(db, input, async () => { calls++; throw new Error('provider unavailable'); }, () => ({ valid: true }));
    expect(result).toMatchObject({ status: 'failed', attempts: 2, reason: 'provider unavailable' });
    expect(calls).toBe(2);
    expect(db.prepare('select status,generation_attempts from materials where id=?').get(result.id)).toEqual({ status: 'failed', generation_attempts: 2 });
    const retry={...input,version:2};
    const ready=await generateNewAlgorithmMaterial(db,retry,async()=>({publicPayload:{text:'x'},answerKey:{ok:true},gradingRequirements:{},timingProtocol:{},validation:{ok:true}}),()=>({valid:true}));
    expect(findReadyNewAlgorithmMaterial(db,{wordId:id,axis:'r',stage:'choice',meaningVersion})).toMatchObject({id:ready.id,version:2});
    db.prepare('update materials set usage_count=1 where id=?').run(ready.id);
    expect(findReadyNewAlgorithmMaterial(db,{wordId:id,axis:'r',stage:'choice',meaningVersion})).toBeNull();
    db.close();
  });
});
