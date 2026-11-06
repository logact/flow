const assert = require('node:assert/strict');
const http = require('node:http');
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
const { createGoal, listGoalWords } = require(path.join(buildDir, 'lib/goals.js'));
const { GET, PATCH, POST } = require(path.join(buildDir, 'app/api/goals/route.js'));
const { submitTaskResult, getOrIssueTask, TaskApiError } = require(path.join(buildDir, 'app/api/task/service.js'));
const { TASK_LIBRARY } = require(path.join(buildDir, 'lib/tasks.js'));

const NOW = 1_800_000_000_000;
const envNames = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_NATIVE_LANGUAGE'];
const previousEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));

function cleanDb() {
  const db = createDb(':memory:');
  db.prepare('DELETE FROM task_instances').run();
  db.prepare('DELETE FROM task_analytics_events').run();
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM words').run();
  db.prepare('DELETE FROM goals').run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('global_tick', '0') ON CONFLICT(key) DO UPDATE SET value = '0'").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('vocab_estimate', '5000') ON CONFLICT(key) DO UPDATE SET value = '5000'").run();
  global.__flowDb = db;
  return db;
}

async function withLlm(content, run, status = 200) {
  const server = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  process.env.LLM_API_KEY = 'w1-test-secret';
  process.env.LLM_BASE_URL = `http://127.0.0.1:${address.port}/v1`;
  process.env.LLM_MODEL = 'fixture-model';
  process.env.LLM_NATIVE_LANGUAGE = 'Chinese';
  try {
    await run();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function resultInput(instance, wordId, answer) {
  const definition = TASK_LIBRARY.find((entry) => entry.id === instance.definition_id);
  return {
    instance_id: instance.instance_id,
    response: { word_answers: [{ word_id: wordId, answer }] },
    evidence: {
      independent: true,
      answer_revealed: false,
      hint_used: false,
      accuracy: Object.fromEntries(definition.evidence.accuracy_check.map((key) => [key, true])),
      speed_mode: definition.evidence.speed_mode,
      speed_value: null,
      duration_ms: null,
      word_results: [{ word_id: wordId, correct: true }],
    },
  };
}

function issueRTask(db, wordId) {
  const definition = TASK_LIBRARY.find((entry) => entry.id === 'retrieve-r');
  const instance = {
    instance_id: `w1-r-${wordId}`,
    definition_id: definition.id,
    type: definition.type,
    checkpoint: 20,
    axis: 'r',
    purpose: 'review',
    word_ids: [wordId],
    payload: { word_id: wordId, evidence: definition.evidence },
    renderer: definition.renderer,
    issued_at: NOW,
  };
  db.prepare(`INSERT INTO task_instances (instance_id, status, instance_json, issued_at)
              VALUES (?, 'issued', ?, ?)`)
    .run(instance.instance_id, JSON.stringify(instance), NOW);
  return instance;
}

test.after(() => {
  for (const name of envNames) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
  delete global.__flowDb;
});

test('glossless imports remain blank; AI suggestion is not saved until explicitly confirmed', async () => {
  const db = cleanDb();
  const imported = await createGoal(db, { type: 'wordlist', title: 'Blank gloss', text: 'serendipity\nserendipitous' }, NOW);
  assert.equal(imported.glossMissing, 2);
  const word = db.prepare('SELECT id, meaning FROM words WHERE goal_id = ? AND chunk = ?').get(imported.goalId, 'serendipity');
  const aiWord = db.prepare('SELECT id, meaning FROM words WHERE goal_id = ? AND chunk = ?').get(imported.goalId, 'serendipitous');
  assert.equal(word.meaning, '');
  assert.equal(listGoalWords(db, imported.goalId).words[0].meaning, '');

  const listResponse = await GET(new Request(`http://localhost/api/goals?words=${imported.goalId}`));
  assert.equal(listResponse.status, 200);
  assert.equal((await listResponse.json()).words[0].meaning, '');

  await withLlm({ gloss: '偶然发现' }, async () => {
    const suggestionResponse = await POST(new Request('http://localhost/api/goals', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'suggest_gloss', wordId: word.id }),
    }));
    assert.equal(suggestionResponse.status, 200);
    assert.deepEqual(await suggestionResponse.json(), { suggestion: '偶然发现' });
    assert.equal(db.prepare('SELECT meaning FROM words WHERE id = ?').get(word.id).meaning, '');

    // Declining the first suggestion leaves the word blank; a manual gloss can be saved.
    assert.equal(db.prepare('SELECT meaning FROM words WHERE id = ?').get(word.id).meaning, '');
    const manualResponse = await PATCH(new Request('http://localhost/api/goals', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wordId: word.id, meaning: 'A fortunate discovery made by chance' }),
    }));
    assert.equal(manualResponse.status, 200);
    assert.equal(db.prepare('SELECT meaning FROM words WHERE id = ?').get(word.id).meaning, 'A fortunate discovery made by chance');

    const secondSuggestion = await POST(new Request('http://localhost/api/goals', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'suggest_gloss', wordId: aiWord.id }),
    }));
    const suggested = await secondSuggestion.json();
    assert.equal(suggested.suggestion, '偶然发现');
    const confirmedResponse = await PATCH(new Request('http://localhost/api/goals', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wordId: aiWord.id, meaning: suggested.suggestion }),
    }));
    assert.equal(confirmedResponse.status, 200);
    assert.equal(db.prepare('SELECT meaning FROM words WHERE id = ?').get(aiWord.id).meaning, '偶然发现');
  });
  db.close();
});

