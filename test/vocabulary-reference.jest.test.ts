import { describe, expect, test } from '@jest/globals';
import fixture from '../data/bnc-coca-l6-fixture.json';
import { createFamilyListIndex } from '../lib/vocabulary-reference';
import { estimateBandProbability, estimateVocabularyCapacityByBand } from '../lib/vocabulary';

describe('BNC/COCA family adapter and band estimate',()=>{
 const index=createFamilyListIndex(fixture as import('../lib/vocabulary-reference').FamilyList);
 test('normalizes case and resolves listed forms without stemming',()=>{expect(index.lookup(' RUNNING ').family?.headword).toBe('run'); expect(index.lookup('runned').status).toBe('not_in_list');});
 test('retains ambiguous homographs and POS resolution',()=>{expect(index.lookup('bank').status).toBe('ambiguous');expect(index.lookup('bank',{partOfSpeech:'verb'}).family?.headword).toBe('bank');});
 test('estimates stratified vocabulary with a V distribution',()=>{const v=estimateVocabularyCapacityByBand({sourceVersion:'2.0.0',listSource:{id:'BNC_COCA_L6_v2',basis:'word-family-frequency-band'},populations:[{band:'1k',familyCount:1000}],items:[{familyId:'a',band:'1k',correct:true},{familyId:'b',band:'1k',correct:false}]});expect(v.size).toBe(500);expect(v.distribution).toHaveLength(3);});
 test('uses weighted prefix probability and is monotonic',()=>{const v={size:0,listSource:{id:'x',basis:'band'},distribution:[{value:5,probability:.5},{value:15,probability:.5}]};expect(estimateBandProbability(v,10,19)).toBeCloseTo(.3);expect(estimateBandProbability(v,5,9)).toBeGreaterThan(estimateBandProbability(v,10,19));});
 test('rejects duplicate sampled families',()=>expect(()=>estimateVocabularyCapacityByBand({sourceVersion:'2',listSource:{id:'x',basis:'y'},populations:[{band:'1k',familyCount:10}],items:[{familyId:'a',band:'1k',correct:true},{familyId:'a',band:'1k',correct:false}]})).toThrow(RangeError));
});
