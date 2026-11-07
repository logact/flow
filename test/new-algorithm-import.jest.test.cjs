const { createNewAlgorithmDb } = require('../lib/new-algorithm-db');
const { estimateInitialScores, importNewAlgorithmWords, confirmNewAlgorithmMeaning } = require('../lib/new-algorithm-import');
const { generateNewAlgorithmMaterial } = require('../lib/new-algorithm-material-jobs');

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
    const ids = importNewAlgorithmWords(db, rows, 1794000000000, estimates => estimates.length === 2);
    expect(ids).toHaveLength(2);
    expect(db.prepare('select score_r,score_p,introduced,due_at_r,due_at_p,local_timezone from words where id=?').get(ids[0])).toMatchObject({ score_r: 60, score_p: 40, introduced: 1, due_at_r: new Date(1794000000000).toISOString(), due_at_p: new Date(1794000000000).toISOString(), local_timezone: 'Asia/Shanghai' });
    expect(db.prepare('select score_r,score_p,introduced from words where id=?').get(ids[1])).toMatchObject({ score_r: 0, score_p: 0, introduced: 0 });
    db.close();
  });

  test('confirmed gloss changes invalidate older materials atomically', () => {
    const db = createNewAlgorithmDb();
    const id = importNewAlgorithmWords(db, [{ term: 'word', confirmedMeaning: '旧义', vocabularySize: 4000, rank: 1000, timezone: 'UTC' }], 1, () => true)[0];
    db.prepare(`insert into materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at)
      values('old',?,'r','choice',1,1,'ready','{}','{}','{}','{}','{}',1)`).run(id);
    expect(confirmNewAlgorithmMeaning(db, id, '新义')).toBe(2);
    expect(db.prepare('select status,meaning_version from materials where id=\'old\'').get()).toEqual({ status: 'invalidated', meaning_version: 1 });
    expect(confirmNewAlgorithmMeaning(db, id, '新义')).toBe(2);
    db.close();
  });

  test('material generation requires confirmed gloss and stops after the D5 batch limit', async () => {
    const db = createNewAlgorithmDb();
    const id = importNewAlgorithmWords(db, [{ term: 'word', vocabularySize: 4000, rank: 7000, timezone: 'UTC' }], 1, () => true)[0];
    const input = { wordId: id, axis: 'r', stage: 'choice', version: 1, meaningVersion: 1, now: 2 };
    await expect(generateNewAlgorithmMaterial(db, input, async () => { throw Error('must not run'); }, () => ({ valid: true }))).rejects.toThrow('CONFIRMED_GLOSS_REQUIRED');
    const meaningVersion = confirmNewAlgorithmMeaning(db, id, 'a meaning');
    input.meaningVersion = meaningVersion;
    let calls = 0;
    const result = await generateNewAlgorithmMaterial(db, input, async () => { calls++; throw new Error('provider unavailable'); }, () => ({ valid: true }));
    expect(result).toMatchObject({ status: 'failed', attempts: 2, reason: 'provider unavailable' });
    expect(calls).toBe(2);
    expect(db.prepare('select status,generation_attempts from materials where id=?').get(result.id)).toEqual({ status: 'failed', generation_attempts: 2 });
    db.close();
  });
});
