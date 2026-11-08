const p = require('../lib/new-algorithm-p-fluency.ts');
const {createNewAlgorithmDb}=require('../lib/new-algorithm-db');
const evaluator=async()=>({targetPassed:true,overallPassed:true,targetEvidence:'target used correctly',overallEvidence:'recall is coherent'});

describe('P fluency', () => {
  test('rejects target form leakage and missing private key', () => {
    expect(p.validatePFluencyDraft({scene_zh:'请使用 brave 解释',instructions_zh:'写一段'},{target_form:'brave',forbidden_target_forms:['brave']},null)).toEqual(expect.arrayContaining(['target_form_leak','missing_private_answer_key']));
  });
  test('filters repeated filler from meaningful count', () => {
    expect(p.meaningfulWordCount('apple apple apple apple the and')).toBe(0);
  });
  test('short response without target is invalid and does not score', async () => {
    const result=await p.evaluatePFluency({text:'a short response',elapsedSeconds:5,targetForm:'target',answerKey:{},evaluator:async()=>({targetPassed:false,overallPassed:false,targetEvidence:'missing',overallEvidence:'not checked'})});
    expect(result).toMatchObject({kind:'invalid',reason:'too_fast_without_target'});
    expect(p.pFluencySettlement(60,result)).toEqual({kind:'no_change',reason:'invalid',score:60});
  });
  test('short response with target is evaluated normally',async()=>{
    const result=await p.evaluatePFluency({text:'a short response',elapsedSeconds:5,targetForm:'target',answerKey:{},evaluator:async()=>({targetPassed:true,overallPassed:true,targetEvidence:'target used',overallEvidence:'meaning retained'})});
    expect(result.kind).toBe('invalid'); expect(result.reason).toBe('fewer_than_30_meaningful_words');
  });
  test('short response with uncertain target stays uncertain',async()=>{
    const result=await p.evaluatePFluency({text:'a short response',elapsedSeconds:5,targetForm:'target',answerKey:{},evaluator:async()=>({targetPassed:'uncertain',overallPassed:false,targetEvidence:'',overallEvidence:''})});
    expect(result.kind).toBe('uncertain');
  });
  test('uncertain evaluation does not score', async () => {
    const result=await p.evaluatePFluency({text:'word '.repeat(35),elapsedSeconds:72,targetForm:'target',answerKey:{},evaluator:async()=>({targetPassed:'uncertain',overallPassed:true,targetEvidence:'',overallEvidence:''})});
    expect(result.kind).toBe('uncertain');
    expect(p.pFluencySettlement(60,result).score).toBe(60);
  });
  test('30 meaningful words in 72s maps to 25wpm and T02 fluency score', async () => {
    const text=Array.from({length:30},(_,i)=>`word${i}`).join(' ');
    const result=await p.evaluatePFluency({text,elapsedSeconds:72,targetForm:'target',answerKey:{},evaluator});
    expect(result).toMatchObject({kind:'valid',meaningfulWords:30,wpm:25});
    expect(p.pFluencySettlement(60,result)).toMatchObject({kind:'scored',reason:'fluent',score:60});
  });
  test('service error becomes no-change settlement',async()=>{
    const result=await p.evaluatePFluency({text:'word '.repeat(35),elapsedSeconds:70,targetForm:'target',answerKey:{},evaluator:async()=>{throw Error('down')}});
    expect(result.kind).toBe('service_error');expect(p.pFluencySettlement(60,result)).toMatchObject({kind:'no_change',score:60});
  });
  test.each([1,true])('rejects non-text scalar answer key %s',value=>{
    expect(p.validatePFluencyDraft({scene_zh:'中文情景',instructions_zh:'中文指令'},{target_form:'target',forbidden_target_forms:[]},value)).toContain('missing_private_answer_key');
  });
  test('malformed empty evaluator evidence becomes uncertain',async()=>{
    const result=await p.evaluatePFluency({text:'word '.repeat(35),elapsedSeconds:70,targetForm:'target',answerKey:{key:'a'},evaluator:async()=>({targetPassed:true,overallPassed:true,targetEvidence:' ',overallEvidence:''})});
    expect(result).toMatchObject({kind:'uncertain',reason:'evaluator_evidence_invalid'});
  });
  test('missing forbidden list returns validation errors without throwing',()=>{
    expect(()=>p.validatePFluencyDraft({scene_zh:'中文情景',instructions_zh:'中文指令'},{target_form:'target'}, {key:'x'})).not.toThrow();
    expect(p.validatePFluencyDraft({scene_zh:'中文情景',instructions_zh:'中文指令'},{target_form:'target'}, {key:'x'})).toContain('private_requirements_invalid');
  });
  test.each([null, 'bad', 7])('malformed evaluator output %s becomes uncertain',async output=>{
    const result=await p.evaluatePFluency({text:'word '.repeat(35),elapsedSeconds:70,targetForm:'target',answerKey:{key:'x'},evaluator:async()=>output});
    expect(result.kind).toBe('uncertain');
  });
  test.each([{overallPassed:true,targetEvidence:'x',overallEvidence:'y'},{targetPassed:'yes',overallPassed:true,targetEvidence:'x',overallEvidence:'y'},{targetPassed:false,overallPassed:null,targetEvidence:'x',overallEvidence:'y'}])('malformed verdict schema becomes uncertain',async output=>{
    const result=await p.evaluatePFluency({text:'word '.repeat(35),elapsedSeconds:70,targetForm:'target',answerKey:{key:'x'},evaluator:async()=>output});
    expect(result).toMatchObject({kind:'uncertain',reason:'evaluator_verdict_invalid'});
  });
  test.each([0, -1, Infinity, NaN])('invalid elapsed time %s is rejected',async elapsedSeconds=>{
    const result=await p.evaluatePFluency({text:'word '.repeat(35),elapsedSeconds,targetForm:'target',answerKey:{key:'x'},evaluator});
    expect(result).toMatchObject({kind:'invalid',reason:'elapsed_time_invalid',wpm:0});
  });
  test('bounded T03 producer rejects target leakage and retries at most twice',async()=>{
    const db=createNewAlgorithmDb();db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,local_timezone,created_at) VALUES(1,'target','gloss',80,80,'UTC',1)").run();let calls=0;
    const out=await p.generatePFluencyMaterial(db,{wordId:1,version:1,meaningVersion:1,now:10},async()=>{calls++;return {publicPayload:{scene_zh:'target泄漏',instructions_zh:'中文写作'},answerKey:{secret:'answer'},gradingRequirements:{target_form:'target',forbidden_target_forms:['target']},timingProtocol:{},validation:{}}});
    expect(out).toMatchObject({status:'failed',attempts:2});expect(calls).toBe(2);db.close();
  });
  test('stores only public Chinese prompt in public_payload, never target form or answer key',async()=>{
    const db=createNewAlgorithmDb();db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,local_timezone,created_at) VALUES(1,'target','gloss',80,80,'UTC',1)").run();
    const out=await p.generatePFluencyMaterial(db,{wordId:1,version:1,meaningVersion:1,now:10},async()=>({publicPayload:{scene_zh:'一位旅客描述旅程',instructions_zh:'请用英语表达'},answerKey:{secret:'PRIVATE ANSWER'},gradingRequirements:{target_form:'target',forbidden_target_forms:['targeted']},timingProtocol:{},validation:{}}));
    expect(out.status).toBe('ready');const row=db.prepare('SELECT public_payload,answer_key,grading_requirements FROM materials WHERE id=?').get(out.id);
    expect(row.public_payload).not.toMatch(/target|PRIVATE ANSWER/i);expect(row.public_payload).not.toContain('secret');
    expect(row.answer_key).toContain('PRIVATE ANSWER');expect(row.grading_requirements).toContain('target');db.close();
  });
  test.each([
    ['empty target', {target_form:'',forbidden_target_forms:[]} , {secret:'x'}, {scene_zh:'中文情景',instructions_zh:'中文指令'}],
    ['missing forbidden list', {target_form:'target'}, {secret:'x'}, {scene_zh:'中文情景',instructions_zh:'中文指令'}],
    ['empty answer key', {target_form:'target',forbidden_target_forms:[]}, {}, {scene_zh:'中文情景',instructions_zh:'中文指令'}],
    ['extra public field', {target_form:'target',forbidden_target_forms:[]}, {secret:'x'}, {scene_zh:'中文情景',instructions_zh:'中文指令',answer:'secret'}],
    ['no Chinese prompt', {target_form:'target',forbidden_target_forms:[]}, {secret:'x'}, {scene_zh:'Travel scene only',instructions_zh:'Write a paragraph'}],
  ])('fails closed for %s',async(_label,requirements,key,payload)=>{
    const db=createNewAlgorithmDb();db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,local_timezone,created_at) VALUES(1,'target','gloss',80,80,'UTC',1)").run();let calls=0;
    const out=await p.generatePFluencyMaterial(db,{wordId:1,version:1,meaningVersion:1,now:10},async()=>{calls++;return {publicPayload:payload,answerKey:key,gradingRequirements:requirements,timingProtocol:{},validation:{}}});
    expect(out).toMatchObject({status:'failed',attempts:2});expect(calls).toBe(2);db.close();
  });
});
