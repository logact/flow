const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const buildDir = process.env.FLOW_TEST_BUILD_DIR;
if (!buildDir) throw new Error('Run with node test/run-task-flow-tests.cjs');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith('@/')) {
    request = path.join(buildDir, `${request.slice(2)}.js`);
  }
  return resolveFilename.call(this, request, parent, isMain, options);
};

const Database = require('better-sqlite3');
const { createDb } = require(path.join(buildDir, 'lib/db.js'));
const { createGoal } = require(path.join(buildDir, 'lib/goals.js'));
const { CONFIG } = require(path.join(buildDir, 'lib/config.js'));
const { getOrIssueTask, submitTaskResult } = require(path.join(buildDir, 'app/api/task/service.js'));

const FIXED_NOW = 1_800_000_000_000;

function cleanDb() {
  const db = createDb(':memory:');
  db.prepare('DELETE FROM words').run();
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM goals').run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('global_tick', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('vocab_estimate', '5000') ON CONFLICT(key) DO UPDATE SET value = '5000'").run();
  return db;
}

function validEvidence(task) {
  const definition = task.payload.evidence;
  return {
    independent: true,
    answer_revealed: false,
    hint_used: false,
    accuracy: Object.fromEntries((definition.accuracy_check ?? []).map((key) => [key, true])),
    speed_mode: definition.speed_mode,
    speed_value: null,
    duration_ms: null,
    word_results: task.word_ids.map((word_id) => ({ word_id, correct: true })),
  };
}

function answerFor(task, word) {
  return task.axis === 'r' ? word.meaning : word.chunk;
}

function answerInput(task, word) {
  return {
    instance_id: task.instance_id,
    response: {
      word_answers: [{ word_id: word.id, answer: answerFor(task, word) }],
    },
    evidence: validEvidence(task),
  };
}

test('import → first verified task → refresh resume → duplicate submit → review recheck', async () => {
  const db = cleanDb();
  const imported = await createGoal(db, {
    type: 'wordlist',
    title: 'T15 journey',
    text: 'the - article',
  }, FIXED_NOW);
  assert.equal(imported.added, 1);

  const word = db.prepare('SELECT * FROM words WHERE goal_id = ?').get(imported.goalId);
  assert.ok(word);
  assert.equal(word.introduced, 0);
  assert.equal(word.fluency, 0);
  assert.equal(word.fluency_r, 0);
  assert.ok(word.prior_mastery_q >= 0.7);

  const first = (await getOrIssueTask(db, FIXED_NOW)).task;
  assert.equal(first.type, 'RETRIEVE');
  assert.equal(first.axis, 'r');
  assert.equal(first.purpose, 'verify');
  assert.equal(first.checkpoint, 50);
  assert.equal(first.word_ids[0], word.id);
  // An independent reading task must not reveal its expected meaning in the public payload.
  assert.equal(first.payload.meaning, undefined);

  const refreshed = (await getOrIssueTask(db, FIXED_NOW + 1)).task;
  assert.equal(refreshed.instance_id, first.instance_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM task_instances WHERE status = 'issued'").get().count, 1);

  const firstInput = answerInput(first, word);
  const rejected = {
    ...firstInput,
    evidence: { ...firstInput.evidence, speed_mode: 'none' },
  };
  await assert.rejects(
    submitTaskResult(db, rejected, FIXED_NOW + 2),
    (error) => error.status === 400
  );
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'global_tick'").get().value, '0');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 0);
  assert.equal(db.prepare('SELECT status FROM task_instances WHERE instance_id = ?').get(first.instance_id).status, 'issued');

  // A corrected retry uses the still-mounted task and completes exactly once.
  const firstResult = await submitTaskResult(db, firstInput, FIXED_NOW + 2);
  assert.equal(firstResult.duplicate, false);
  assert.equal(firstResult.writeback.qualified, true);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'global_tick'").get().value, '1');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);

  const repeated = await submitTaskResult(db, firstInput, FIXED_NOW + 3);
  assert.equal(repeated.duplicate, true);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'global_tick'").get().value, '1');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 1);

  // The next axis is independently verified after the shared 20-minute cooldown.
  const second = (await getOrIssueTask(db, FIXED_NOW + CONFIG.H_CACHE_MS + 100)).task;
  assert.equal(second.type, 'RETRIEVE');
  assert.equal(second.axis, 'p');
  assert.equal(second.purpose, 'verify');
  const secondResult = await submitTaskResult(db, answerInput(second, word), FIXED_NOW + CONFIG.H_CACHE_MS + 101);
  assert.equal(secondResult.writeback.qualified, true);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'global_tick'").get().value, '2');

  // The older R trace becomes the next review candidate and is rechecked at its existing score.
  const review = (await getOrIssueTask(db, FIXED_NOW + 2 * CONFIG.H_CACHE_MS + 200)).task;
  assert.equal(review.type, 'RETRIEVE');
  assert.equal(review.axis, 'r');
  assert.equal(review.purpose, 'review');
  assert.equal(review.checkpoint, 50);
  const recheck = await submitTaskResult(db, answerInput(review, word), FIXED_NOW + 2 * CONFIG.H_CACHE_MS + 201);
  assert.equal(recheck.writeback.passed, true);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'global_tick'").get().value, '3');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM events').get().count, 3);
  db.close();
});

test('swipe before confirmed feedback is ignored; retry keeps the mounted answer', () => {
  const page = fs.readFileSync(path.join(root, 'app/page.tsx'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'components/task-renderers.tsx'), 'utf8');
  assert.match(page, /status !== 'feedback'\) return/);
  assert.match(page, /requestLock\.current/);
  assert.doesNotMatch(page, /api\/task\/skip/);
  assert.match(page, /key=\{task\.instance_id\}/);
  assert.match(page, /setStatus\('error'\);\s*throw error;/);
  assert.match(renderer, /value=\{answer\}/);
  assert.match(renderer, /setSubmitting\(false\)/);
  assert.match(renderer, /value=\{answers\[check\.wordId\] \?\? ''\}/);
});

test('responsive task flow keeps long reading material scrollable and readable', () => {
  const css = fs.readFileSync(path.join(root, 'app/page.module.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(root, 'components/task-renderers.tsx'), 'utf8');
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /touch-action: pan-y/);
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(renderer, /className="sentence">\{passage\}/);
  assert.match(renderer, /我读完了，开始回答/);
});

test('keyboard shortcuts distinguish short answers from multiline writing', () => {
  const renderer = fs.readFileSync(path.join(root, 'components/task-renderers.tsx'), 'utf8');
  assert.match(renderer, /event\.key !== 'Enter'/);
  assert.match(renderer, /mode === 'enter'/);
  assert.match(renderer, /keyboardSubmit\(event, 'modified-enter'/);
  assert.match(renderer, /event\.shiftKey/);
  assert.match(renderer, /event\.ctrlKey \|\| event\.metaKey/);
});
