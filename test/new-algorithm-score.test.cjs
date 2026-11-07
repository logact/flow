const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { stageForScore, retrievalScore, fluencyScore, enhancedHalfLife } = require(path.join(process.env.FLOW_TEST_BUILD_DIR, 'lib/new-algorithm-score.js'));

test('each score maps to exactly one stage, including boundaries', () => {
  for (const [score, stage] of [[0,'encode'],[0.001,'choice'],[19.999,'choice'],[20,'cued'],[39.999,'cued'],[40,'free'],[59.999,'free'],[60,'fluency'],[100,'fluency']]) {
    assert.equal(stageForScore(score), stage);
  }
  for (const score of [-1, 101, NaN, Infinity]) assert.throws(() => stageForScore(score), RangeError);
});

test('retrieval writes absolute band scores', () => {
  for (const [stage, pass, fail] of [['choice',20,5],['cued',40,5],['free',60,20]]) {
    assert.equal(retrievalScore(stage, true), pass);
    assert.equal(retrievalScore(stage, false), fail);
  }
});

test('R fluency directly measures current speed, including a decrease', () => {
  for (const [wpm, expected] of [[149,40],[150,60],[200,60+50/3.75],[225,80],[300,100],[400,100]]) {
    assert.equal(fluencyScore('r',80,{kind:'valid',targetPassed:true,overallPassed:true,wpm}).score,expected);
  }
  assert.deepEqual(fluencyScore('r',80,{kind:'valid',targetPassed:false,overallPassed:true,wpm:300}),{kind:'scored',reason:'target_failed',score:40});
  assert.deepEqual(fluencyScore('r',80,{kind:'valid',targetPassed:true,overallPassed:false,wpm:300}),{kind:'no_change',reason:'overall_failed',score:80});
});

test('P fluency and non-scoring outcomes', () => {
  for (const [wpm, expected] of [[24.9,40],[25,60],[42.5,80],[60,100]]) {
    assert.equal(fluencyScore('p',80,{kind:'valid',targetPassed:true,overallPassed:true,wpm}).score,expected);
  }
  for (const kind of ['invalid','uncertain','service_error']) {
    assert.deepEqual(fluencyScore('p',80,{kind}),{kind:'no_change',reason:kind,score:80});
  }
});

test('D2 exposure enhancement is proportional and rejects invalid state', () => {
  assert.equal(enhancedHalfLife(3_600_000),5_400_000);
  assert.throws(() => enhancedHalfLife(0),RangeError);
});
