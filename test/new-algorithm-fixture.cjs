const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-algorithm-db-'));
  const file = path.join(dir, 'test.sqlite');
  const { createNewAlgorithmDb } = require(path.join(process.env.FLOW_TEST_BUILD_DIR, 'lib/new-algorithm-db.js'));
  const db = createNewAlgorithmDb(file);
  let now = 1_800_000_000_000;
  let sequence = 0;
  const gradingResponses = [];
  return {
    db, file,
    clock: { now: () => now, advance: ms => { now += ms; } },
    nextId: prefix => `${prefix}-${++sequence}`,
    grading: {
      push: result => gradingResponses.push(result),
      async evaluate() {
        if (!gradingResponses.length) throw new Error('No scripted grading response');
        const next = gradingResponses.shift();
        if (next instanceof Error) throw next;
        return next;
      }
    },
    barrier(count) {
      let waiting = 0; let release;
      const gate = new Promise(resolve => { release = resolve; });
      return async () => { if (++waiting === count) release(); await gate; };
    },
    addWord(overrides = {}) {
      const word = { id: ++sequence, term: 'test', meaning: '测试', target_r: 80, target_p: 80, created_at: now, ...overrides };
      db.prepare('INSERT INTO words(id,term,meaning,target_r,target_p,created_at) VALUES(@id,@term,@meaning,@target_r,@target_p,@created_at)').run(word);
      return word.id;
    },
    addMaterial(wordId, overrides = {}) {
      const material = { id: `material-${++sequence}`, word_id: wordId, axis: 'r', stage: 'encode', version: 1, meaning_version: 1, status: 'ready', public_payload: '{}', answer_key: '{}', grading_requirements: '{}', timing_protocol: '{}', validation_json: '{}', created_at: now, ...overrides };
      db.prepare(`INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at)
        VALUES(@id,@word_id,@axis,@stage,@version,@meaning_version,@status,@public_payload,@answer_key,@grading_requirements,@timing_protocol,@validation_json,@created_at)`).run(material);
      return material;
    },
    close() { db.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
}

module.exports = { createFixture };
