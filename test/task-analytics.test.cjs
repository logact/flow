const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const buildDir = process.env.FLOW_TEST_BUILD_DIR;
if (!buildDir) throw new Error('Run with node test/run-task-flow-tests.cjs');

const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function resolveAlias(request, parent, isMain, options) {
  if (request.startsWith('@/')) request = path.join(buildDir, `${request.slice(2)}.js`);
  return resolveFilename.call(this, request, parent, isMain, options);
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};

const Database = require('better-sqlite3');
const { createDb } = require(path.join(buildDir, 'lib/db.js'));
const { getTaskAnalytics } = require(path.join(buildDir, 'lib/task-analytics.js'));
const { recordTaskExit, skipTask, submitTaskResult, TaskApiError } = require(path.join(buildDir, 'app/api/task/service.js'));

test('analytics groups evidence by task dimensions and reports rates/speed distribution', () => {
  const db = createDb(':memory:');
  db.prepare('DELETE FROM events').run();
  db.prepare(`INSERT INTO events (tick, ts, kind, word_id, result, detail)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    1, 1_800_000_000_000, 'RETRIEVE:review:r', 10, 'pass', JSON.stringify({
      definition_id: 'retrieve-r', checkpoint: 50, speed_value: 160, recheck: true,
    })
  );
  db.prepare(`INSERT INTO events (tick, ts, kind, word_id, result, detail)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    2, 1_800_000_060_000, 'RETRIEVE:review:r', 10, 'fail', JSON.stringify({
      definition_id: 'retrieve-r', checkpoint: 50, speed_value: 140, recheck: true,
    })
  );
  db.prepare(`INSERT INTO events (tick, ts, kind, word_id, result, detail)
    VALUES (?, ?, ?, ?, ?, ?)`).run(
    3, 1_800_000_090_000, 'RETRIEVE:verify:r', 11, 'pass', JSON.stringify({
      definition_id: 'retrieve-r', checkpoint: 50, speed_value: 170, recheck: false,
    })
  );
  db.prepare(`INSERT INTO task_analytics_events
    (event_id, event_type, definition_id, axis, checkpoint, purpose, ts, detail)
    VALUES ('material:2', 'material_missing', 'retrieve-r', 'r', 50, 'review', ?, ?)`)
    .run(1_800_000_060_000, JSON.stringify({ reason: 'materials_unavailable' }));

  const analytics = getTaskAnalytics(db);
  const group = analytics.groups.find((row) =>
    row.definition_id === 'retrieve-r' && row.axis === 'r' && row.checkpoint === 50 && row.purpose === 'review'
  );
  assert.ok(group);
  assert.equal(group.attempts, 2);
  assert.equal(group.passed, 1);
  assert.equal(group.failed, 1);
  assert.equal(group.pass_rate, 0.5);
  assert.equal(group.recheck_attempts, 2);
  assert.equal(group.recheck_failures, 1);
  assert.equal(group.recheck_failure_rate, 0.5);
  assert.equal(group.material_missing, 1);
  const firstVerify = analytics.groups.find((row) => row.purpose === 'verify');
  assert.equal(firstVerify.recheck_attempts, 0);
  assert.equal(analytics.totals.attempts, 3);
  assert.equal(analytics.totals.skip_count, 0);
  assert.equal(analytics.totals.material_missing, 1);
  assert.deepEqual(group.speed_distribution, {
    count: 2, mean: 150, min: 140, p50: 140, p90: 160, max: 160,
  });
  assert.equal(analytics.instrumentation.skips, true);
  db.close();
});

test('page exit telemetry is idempotent, dimensioned, and contains no response text', () => {
  const db = createDb(':memory:');
  const instance = {
    instance_id: 'instance-exit-1',
    definition_id: 'retrieve-r',
    type: 'RETRIEVE',
    checkpoint: 35,
    axis: 'r',
    purpose: 'review',
    word_ids: [1],
    payload: { chunk: 'sample', meaning: 'private answer' },
    renderer: 'retrieve-r',
    issued_at: 1_800_000_000_000,
  };
  db.prepare(`INSERT INTO task_instances (instance_id, status, instance_json, issued_at)
    VALUES (?, 'issued', ?, ?)`)
    .run(instance.instance_id, JSON.stringify(instance), instance.issued_at);

  assert.equal(recordTaskExit(db, instance.instance_id, instance.issued_at + 1), true);
  assert.equal(recordTaskExit(db, instance.instance_id, instance.issued_at + 2), false);
  const row = db.prepare(`SELECT event_type, definition_id, axis, checkpoint, purpose, detail
    FROM task_analytics_events WHERE event_id = ?`).get(`exit:${instance.instance_id}`);
  assert.deepEqual(row, {
    event_type: 'task_exit',
    definition_id: 'retrieve-r',
    axis: 'r',
    checkpoint: 35,
    purpose: 'review',
    detail: '{}',
  });
  assert.equal(getTaskAnalytics(db).groups.find((group) => group.definition_id === 'retrieve-r').exits, 1);
  db.close();
});

