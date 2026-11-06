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
const { getOrIssueTask, submitTaskResult, TaskApiError } = require(path.join(buildDir, 'app/api/task/service.js'));
const { TASK_LIBRARY } = require(path.join(buildDir, 'lib/tasks.js'));

const NOW = 1_800_000_000_000;
const envNames = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_NATIVE_LANGUAGE'];
const previousEnv = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
let providerRequests = 0;
let lastProviderUser = '';

function configure(baseUrl) {
  process.env.LLM_API_KEY = 'w3-test-secret';
  process.env.LLM_BASE_URL = baseUrl;
  process.env.LLM_MODEL = 'fixture-model';
  process.env.LLM_NATIVE_LANGUAGE = 'Chinese';
}

async function withProvider(run, { status = 200, judgment, delay = 0 } = {}) {
  providerRequests = 0;
  lastProviderUser = '';
  const server = http.createServer((req, res) => {
    providerRequests++;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const request = JSON.parse(Buffer.concat(chunks).toString());
      lastProviderUser = request.messages?.[1]?.content ?? '';
      const send = () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        const value = { choices: [{ message: { content: JSON.stringify(judgment) } }] };
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

function resetDb() {
  const db = createDb(':memory:');
  db.prepare('DELETE FROM task_instances').run();
  db.prepare('DELETE FROM task_analytics_events').run();
  db.prepare('DELETE FROM events').run();
  db.prepare('DELETE FROM words').run();
  db.prepare('DELETE FROM goals').run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('global_tick', '10') ON CONFLICT(key) DO UPDATE SET value = '10'").run();
  const goalId = Number(db.prepare(`INSERT INTO goals (type, title, target, created_at) VALUES ('wordlist', 'P expression', ?, ?)`)
    .run(JSON.stringify({ writing_wpm: 25 }), NOW).lastInsertRowid);
  return { db, goalId };
}

const paragraphs = {
  clarify: 'During the review, the team used clear examples to clarify the proposal for new employees. Each person asked questions about the schedule, and the manager explained the budget, the risks, and the goals before everyone agreed on the next steps.',
  focus: 'During the project, the team chose to focus on one shared goal. They discussed each idea carefully, wrote down the important details, and agreed on a simple plan that everyone could understand and follow throughout the week.',
  adapt: 'During the project, the team decided to adapt the process after listening to several useful suggestions. They changed the order of the work, shared responsibilities fairly, and checked that everyone understood the new plan before continuing.',
  measure: 'During the project, the team needed to measure progress carefully. They compared the results with their original goals, discussed the differences openly, and used the information to decide which steps should come next.',
  ensure: 'During the project, the team worked to ensure that every participant understood the safety rules. They checked the instructions together, answered questions, and confirmed that the equipment was ready before the activity began.',
  reflect: 'At the end of the project, the team took time to reflect on what had worked well. They described the challenges honestly, thanked each person for their effort, and wrote down lessons that could help with future work.',
};
function paragraphFor(chunk) { return paragraphs[chunk] ?? paragraphs.clarify; }

function insertWord(db, goalId, chunk, meaning, overrides = {}) {
  const values = {
    chunk, meaning, scene: 'P test material', slots: chunk, substitute: '',
    step3_sentence: `The team can ${chunk} the plan carefully.`,
    step4_sentences: JSON.stringify([paragraphFor(chunk)]),
    fluency: 75, fluency_r: 100, target_in: 100, target_out: 100,
    introduced: 1, has_observation_p: 1, has_observation_r: 1,
    verified_p: 1, verified_r: 1, speed_verified_p: 0, speed_verified_r: 1,
    integrated_p: 0, integrated_r: 1,
    stability_time: CONFIG.H_TIME_GRAD_MS, stability_time_r: CONFIG.H_TIME_GRAD_MS,
    last_tick: 3, last_ts: NOW - 5 * 24 * 60 * 60_000, last_ts_r: NOW,
    goal_id: goalId, created_at: NOW, updated_at: NOW,
    ...overrides,
  };
  const columns = Object.keys(values);
  return Number(db.prepare(`INSERT INTO words (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((column) => values[column])).lastInsertRowid);
}

function fluencyFixture({ chunk = 'clarify', meaning = 'make something easier to understand' } = {}) {
  const state = resetDb();
  const id = insertWord(state.db, state.goalId, chunk, meaning);
  return { ...state, ids: [id] };
}

function integrationFixture({ blankGloss = false } = {}) {
  const state = resetDb();
  const chunks = ['focus', 'adapt', 'measure', 'ensure', 'reflect'].slice(0, CONFIG.BATCH_SIZE);
  const ids = chunks.map((chunk) => insertWord(
    state.db, state.goalId, chunk, blankGloss ? '' : `the act of ${chunk}ing something`,
    { fluency: 80 }
  ));
  return { ...state, ids, chunks };
}

function pPassageJudgment(ids, overrides = {}) {
  return {
    coherent: true,
    grammatical: true,
    targets: ids.map((word_id) => ({ word_id, correct: true })),
    ...overrides,
  };
}

function submissionFor(task, text) {
  const definition = TASK_LIBRARY.find((entry) => entry.id === task.definition_id);
  return {
    instance_id: task.instance_id,
    response: { text },
    evidence: {
      independent: true,
      answer_revealed: false,
      hint_used: false,
      accuracy: { target_word: true, expression: true },
      speed_mode: definition.evidence.speed_mode,
      speed_value: 999999,
      duration_ms: 60_000,
      word_results: task.word_ids.map((word_id) => ({ word_id, correct: true })),
    },
  };
}

async function issuePFluency(db) {
  const issued = await getOrIssueTask(db, NOW);
  assert.equal(issued.task.axis, 'p');
  assert.equal(issued.task.type, 'FLUENCY', JSON.stringify(issued.task.payload));
  return issued.task;
}

test.after(() => {
  for (const key of envNames) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

test('P FLUENCY uses server AI for coherence, grammar, and meaning; client verdict is ignored', async () => {
  const { db, ids } = fluencyFixture();
  const task = await issuePFluency(db);
  const pBefore = db.prepare('SELECT fluency, speed_verified_p, fluency_r, integrated_p, integrated_r FROM words WHERE id = ?').get(ids[0]);
  await withProvider(async () => {
    const result = await submitTaskResult(db, submissionFor(task, paragraphFor('clarify')), NOW + 1);
    assert.equal(result.writeback.passed, true);
    assert.equal(providerRequests, 1);
    const request = JSON.parse(lastProviderUser);
    assert.equal(request.text, paragraphFor('clarify'));
    assert.equal(request.targets[0].expected_meaning, 'make something easier to understand');
    const after = db.prepare('SELECT fluency, speed_verified_p, fluency_r, integrated_p, integrated_r FROM words WHERE id = ?').get(ids[0]);
    assert.ok(after.fluency >= pBefore.fluency);
    assert.equal(after.speed_verified_p, 1);
    assert.equal(after.fluency_r, pBefore.fluency_r);
    assert.equal(after.integrated_p, pBefore.integrated_p);
    assert.equal(after.integrated_r, pBefore.integrated_r);
  }, { judgment: pPassageJudgment(ids) });
  db.close();
});

test('P INTEGRATE requires every target verdict and updates only integrated_p', async () => {
  const { db, ids, chunks } = integrationFixture();
  const task = (await getOrIssueTask(db, NOW)).task;
  assert.equal(task.type, 'INTEGRATE');
  assert.equal(task.axis, 'p');
  assert.deepEqual([...task.word_ids].sort((a, b) => a - b), [...ids].sort((a, b) => a - b));
  const pBefore = db.prepare(`SELECT id, fluency, fluency_r, integrated_p, integrated_r FROM words ORDER BY id`).all();
  const allTargets = pPassageJudgment(ids);
  await withProvider(async () => {
    const result = await submitTaskResult(db, submissionFor(task, chunks.map(paragraphFor).join(' ')), NOW + 1);
    assert.equal(result.writeback.passed, true);
    const after = db.prepare(`SELECT id, fluency, fluency_r, integrated_p, integrated_r FROM words ORDER BY id`).all();
    after.forEach((row, index) => {
      assert.equal(row.fluency, pBefore[index].fluency);
      assert.equal(row.fluency_r, pBefore[index].fluency_r);
      assert.equal(row.integrated_p, 1);
      assert.equal(row.integrated_r, pBefore[index].integrated_r);
    });
  }, { judgment: allTargets });
  db.close();
});

test('incorrect grammar, semantics, missing targets, and irrelevant repetition cannot pass P FLUENCY', async (t) => {
  const repeated = 'clarify clarify clarify '.repeat(12);
  for (const [name, text, judgment] of [
    ['grammar', paragraphFor('clarify'), pPassageJudgment([1], { grammatical: false })],
    ['coherence', paragraphFor('clarify'), pPassageJudgment([1], { coherent: false })],
    ['wrong target meaning', paragraphFor('clarify'), pPassageJudgment([1], { targets: [{ word_id: 1, correct: false }] })],
    ['missing target use', paragraphFor('clarify'), pPassageJudgment([1], { targets: [{ word_id: 1, correct: false }] })],
    ['irrelevant repetition', repeated, pPassageJudgment([1], { coherent: false, targets: [{ word_id: 1, correct: false }] })],
  ]) {
    await t.test(name, async () => {
      const { db, ids } = fluencyFixture();
      const task = await issuePFluency(db);
      const score = db.prepare('SELECT fluency FROM words WHERE id = ?').get(ids[0]).fluency;
      const adjusted = { ...judgment, targets: judgment.targets.map((item) => ({ ...item, word_id: ids[0] })) };
      await withProvider(async () => {
        const result = await submitTaskResult(db, submissionFor(task, text), NOW + 1);
        assert.equal(result.writeback.passed, false);
        assert.equal(db.prepare('SELECT fluency FROM words WHERE id = ?').get(ids[0]).fluency, score);
      }, { judgment: adjusted });
      db.close();
    });
  }
});

test('29 words are rejected without asking the model', async () => {
  const { db, ids } = fluencyFixture();
  const task = await issuePFluency(db);
  const shortText = Array.from({ length: 29 }, (_, index) => `word${index}`).join(' ');
  await withProvider(async () => {
    const result = await submitTaskResult(db, submissionFor(task, shortText), NOW + 1);
    assert.equal(result.writeback.passed, false);
    assert.equal(providerRequests, 0);
  }, { judgment: pPassageJudgment(ids) });
  db.close();
});

test('missing gloss blocks P continuous tasks but keeps P retrieval available and records the gap', async () => {
  const { db, ids } = fluencyFixture({ meaning: '' });
  const issued = (await getOrIssueTask(db, NOW)).task;
  assert.equal(issued.axis, 'p');
  assert.equal(issued.type, 'RETRIEVE');
  assert.equal(issued.payload.material_fallback, 'p_expression_gloss_missing');
  assert.ok(issued.payload.material_gaps.some((gap) => gap.definition_id === 'fluency-p' && gap.reason === 'gloss_missing'));
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM task_analytics_events WHERE event_type = 'material_missing' AND definition_id = 'fluency-p'`).get().count, 1);
  assert.equal(db.prepare('SELECT fluency FROM words WHERE id = ?').get(ids[0]).fluency, 75);
  db.close();
});

test('provider failure or malformed verdict fails closed and leaves the P instance active', async (t) => {
  for (const [name, options] of [
    ['provider failure', { status: 503, judgment: { error: 'private provider detail' } }],
    ['schema mismatch', { judgment: { coherent: true, grammatical: true, targets: [{ word_id: 999, correct: true }] } }],
  ]) {
    await t.test(name, async () => {
      const { db, ids } = fluencyFixture();
      const task = await issuePFluency(db);
      const tickBefore = db.prepare("SELECT value FROM meta WHERE key = 'global_tick'").get().value;
      await withProvider(async () => {
        await assert.rejects(submitTaskResult(db, submissionFor(task, paragraphFor('clarify')), NOW + 1),
          (error) => error instanceof TaskApiError && error.status === 503 && !/private provider/.test(error.message));
      }, options);
      assert.equal(db.prepare("SELECT value FROM meta WHERE key = 'global_tick'").get().value, tickBefore);
      assert.equal(db.prepare('SELECT status FROM task_instances WHERE instance_id = ?').get(task.instance_id).status, 'issued');
      assert.equal(db.prepare('SELECT fluency FROM words WHERE id = ?').get(ids[0]).fluency, 75);
      db.close();
    });
  }
});

test('blank-gloss P batch cannot issue INTEGRATE and surfaces integrate gap', async () => {
  const { db } = integrationFixture({ blankGloss: true });
  const issued = (await getOrIssueTask(db, NOW)).task;
  assert.equal(issued.axis, 'p');
  assert.notEqual(issued.type, 'INTEGRATE');
  assert.equal(issued.payload.material_fallback, 'p_expression_gloss_missing');
  assert.ok(issued.payload.material_gaps.some((gap) => gap.definition_id === 'integrate-p' && gap.reason === 'gloss_missing'));
  assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM task_analytics_events WHERE event_type = 'material_missing' AND definition_id = 'integrate-p'`).get().count, 1);
  db.close();
});