test('glossless new word receives P first, and stale/malformed R cannot pass with an empty expected gloss', async () => {
  const db = cleanDb();
  const imported = await createGoal(db, { type: 'wordlist', title: 'P fallback', text: 'serendipity' }, NOW);
  const word = db.prepare('SELECT * FROM words WHERE goal_id = ?').get(imported.goalId);
  const first = getOrIssueTask(db, NOW).task;
  assert.notEqual(first.type, 'EMPTY');
  assert.equal(first.axis, 'p');
  assert.equal(first.word_ids[0], word.id);

  // A persisted pre-W1 R instance is retired without changing learning state.
  db.prepare('DELETE FROM task_instances WHERE status = \'issued\'').run();
  const r = issueRTask(db, word.id);
  const tickBefore = db.prepare("SELECT value FROM meta WHERE key = 'global_tick'").get().value;
  await assert.rejects(submitTaskResult(db, resultInput(r, word.id, 'anything'), NOW + 1),
    (error) => error instanceof TaskApiError && error.status === 409);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'global_tick'").get().value, tickBefore);
  assert.equal(db.prepare('SELECT status FROM task_instances WHERE instance_id = ?').get(r.instance_id).status, 'issued');
  const reissued = getOrIssueTask(db, NOW + 2).task;
  assert.equal(reissued.axis, 'p');
  db.close();
});

test('server accepts AI-confirmed R synonym and rejects a wrong meaning', async () => {
  const db = cleanDb();
  const imported = await createGoal(db, { type: 'wordlist', title: 'R synonym', text: 'transform - major change' }, NOW);
  const word = db.prepare('SELECT id FROM words WHERE goal_id = ?').get(imported.goalId);
  const instance = issueRTask(db, word.id);

  await withLlm({ results: [{ word_id: word.id, correct: true }] }, async () => {
    const answer = await submitTaskResult(db, resultInput(instance, word.id, 'a significant change'), NOW + 1);
    assert.equal(answer.writeback.passed, true);
    assert.equal(db.prepare('SELECT status FROM task_instances WHERE instance_id = ?').get(instance.instance_id).status, 'submitted');
  });
  db.close();

  const wrongDb = cleanDb();
  const wrongGoal = await createGoal(wrongDb, { type: 'wordlist', title: 'R wrong', text: 'transform - major change' }, NOW);
  const wrongWord = wrongDb.prepare('SELECT id FROM words WHERE goal_id = ?').get(wrongGoal.goalId);
  const wrongInstance = issueRTask(wrongDb, wrongWord.id);
  await withLlm({ results: [{ word_id: wrongWord.id, correct: false }] }, async () => {
    const answer = await submitTaskResult(wrongDb, resultInput(wrongInstance, wrongWord.id, 'a delicious meal'), NOW + 1);
    assert.equal(answer.writeback.passed, false);
  });
  wrongDb.close();
});

test('AI failure fails closed without committing the R attempt', async () => {
  const db = cleanDb();
  const imported = await createGoal(db, { type: 'wordlist', title: 'R failure', text: 'transform - major change' }, NOW);
  const word = db.prepare('SELECT id FROM words WHERE goal_id = ?').get(imported.goalId);
  const instance = issueRTask(db, word.id);
  await withLlm({ error: 'private-provider-detail' }, async () => {
    // Return a provider failure rather than an apparently useful verdict.
    process.env.LLM_BASE_URL = process.env.LLM_BASE_URL;
    await assert.rejects(submitTaskResult(db, resultInput(instance, word.id, 'substantial change'), NOW + 1),
      (error) => error instanceof TaskApiError && error.status === 503);
  }, 503);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'global_tick'").get().value, '0');
  assert.equal(db.prepare('SELECT status FROM task_instances WHERE instance_id = ?').get(instance.instance_id).status, 'issued');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  db.close();
});

test('malformed AI verdict fails closed and preserves the R instance', async () => {
  const db = cleanDb();
  const imported = await createGoal(db, { type: 'wordlist', title: 'R schema', text: 'transform - major change' }, NOW);
  const word = db.prepare('SELECT id FROM words WHERE goal_id = ?').get(imported.goalId);
  const instance = issueRTask(db, word.id);
  await withLlm({ results: [{ word_id: word.id + 1, correct: true }] }, async () => {
    await assert.rejects(submitTaskResult(db, resultInput(instance, word.id, 'significant change'), NOW + 1),
      (error) => error instanceof TaskApiError && error.status === 503);
  });
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'global_tick'").get().value, '0');
  assert.equal(db.prepare('SELECT status FROM task_instances WHERE instance_id = ?').get(instance.instance_id).status, 'issued');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
  db.close();
});

test('gloss editor clearly distinguishes uncommitted AI suggestions from saved meanings', () => {
  const fs = require('node:fs');
  const page = fs.readFileSync(path.join(__dirname, '..', 'app/goals/page.tsx'), 'utf8');
  assert.match(page, /AI 结果只是建议/);
  assert.match(page, /AI 建议（尚未保存）/);
  assert.match(page, /采用并保存/);
});
