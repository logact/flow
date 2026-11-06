const assert = require('node:assert/strict');
const Module = require('node:module');
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
const { recordTaskExit } = require(path.join(buildDir, 'app/api/task/service.js'));

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
  assert.equal(analytics.instrumentation.skips, false);
  assert.match(analytics.instrumentation.skip_note, /no explicit skip/i);
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
