const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const buildDir = process.env.FLOW_TEST_BUILD_DIR;
if (!buildDir) throw new Error('Run this file through test/run-task-flow-tests.cjs');
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
const { createDb } = require(path.join(buildDir, 'lib/db.js'));
const { CONFIG } = require(path.join(buildDir, 'lib/config.js'));
const { POST } = require(path.join(buildDir, 'app/api/goals/route.js'));
const { getOrIssueTask } = require(path.join(buildDir, 'app/api/task/service.js'));
const { getNextTaskInstance } = require(path.join(buildDir, 'lib/scheduler.js'));
const { sliceMfiDetailed } = require(path.join(buildDir, 'lib/mfi.js'));

const NOW = 1_800_000_000_000;
const ENV = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_NATIVE_LANGUAGE'];
const previousEnv = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
const topicResponse = { terms: ['astronomy', 'planet', 'telescope'] };

function sourceText(mode) {
  return Array.from({ length: 30 }, (_, index) => {
    if (index === 15) return 'A spacecraft follows an orbit around a distant object for many hours.';
    const topical = mode === 'match' ? index >= 10 && index <= 20 : index <= 2 || index >= 27;
    if (topical) return 'Astronomy students observe each planet through a telescope during their careful research.';
    return 'Local residents discuss ordinary weekend plans and share practical advice with their neighbors.';
  }).join(' ');
}

function freshDb() {
  const db = createDb(':memory:');
  db.prepare('DELETE FROM task_instances').run();
  db.prepare('DELETE FROM task_analytics_events').run();
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM words').run();
  db.prepare('DELETE FROM goals').run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('global_tick', '10') ON CONFLICT(key) DO UPDATE SET value = '10'").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('vocab_estimate', '5000') ON CONFLICT(key) DO UPDATE SET value = '5000'").run();
  return db;
}

async function withProvider(run, { content = topicResponse, status = 200 } = {}) {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  process.env.LLM_API_KEY = 'w4-test-secret';
  process.env.LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.LLM_MODEL = 'fixture-model';
  process.env.LLM_NATIVE_LANGUAGE = 'Chinese';
  try {
    await run(() => calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function insertSourceAndWord(db, sourceId, mode) {
  const text = sourceText(mode);
  db.prepare(`INSERT INTO book_sources (id, title, total_tokens, total_sentences, text, summary, created_at)
              VALUES (?, ?, ?, ?, ?, NULL, ?)`).run(
    sourceId, `Astronomy Source ${sourceId}`, text.split(/\s+/).length, 30, text, NOW
  );
  db.prepare(`INSERT INTO book_words (source_id, word, freq, per_million, is_proper, sentences)
              VALUES (?, 'orbit', 50, 100, 0, ?)`).run(sourceId, JSON.stringify([
    'A spacecraft follows an orbit around a distant object for many hours.',
    'A planet moves through space and follows its orbit around a star.',
  ]));
}

async function createBookGoal(db, sourceId) {
  global.__flowDb = db;
  const response = await POST(new Request('http://localhost/api/goals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'book', title: `Goal ${sourceId}`, sourceId, count: 1 }),
  }));
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

function matureRWord(db, goalId) {
  db.prepare(`UPDATE words SET meaning = 'the path followed by a spacecraft around an object', introduced = 1,
    fluency = 100, target_out = 100, verified_p = 1, speed_verified_p = 1,
    stability_time = ?, has_observation_p = 1, last_ts = ?,
    fluency_r = 100, target_in = 100, verified_r = 1, speed_verified_r = 1,
    stability_time_r = ?, has_observation_r = 1, last_ts_r = ?, last_tick = 0
    WHERE goal_id = ?`).run(
    CONFIG.H_TIME_GRAD_MS, NOW - 30 * 60 * 60_000,
    7 * 24 * 60 * 60_000, NOW - 30 * 60 * 60_000, goalId
  );
}

test.after(() => {
  for (const name of ENV) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
  delete global.__flowDb;
});

test('book source topic is AI-tagged, persisted, and admits a matching passage in the scheduler flow', async () => {
  const db = freshDb();
  insertSourceAndWord(db, 7101, 'match');
  await withProvider(async (calls) => {
    const result = await createBookGoal(db, 7101);
    const row = db.prepare('SELECT topic_terms FROM book_sources WHERE id = ?').get(7101);
    assert.deepEqual(JSON.parse(row.topic_terms), topicResponse.terms);
    matureRWord(db, result.goalId);
    const text = db.prepare('SELECT text FROM book_sources WHERE id = ?').get(7101).text;
    const material = sliceMfiDetailed(text, 'orbit', () => true, { topicTerms: JSON.parse(row.topic_terms) });
    assert.equal(material.available, true);
    const candidate = getNextTaskInstance(db, NOW);
    assert.equal(candidate.axis, 'r');
    assert.equal(candidate.type, 'RETRIEVE');
    assert.equal(candidate.payload.material_gaps?.some((gap) => gap.reason === 'topic_missing' || gap.reason === 'topic_mismatch'), false);
    assert.equal(calls(), 1);
    db.close();
  });
});

test('topic mismatch blocks R continuous issue but keeps ordinary R retrieval and records the gap', async () => {
  const db = freshDb();
  insertSourceAndWord(db, 7102, 'mismatch');
  await withProvider(async () => {
    const result = await createBookGoal(db, 7102);
    matureRWord(db, result.goalId);
    const issued = await getOrIssueTask(db, NOW);
    assert.equal(issued.task.axis, 'r');
    assert.equal(issued.task.type, 'RETRIEVE');
    assert.ok(issued.task.payload.material_gaps.some((gap) => gap.reason === 'topic_mismatch'));
    const gap = db.prepare(`SELECT detail FROM task_analytics_events WHERE event_type = 'material_missing' AND definition_id = 'fluency-r'`).get();
    assert.ok(gap);
    assert.match(gap.detail, /topic_mismatch/);
  });
  db.close();
});

test('topic recognition failure is an explicit gap and does not block R retrieval', async () => {
  const db = freshDb();
  insertSourceAndWord(db, 7103, 'match');
  await withProvider(async () => {
    const result = await createBookGoal(db, 7103);
    assert.equal(db.prepare('SELECT topic_terms FROM book_sources WHERE id = ?').get(7103).topic_terms, null);
    matureRWord(db, result.goalId);
    const issued = await getOrIssueTask(db, NOW);
    assert.equal(issued.task.axis, 'r');
    assert.equal(issued.task.type, 'RETRIEVE');
    assert.ok(issued.task.payload.material_gaps.some((gap) => gap.reason === 'topic_missing'));
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM task_analytics_events WHERE event_type = 'material_missing' AND definition_id = 'fluency-r'`).get().count, 1);
  }, { status: 503, content: { error: 'provider unavailable' } });
  db.close();
});

test('legacy source without topic terms is tagged once when a book goal is created', async () => {
  const db = freshDb();
  insertSourceAndWord(db, 7104, 'match');
  await withProvider(async (calls) => {
    await createBookGoal(db, 7104);
    assert.equal(calls(), 1);
    assert.deepEqual(JSON.parse(db.prepare('SELECT topic_terms FROM book_sources WHERE id = ?').get(7104).topic_terms), topicResponse.terms);
  });
  db.close();
});
