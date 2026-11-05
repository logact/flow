const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
require('node:module').Module._initPaths();

const Database = require('better-sqlite3');
const buildDir = process.env.FLOW_TEST_BUILD_DIR;
if (!buildDir) throw new Error('Run this file through test/run-task-dag-tests.cjs');
const { CONFIG } = require(path.join(buildDir, 'lib/config.js'));
const { createDb } = require(path.join(buildDir, 'lib/db.js'));
const { getNextTaskInstance, applyTaskResult } = require(path.join(buildDir, 'lib/scheduler.js'));
const { materializeTargets, targetsFor } = require(path.join(buildDir, 'lib/targets.js'));

const FIXED_NOW = 1_800_000_000_000;
const PASS_RETRIEVE = (wordId, checkpoint, axis = 'p') => ({
  instance_id: `retrieve-${axis}-${checkpoint}`,
  definition_id: `retrieve-${axis}`,
  type: 'RETRIEVE',
  checkpoint,
  axis,
  purpose: 'verify',
  word_ids: [wordId],
  payload: {},
  renderer: `retrieve-${axis}`,
  issued_at: FIXED_NOW,
});
const passEvidence = (wordId, axis = 'p') => ({
  independent: true,
  answer_revealed: false,
  hint_used: false,
  accuracy: { target_word: true },
  speed_mode: 'latency_proxy',
  speed_value: null,
  duration_ms: null,
  word_results: [{ word_id: wordId, correct: true }],
});

