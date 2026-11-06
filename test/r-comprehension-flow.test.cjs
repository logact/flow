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
const Database = require('better-sqlite3');
const { CONFIG } = require(path.join(buildDir, 'lib/config.js'));
const { createDb } = require(path.join(buildDir, 'lib/db.js'));
const { getOrIssueTask, submitTaskResult } = require(path.join(buildDir, 'app/api/task/service.js'));
const { TASK_LIBRARY } = require(path.join(buildDir, 'lib/tasks.js'));
const { sliceMfiDetailed } = require(path.join(buildDir, 'lib/mfi.js'));

const NOW = 1_800_000_000_000;
const envNames = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_NATIVE_LANGUAGE'];
const previousEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
let providerRequests = 0;

function configure(baseUrl) {
  process.env.LLM_API_KEY = 'w2-test-secret';
  process.env.LLM_BASE_URL = baseUrl;
  process.env.LLM_MODEL = 'fixture-model';
  process.env.LLM_NATIVE_LANGUAGE = 'Chinese';
}

async function withProvider(run, { status = 200, content, delay = 0, bodyFactory } = {}) {
  providerRequests = 0;
  const server = http.createServer((req, res) => {
    providerRequests++;
    req.resume();
    req.on('end', () => {
      const send = () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        const value = bodyFactory ? bodyFactory(providerRequests) : { choices: [{ message: { content: JSON.stringify(content) } }] };
        res.end(JSON.stringify(value));
      };
      if (delay) setTimeout(send, delay); else send();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  configure(`http://127.0.0.1:${address.port}/v1`);
  try {
    await run();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function memoryDb(sourceId, text) {
  const db = createDb(':memory:');
  db.prepare('DELETE FROM task_instances').run();
  db.prepare('DELETE FROM task_analytics_events').run();
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM words').run();
  db.prepare('DELETE FROM goals').run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('global_tick', '10') ON CONFLICT(key) DO UPDATE SET value = '10'").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('vocab_estimate', '5000') ON CONFLICT(key) DO UPDATE SET value = '5000'").run();
  db.prepare(`INSERT INTO book_sources (id, title, total_tokens, total_sentences, text, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(sourceId, `Source ${sourceId}`, text.split(/\s+/).length, text.split('.').length, text, NOW);
  const goalId = Number(db.prepare(`INSERT INTO goals (type, title, target, created_at) VALUES ('book', ?, ?, ?)`)
    .run(`Goal ${sourceId}`, JSON.stringify({ source_id: sourceId }), NOW).lastInsertRowid);
  return { db, goalId };
}

function insertWord(db, goalId, chunk, overrides = {}) {
  const values = {
    chunk,
    meaning: `meaning of ${chunk}`,
    scene: `From source: ${chunk}`,
    slots: chunk,
    substitute: '',
    step3_sentence: `The word ${chunk} appears in the passage.`,
    step4_sentences: JSON.stringify([`The team can read and discuss ${chunk} each day.`]),
    fluency: 100,
    fluency_r: 60,
    target_in: 100,
    target_out: 100,
    introduced: 1,
    has_observation_p: 1,
    has_observation_r: 1,
    verified_p: 1,
    verified_r: 1,
    speed_verified_p: 1,
    speed_verified_r: 0,
    integrated_p: 0,
    integrated_r: 0,
    stability_time: CONFIG.H_TIME_GRAD_MS,
    stability_time_r: 7 * 24 * 60 * 60_000,
    last_tick: 0,
    last_ts: NOW,
    last_ts_r: NOW - 30 * 60 * 60_000,
    goal_id: goalId,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
  const keys = Object.keys(values);
  return Number(db.prepare(`INSERT INTO words (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`)
    .run(...keys.map((key) => values[key])).lastInsertRowid);
}

function passageFor(targets) {
  const sentences = Array.from({ length: 18 }, (_, index) => {
    const target = targets[index] ? ` People can ${targets[index]} ` : ' people can share ';
    return `The team can read and discuss the plan each day.${target}with others and learn from a clear example.`;
  });
  return sentences.join(' ');
}

function question() {
  return { question: 'What is the passage mainly about?', options: ['A team learning together', 'A person buying a house', 'A storm at sea'], answerIndex: 0 };
}

function submitInput(task, db, passageAnswerIndex) {
  const definition = TASK_LIBRARY.find((entry) => entry.id === task.definition_id);
  return {
    instance_id: task.instance_id,
    response: {
      word_answers: task.word_ids.map((word_id) => ({
        word_id,
        answer: db.prepare('SELECT meaning FROM words WHERE id = ?').get(word_id).meaning,
      })),
      passage_answer_index: passageAnswerIndex,
    },
    evidence: {
      independent: true,
      answer_revealed: false,
      hint_used: false,
      accuracy: Object.fromEntries(definition.evidence.accuracy_check.map((key) => [key, true])),
      speed_mode: definition.evidence.speed_mode,
      speed_value: null,
      duration_ms: 60_000,
      word_results: task.word_ids.map((word_id) => ({ word_id, correct: true })),
    },
  };
}

function ordinaryReadingFixture(sourceId = 1001) {
  const text = passageFor(['reflect']);
  const { db, goalId } = memoryDb(sourceId, text);
  const id = insertWord(db, goalId, 'reflect');
  return { db, ids: [id], text };
}

function integrationFixture(sourceId = 1002, missingTarget = null, missingGloss = null) {
  const chunks = ['focus', 'adapt', 'measure', 'ensure', 'reflect'].slice(0, CONFIG.BATCH_SIZE);
  const text = passageFor(chunks.filter((chunk) => chunk !== missingTarget));
  const { db, goalId } = memoryDb(sourceId, text);
  const ids = chunks.map((chunk) => insertWord(db, goalId, chunk, {
    meaning: chunk === missingGloss ? '' : `meaning of ${chunk}`,
    fluency_r: 80,
    integrated_r: 0,
  }));
  return { db, ids, chunks, text };
}

test.after(() => {
  for (const name of envNames) {
    if (previousEnv[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnv[name];
  }
});

test('R FLUENCY issues an AI-keyed passage question and only the server key is persisted', async () => {
  const { db, ids } = ordinaryReadingFixture();
  await withProvider(async () => {
    const issued = await getOrIssueTask(db, NOW);
    const task = issued.task;
    assert.equal(task.type, 'FLUENCY', JSON.stringify(task));
    assert.equal(task.axis, 'r');
    assert.match(task.payload.comprehension_question, /mainly about/);
    assert.equal(task.payload.options.length, 3);
    assert.equal(task.payload.answer_index, undefined);
    assert.equal(task.payload.meaning, undefined);
    const stored = JSON.parse(db.prepare('SELECT instance_json FROM task_instances WHERE instance_id = ?').get(task.instance_id).instance_json);
    assert.equal(stored.payload.answer_index, 0);
    assert.equal(stored.payload.comprehension_question, task.payload.comprehension_question);

    const before = db.prepare('SELECT * FROM words WHERE id = ?').get(ids[0]);
    const result = await submitTaskResult(db, submitInput(task, db, 0), NOW + 1);
    assert.equal(result.writeback.passed, true);
    const after = db.prepare('SELECT * FROM words WHERE id = ?').get(ids[0]);
    assert.ok(after.fluency_r >= before.fluency_r);
    assert.equal(after.fluency, before.fluency);
    assert.equal(after.integrated_r, 0);
  }, { content: question() });
  assert.equal(providerRequests, 1);
  db.close();
});

test('wrong comprehension cannot certify R FLUENCY; P state stays isolated', async () => {
  const { db, ids } = ordinaryReadingFixture(1003);
  await withProvider(async () => {
    const task = (await getOrIssueTask(db, NOW)).task;
    const before = db.prepare('SELECT * FROM words WHERE id = ?').get(ids[0]);
    const result = await submitTaskResult(db, submitInput(task, db, 2), NOW + 1);
    assert.equal(result.writeback.passed, false);
    const after = db.prepare('SELECT * FROM words WHERE id = ?').get(ids[0]);
    assert.equal(after.fluency_r, before.fluency_r);
    assert.equal(after.verified_r, 0);
    assert.equal(after.fluency, before.fluency);
    assert.equal(after.verified_p, before.verified_p);
  }, { content: question() });
  db.close();
});

test('R INTEGRATE is scheduler-reachable with a same-source passage covering every target', async () => {
  const { db, ids } = integrationFixture();
  await withProvider(async () => {
    const task = (await getOrIssueTask(db, NOW)).task;
    assert.equal(task.type, 'INTEGRATE');
    assert.equal(task.axis, 'r');
    assert.equal(task.word_ids.length, CONFIG.BATCH_SIZE);
    assert.equal(task.payload.target_checks.length, CONFIG.BATCH_SIZE);
    assert.equal(task.payload.options.length, 3);
    assert.equal(task.payload.answer_index, undefined);
    const before = ids.map((id) => db.prepare('SELECT * FROM words WHERE id = ?').get(id));
    const result = await submitTaskResult(db, submitInput(task, db, 0), NOW + 1);
    assert.equal(result.writeback.passed, true);
    ids.forEach((id, index) => {
      const after = db.prepare('SELECT * FROM words WHERE id = ?').get(id);
      assert.equal(after.integrated_r, 1);
      assert.equal(after.integrated_p, 0);
      assert.equal(after.fluency, before[index].fluency);
      assert.equal(after.fluency_r, before[index].fluency_r);
    });
  }, { content: question() });
  db.close();
});

test('missing batch target or gloss never unlocks R INTEGRATE', async () => {
  const missingTarget = integrationFixture(1004, 'ensure');
  const slice = sliceMfiDetailed(missingTarget.text, 'focus', () => true, {
    targetWords: missingTarget.ids.map((wordId, index) => ({ wordId, chunk: missingTarget.chunks[index], meaning: `meaning ${index}` })),
  });
  assert.equal(slice.available, false);
  assert.equal(slice.reason, 'target_word_missing');
  await withProvider(async () => {
    const task = (await getOrIssueTask(missingTarget.db, NOW)).task;
    assert.notEqual(task.type, 'INTEGRATE');
  }, { content: question() });
  missingTarget.db.close();

  const missingGloss = integrationFixture(1005, null, 'measure');
  await withProvider(async () => {
    const task = (await getOrIssueTask(missingGloss.db, NOW)).task;
    assert.notEqual(task.type, 'INTEGRATE');
  }, { content: question() });
  missingGloss.db.close();
});

test('malformed AI question fails closed to R retrieval and records the missing-material gap', async () => {
  const { db } = ordinaryReadingFixture(1006);
  await withProvider(async () => {
    const response = await getOrIssueTask(db, NOW);
    assert.equal(response.task.type, 'RETRIEVE');
    assert.equal(response.task.axis, 'r');
    assert.equal(response.task.payload.material_fallback, 'comprehension_question_unavailable');
    assert.equal(response.material_gap.reason, 'comprehension_generation_failed');
    assert.equal(providerRequests, 1);
  }, { content: { question: 'Only two choices', options: ['yes', 'no'], answerIndex: 0 } });
  const event = db.prepare(`SELECT event_type, detail FROM task_analytics_events WHERE event_type = 'material_missing'`).get();
  assert.ok(event);
  assert.match(event.detail, /comprehension_generation_failed/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM task_instances WHERE status = 'issued' AND instance_json LIKE '%FLUENCY%'`).get().n, 0);
  db.close();
});

test('concurrent GETs converge on one completely keyed issued instance', async () => {
  const { db } = ordinaryReadingFixture(1007);
  await withProvider(async () => {
    const [left, right] = await Promise.all([getOrIssueTask(db, NOW), getOrIssueTask(db, NOW + 1)]);
    assert.equal(left.task.instance_id, right.task.instance_id);
    assert.equal(left.task.payload.options.length, 3);
    assert.equal(right.task.payload.answer_index, undefined);
    assert.equal(providerRequests, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM task_instances WHERE status = 'issued'`).get().n, 1);
  }, { content: question(), delay: 20 });
  db.close();
});
