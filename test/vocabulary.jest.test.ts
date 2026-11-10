import { describe, expect, test } from '@jest/globals';
import { estimateVocabularyCapacityByBand, estimateTargetWordInitialScores, estimateBandProbability } from '../lib/vocabulary';
import { BNC_COCA_L6_V2, bncCocaFamilyIndex, getBncCocaBandBounds } from '../lib/vocabulary-reference';
const listSource={id:'BNC_COCA_L6_v2',basis:'word-family-frequency-band'};
describe('P3.1 band capacity estimate',()=>{
 const base={sourceVersion:'2.0.0',listSource,populations:[{band:'1k' as const,familyCount:1000}],items:[{familyId:'1k:a',band:'1k' as const,correct:true},{familyId:'1k:b',band:'1k' as const,correct:false}]};
 test('estimates population and emits an uncertainty distribution consumable by P3',()=>{const v=estimateVocabularyCapacityByBand(base);expect(v.size).toBe(500);expect(v.distribution?.reduce((s,x)=>s+x.probability,0)).toBe(1);expect(v.uncertainty?.lower).toBeLessThan(v.uncertainty!.upper);});
 test('rejects duplicate sampled families',()=>expect(()=>estimateVocabularyCapacityByBand({...base,items:[base.items[0],base.items[0]]})).toThrow(RangeError));
 test('does not mutate input',()=>{const copy=structuredClone(base);estimateVocabularyCapacityByBand(base);expect(base).toEqual(copy);});
});
describe('P3 family-based initial score estimate',()=>{
 const bounds=getBncCocaBandBounds();
 const vocab={size:0,listSource,distribution:[{value:0,probability:1}]};
 test('uses original surface forms and the pinned actual list',()=>{expect(BNC_COCA_L6_V2.families).toHaveLength(25002);expect(estimateTargetWordInitialScores({vocabulary:vocab,target:{word:'RUNNING'}})).toMatchObject({lookup:'matched',family:{headword:'run'},probabilityKnown:0});});
 test('unknown and ambiguous words have no fabricated probability',()=>{expect(estimateTargetWordInitialScores({vocabulary:vocab,target:{word:'notawordxyz'}})).toMatchObject({lookup:'not_in_list',probabilityKnown:null,comparable:false});});
 test('context POS can disambiguate homographs where list preserves alternatives',()=>{const bank=bncCocaFamilyIndex.lookup('bank');if(bank.status==='ambiguous') expect(bncCocaFamilyIndex.lookup('bank',{partOfSpeech:'noun'}).status).toBe('matched');});
 test('probability boundaries and monotonicity follow cumulative family positions',()=>{const b=bounds[0];expect(estimateBandProbability({size:b.lower-1,listSource},b.lower,b.upper)).toBe(0);expect(estimateBandProbability({size:b.upper,listSource},b.lower,b.upper)).toBe(1);expect(estimateBandProbability({size:b.lower+10,listSource},b.lower,b.upper)).toBeGreaterThan(estimateBandProbability({size:b.lower,listSource},b.lower,b.upper));});
 test('estimator is deterministic and leaves vocabulary input unchanged',()=>{const input={vocabulary:vocab,target:{word:'the'}};const copy=structuredClone(input);expect(estimateTargetWordInitialScores(input)).toEqual(estimateTargetWordInitialScores(input));expect(input).toEqual(copy);});
});