function insertIssued(db, instanceId) {
  const instance = {
    instance_id: instanceId, definition_id: 'retrieve-r', type: 'RETRIEVE', checkpoint: 35,
    axis: 'r', purpose: 'review', word_ids: [1], payload: { chunk: 'sample', meaning: 'private answer' },
    renderer: 'retrieve-r', issued_at: 1_800_000_000_000,
  };
  db.prepare(`INSERT INTO task_instances (instance_id, status, instance_json, issued_at)
    VALUES (?, 'issued', ?, ?)`).run(instanceId, JSON.stringify(instance), instance.issued_at);
  return instance;
}

test('explicit skip is idempotent, terminal, lifecycle-exclusive, and leaves learning state unchanged', async () => {
  const db = createDb(':memory:');
  const instance = insertIssued(db, 'skip-flow-1');
  const before = {
    tick: db.prepare("SELECT value FROM meta WHERE key='global_tick'").get(),
    events: db.prepare('SELECT * FROM events ORDER BY id').all(),
    words: db.prepare('SELECT * FROM words ORDER BY id').all(),
  };
  assert.equal(recordTaskExit(db, instance.instance_id, instance.issued_at + 1), true);
  const first = await skipTask(db, instance.instance_id, instance.issued_at + 2);
  assert.notEqual(first.task.type, 'EMPTY');
  assert.equal(db.prepare("SELECT status FROM task_instances WHERE instance_id=?").get(first.task.instance_id).status, 'issued');
  assert.equal(db.prepare('SELECT status FROM task_instances WHERE instance_id=?').get(instance.instance_id).status, 'skipped');
  assert.equal(recordTaskExit(db, instance.instance_id, instance.issued_at + 3), false);
  const duplicate = await skipTask(db, instance.instance_id, instance.issued_at + 4);
  assert.equal(duplicate.skipped, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM task_analytics_events WHERE event_type='task_skipped' AND instance_id=?").get(instance.instance_id).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM task_analytics_events WHERE event_type='task_exit' AND instance_id=?").get(instance.instance_id).c, 0);
  assert.deepEqual(db.prepare("SELECT value FROM meta WHERE key='global_tick'").get(), before.tick);
  assert.deepEqual(db.prepare('SELECT * FROM events ORDER BY id').all(), before.events);
  assert.deepEqual(db.prepare('SELECT * FROM words ORDER BY id').all(), before.words);
  assert.equal(getTaskAnalytics(db).groups.find((group) => group.definition_id === 'retrieve-r').skip_rate, 1);
  await assert.rejects(() => submitTaskResult(db, { instance_id: instance.instance_id, response: {} }), (error) => error instanceof TaskApiError && error.status === 409);
  db.close();
});

test('submitted cannot skip, while an issued page-exit can later be explicitly skipped', async () => {
  const db = createDb(':memory:');
  const submitted = insertIssued(db, 'skip-flow-submitted');
  db.prepare("UPDATE task_instances SET status='submitted' WHERE instance_id=?").run(submitted.instance_id);
  await assert.rejects(() => skipTask(db, submitted.instance_id), (error) => error instanceof TaskApiError && error.status === 409);
  const issued = insertIssued(db, 'skip-flow-exit');
  assert.equal(recordTaskExit(db, issued.instance_id, issued.issued_at + 1), true);
  await skipTask(db, issued.instance_id, issued.issued_at + 2);
  const events = db.prepare('SELECT event_type FROM task_analytics_events WHERE instance_id=?').all(issued.instance_id);
  assert.deepEqual(events.map((event) => event.event_type), ['task_skipped']);
  const analytics = getTaskAnalytics(db);
  const group = analytics.groups.find((item) => item.definition_id === 'retrieve-r');
  assert.equal(group.exits, 0);
  assert.equal(group.skipped, 1);
  assert.equal(group.skip_denominator, 1);
  assert.equal(group.exit_denominator, 1);
  db.close();
});

test('legacy task_instances CHECK constraint migrates without losing an issued row', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'flow-skip-migration-')), 'legacy.db');
  const legacy = new Database(file);
  legacy.exec(`CREATE TABLE task_instances (
    instance_id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('issued', 'submitted')),
    instance_json TEXT NOT NULL, issued_at INTEGER NOT NULL, submitted_at INTEGER, response_json TEXT, writeback_json TEXT
  ); CREATE UNIQUE INDEX one_issued_task_instance ON task_instances(status) WHERE status = 'issued';`);
  legacy.prepare("INSERT INTO task_instances (instance_id,status,instance_json,issued_at) VALUES ('preserve-me','issued','{}',1)").run();
  legacy.close();
  const migrated = createDb(file);
  const schema = migrated.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_instances'").get().sql;
  assert.match(schema, /'skipped'/);
  assert.equal(migrated.prepare('SELECT status, skipped_at FROM task_instances WHERE instance_id=?').get('preserve-me').status, 'issued');
  migrated.prepare("UPDATE task_instances SET status='skipped', skipped_at=2 WHERE instance_id='preserve-me'").run();
  migrated.close();
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});