function memoryDb() {
  const db = createDb(':memory:');
  db.prepare('DELETE FROM words').run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('global_tick', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
  return db;
}

function insertWord(db, overrides = {}) {
  const values = {
    chunk: 'focus phrase',
    meaning: '集中注意力',
    scene: 'A person focuses on one task.',
    slots: 'focus + phrase',
    substitute: 'concentrate',
    step3_sentence: 'She tried to focus phrase.',
    step4_sentences: JSON.stringify([
      'She used the focus phrase during a long meeting.',
      'The focus phrase helped the team stay on task.',
    ]),
    fluency: 0,
    fluency_r: 0,
    target_in: 60,
    target_out: 60,
    introduced: 0,
    has_observation_p: 0,
    has_observation_r: 0,
    verified_p: 0,
    verified_r: 0,
    speed_verified_p: 0,
    speed_verified_r: 0,
    integrated_p: 0,
    integrated_r: 0,
    pending_relearn_p: 0,
    pending_relearn_r: 0,
    stability_time: CONFIG.H_TIME_SEED_MS,
    stability_time_r: CONFIG.H_TIME_SEED_MS,
    last_tick: 0,
    last_ts: 0,
    last_ts_r: 0,
    created_at: FIXED_NOW,
    updated_at: FIXED_NOW,
    ...overrides,
  };
  const columns = Object.keys(values);
  const params = columns.map((key) => values[key]);
  const result = db.prepare(
    `INSERT INTO words (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  ).run(...params);
  return Number(result.lastInsertRowid);
}

function getWord(db, id) {
  return db.prepare('SELECT * FROM words WHERE id = ?').get(id);
}

test('q affects first routing only; unassessed axes stay at zero', () => {
  for (const [q, type, purpose] of [
    [0.1, 'ENCODE', 'introduce'],
    [0.5, 'RETRIEVE', 'diagnose'],
    [0.9, 'RETRIEVE', 'verify'],
  ]) {
    const db = memoryDb();
    const id = insertWord(db, { chunk: `prior ${q}`, meaning: `先验 ${q}`, prior_mastery_q: q });
    const first = getNextTaskInstance(db, FIXED_NOW);
    assert.equal(first.word_ids[0], id);
    assert.equal(first.type, type);
    assert.equal(first.purpose, purpose);
    const word = getWord(db, id);
    assert.equal(word.fluency, 0);
    assert.equal(word.fluency_r, 0);
    assert.equal(word.prior_mastery_q, q);
    db.close();
  }
});

test('RETRIEVE checkpoints advance only after valid independent passes', () => {
  const db = memoryDb();
  const id = insertWord(db, { introduced: 1 });
  for (const checkpoint of [20, 35, 50]) {
    const writeback = applyTaskResult(db, PASS_RETRIEVE(id, checkpoint), passEvidence(id), FIXED_NOW + checkpoint);
    assert.equal(writeback.passed, true);
    assert.equal(writeback.qualified, true);
    assert.equal(getWord(db, id).fluency, checkpoint);
    assert.equal(getWord(db, id).verified_p, 1);
  }
  const before = getWord(db, id);
  const failed = applyTaskResult(
    db,
    PASS_RETRIEVE(id, 50),
    { ...passEvidence(id), accuracy: { target_word: false }, word_results: [{ word_id: id, correct: false }] },
    FIXED_NOW + 1000
  );
  const after = getWord(db, id);
  assert.equal(failed.passed, false);
  assert.equal(after.fluency, before.fluency);
  assert.equal(after.verified_p, 0);
  assert.equal(after.pending_relearn_p, 1);
  db.close();
});

test('per-axis retention and shared cooling gates are deterministic', () => {
  const db = memoryDb();
  const id = insertWord(db, {
    introduced: 1,
    fluency: 20,
    has_observation_p: 1,
    has_observation_r: 1,
    verified_p: 1,
    verified_r: 1,
    last_ts: FIXED_NOW,
    last_ts_r: FIXED_NOW,
    last_tick: 0,
  });
  const waiting = getNextTaskInstance(db, FIXED_NOW);
  assert.equal(waiting.type, 'EMPTY');
  assert.equal(waiting.reason, 'waiting_cooldown');
  assert.ok(waiting.next_available_at > FIXED_NOW);

  // Seven intervening tasks satisfy the tick channel, but the shared 20-minute
  // channel has not cooled; the axis must still wait for both eligibility gates.
  db.prepare("UPDATE meta SET value = '7' WHERE key = 'global_tick'").run();
  const stillWaiting = getNextTaskInstance(db, FIXED_NOW + 60_000);
  assert.equal(stillWaiting.type, 'EMPTY');
  assert.equal(stillWaiting.reason, 'waiting_cooldown');

  const ready = getNextTaskInstance(db, FIXED_NOW + CONFIG.H_CACHE_MS + 1);
  assert.notEqual(ready.type, 'EMPTY');
  assert.equal(ready.word_ids[0], id);
  db.close();
});

test('severe same-axis forgetting routes to emergency verification then relearning', () => {
  const db = memoryDb();
  const id = insertWord(db, {
    introduced: 1,
    fluency_r: 35,
    has_observation_r: 1,
    verified_r: 1,
    last_ts_r: FIXED_NOW - 48 * 60 * 60_000,
    last_ts: 0,
    last_tick: 0,
  });
  const emergency = getNextTaskInstance(db, FIXED_NOW);
  assert.equal(emergency.type, 'RETRIEVE');
  assert.equal(emergency.axis, 'r');
  assert.equal(emergency.purpose, 'recover');
  assert.equal(getWord(db, id).verified_r, 0);

  const failure = {
    ...passEvidence(id, 'r'),
    accuracy: { target_word: false },
    word_results: [{ word_id: id, correct: false }],
  };
  applyTaskResult(db, emergency, failure, FIXED_NOW);
  const relearn = getNextTaskInstance(db, FIXED_NOW + 1);
  assert.equal(relearn.type, 'ENCODE');
  assert.equal(relearn.axis, 'r');
  assert.equal(relearn.purpose, 'relearn');
  db.close();
});

test('integration is queued and completed on the eligible axis only', () => {
  const db = memoryDb();
  const ids = [];
  const sentences = Array.from({ length: 3 }, (_, i) =>
    `The focus phrase helps teams plan a small project carefully every single day number ${i}.`
  );
  for (let i = 0; i < CONFIG.BATCH_SIZE; i++) {
    ids.push(insertWord(db, {
      chunk: ['focus', 'phrase', 'teams', 'plan', 'project'][i],
      meaning: `释义${i}`,
      step4_sentences: JSON.stringify([
        ...sentences,
        'Teams can plan a project with focus and a useful phrase each day.',
      ]),
      fluency: 75,
      fluency_r: 0,
      introduced: 1,
      has_observation_p: 1,
      verified_p: 1,
      last_ts: FIXED_NOW - 30 * 60_000,
      target_out: 100,
    }));
  }
  const task = getNextTaskInstance(db, FIXED_NOW);
  assert.equal(task.type, 'INTEGRATE');
  assert.equal(task.axis, 'p');
  assert.equal(task.word_ids.length, CONFIG.BATCH_SIZE);
  const evidence = {
    independent: true,
    answer_revealed: false,
    hint_used: false,
    accuracy: { target_word: true, expression: true },
    speed_mode: 'writing_wpm',
    speed_value: null,
    duration_ms: null,
    word_results: ids.map((word_id) => ({ word_id, correct: true })),
  };
  const result = applyTaskResult(db, task, evidence, FIXED_NOW);
  assert.equal(result.passed, true);
  for (const id of ids) assert.equal(getWord(db, id).integrated_p, 1);
  assert.ok(ids.every((id) => getWord(db, id).integrated_r === 0));
  db.close();
});

test('target changes rematerialize exact 60–100 speed-based scores without frequency bonus', () => {
  const db = memoryDb();
  const goalId = Number(db.prepare(
    `INSERT INTO goals (type, title, target, created_at) VALUES ('wordlist', 'goal', ?, ?)`
  ).run(JSON.stringify({ reading_wpm: 200, writing_wpm: 30 }), FIXED_NOW).lastInsertRowid);
  const id = insertWord(db, { goal_id: goalId, freq: 500_000 });
  const initial = targetsFor({ reading_wpm: 200, writing_wpm: 30 });
  assert.ok(Math.abs(initial.targetIn - (60 + 40 * (50 / 150))) < 1e-10);
  assert.ok(Math.abs(initial.targetOut - (60 + 40 * (5 / 35))) < 1e-10);
  db.prepare('UPDATE goals SET target = ? WHERE id = ?').run(
    JSON.stringify({ reading_wpm: 300, writing_wpm: 60 }), goalId
  );
  materializeTargets(db, goalId);
  const updated = getWord(db, id);
  assert.equal(updated.target_in, 100);
  assert.equal(updated.target_out, 100);
  assert.equal(targetsFor({ reading_wpm: 200, writing_wpm: 30 }).targetIn, initial.targetIn);
  db.close();
});

test('graduation needs both axis targets, verification, speed evidence, and 30-day anchors', () => {
  const db = memoryDb();
  const id = insertWord(db, {
    introduced: 1,
    fluency: 60,
    fluency_r: 59,
    target_out: 60,
    target_in: 60,
    verified_p: 1,
    speed_verified_p: 1,
    stability_time: CONFIG.H_TIME_GRAD_MS,
    stability_time_r: CONFIG.H_TIME_GRAD_MS,
    has_observation_p: 1,
    has_observation_r: 1,
    last_ts: FIXED_NOW - 100_000,
    last_ts_r: FIXED_NOW - 100_000,
  });
  const instance = {
    instance_id: 'r-target',
    definition_id: 'fluency-r',
    type: 'FLUENCY',
    checkpoint: 60,
    axis: 'r',
    purpose: 'verify',
    word_ids: [id],
    payload: {},
    renderer: 'fluency-r',
    issued_at: FIXED_NOW,
  };
  const evidence = {
    independent: true,
    answer_revealed: false,
    hint_used: false,
    accuracy: { target_word: true, passage_comprehension: true },
    speed_mode: 'reading_wpm',
    speed_value: 150,
    duration_ms: 60_000,
    word_results: [{ word_id: id, correct: true }],
  };
  const result = applyTaskResult(db, instance, evidence, FIXED_NOW);
  assert.equal(result.passed, true);
  assert.equal(getWord(db, id).fluency_r, 60);
  assert.equal(getWord(db, id).speed_verified_r, 1);
  assert.equal(getWord(db, id).graduated, 1);
  db.close();
});

test('legacy scores migrate to history; no unsupported certification is inferred and migration is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-t14-'));
  const file = path.join(dir, 'legacy.sqlite');
  const old = new Database(file);
  old.exec(`
    CREATE TABLE words (
      id INTEGER PRIMARY KEY, chunk TEXT NOT NULL, meaning TEXT NOT NULL, scene TEXT NOT NULL,
      slots TEXT NOT NULL, substitute TEXT NOT NULL, step3_sentence TEXT NOT NULL,
      step4_sentences TEXT NOT NULL, state TEXT NOT NULL, ready_at_tick INTEGER DEFAULT 0,
      ready_at_time INTEGER DEFAULT 0, step4_fail_count INTEGER DEFAULT 0,
      srs_level INTEGER DEFAULT 0, due_at INTEGER DEFAULT 0, stability_tick REAL DEFAULT 4,
      stability_time REAL DEFAULT 3600000, last_tick INTEGER DEFAULT 0, last_ts INTEGER DEFAULT 0,
      integrated INTEGER DEFAULT 0, graduated INTEGER DEFAULT 0, profile INTEGER DEFAULT 0,
      goal_id INTEGER, freq INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO words (id, chunk, meaning, scene, slots, substitute, step3_sentence,
      step4_sentences, state, last_ts, integrated, graduated, created_at, updated_at)
    VALUES (1, 'old word', '旧词', '', '', '', '', '[]', '4_MASTERED', ${FIXED_NOW - 86_400_000}, 1, 1, ${FIXED_NOW - 86_400_000}, ${FIXED_NOW - 86_400_000});
  `);
  old.close();

  const db = createDb(file);
  const migrated = getWord(db, 1);
  assert.equal(migrated.legacy_score_p, 85);
  assert.equal(migrated.legacy_score_r, 60);
  assert.equal(migrated.fluency, 0);
  assert.equal(migrated.fluency_r, 0);
  assert.equal(migrated.speed_verified_p, 0);
  assert.equal(migrated.speed_verified_r, 0);
  assert.equal(migrated.integrated_p, 0);
  assert.equal(migrated.integrated_r, 0);
  assert.equal(migrated.graduated, 0);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'migrated_legacy_evidence_v1'").get().value, '1');
  db.close();

  const reopened = createDb(file);
  const again = getWord(reopened, 1);
  assert.equal(again.legacy_score_p, 85);
  assert.equal(again.legacy_score_r, 60);
  assert.equal(again.fluency, 0);
  assert.equal(again.graduated, 0);
  reopened.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

