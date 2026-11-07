const {stageForScore, needsConnection, connectionScores, retrievalScore, fluencyScore} = require('../lib/new-algorithm-score');
describe('current algorithm scoring',()=>{
 test.each([[0,'choice'],[19.99,'choice'],[20,'cued'],[39.99,'cued'],[40,'free'],[59.99,'free'],[60,'fluency'],[100,'fluency']])('score %s maps to %s', (score,stage)=>expect(stageForScore(score)).toBe(stage));
 test('connection is only needed for an unintroduced double-zero word and increments one task',()=>{expect(needsConnection(0,0,false)).toBe(true);expect(needsConnection(0,5,false)).toBe(false);expect(connectionScores(0,0,true)).toEqual({scoreR:5,scoreP:5,tickDelta:1});expect(connectionScores(0,0,false).tickDelta).toBe(0);});
 test.each([['choice',true,20],['choice',false,5],['cued',true,40],['cued',false,5],['free',true,60],['free',false,20]])('%s %s -> %s', (stage,passed,score)=>expect(retrievalScore(stage,passed)).toBe(score));
 test('R and P formulas retain unrounded values and failures',()=>{expect(fluencyScore('r',80,{kind:'valid',targetPassed:true,overallPassed:true,wpm:200}).score).toBeCloseTo(73.333333333,8);expect(fluencyScore('p',80,{kind:'valid',targetPassed:true,overallPassed:true,wpm:45}).score).toBeCloseTo(82.857142857,8);expect(fluencyScore('r',80,{kind:'valid',targetPassed:true,overallPassed:false,wpm:200})).toMatchObject({kind:'no_change',score:80});});
});
