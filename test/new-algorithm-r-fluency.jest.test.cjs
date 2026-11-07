const {countRWords,validateRFluencyMaterial,gradeRFluency,scoreRFluency,generateRFluencyMaterial}=require('../lib/new-algorithm-r-fluency');
const {createNewAlgorithmDb}=require('../lib/new-algorithm-db');

function passage(n=100, hits=5) {
  const words=Array.from({length:n},(_,i)=>`word${i}`);
  for(let i=0;i<hits;i++) words[i]=['target','targets','targeted','targeting','target'][i%5];
  return words.join(' ');
}
function material({n=100,hits=5}={}) {
  return {publicPayload:{passage:passage(n,hits),questions:[{prompt:'What changed?'},{prompt:'Why did it matter?'}]},answerKey:{questions:[{answer:'A change',evidence:'word20'},{answer:'It mattered',evidence:'word30'}]},gradingRequirements:{targetMeaning:'intended sense',targetForms:['target','targets','targeted','targeting'],targetOccurrences:5,level:'B1'},timingProtocol:{}};
}
function dbWithWord(){const db=createNewAlgorithmDb();db.prepare("INSERT INTO words(id,term,meaning,target_r,target_p,local_timezone,created_at) VALUES(1,'target','intended sense',80,80,'Asia/Shanghai',1)").run();return db;}

describe('R fluency material and evaluator',()=>{
  test('counts and accepts exactly 100 words with at least five target occurrences',()=>{
    expect(countRWords(passage())).toBe(100);
    expect(validateRFluencyMaterial(material()).answerKey.questions).toHaveLength(2);
  });
  test.each([[99,5,'PASSAGE_WORD_COUNT_NOT_100'],[101,5,'PASSAGE_WORD_COUNT_NOT_100'],[100,4,'TARGET_OCCURRENCES_BELOW_5']])('rejects invalid passage n=%i hits=%i', (n,hits,reason)=>{
    expect(()=>validateRFluencyMaterial(material({n,hits}))).toThrow(reason);
  });
  test('rejects missing or unfrozen question answer/evidence pairs',()=>{
    const m=material();m.answerKey.questions.pop();expect(()=>validateRFluencyMaterial(m)).toThrow('TWO_FROZEN_QUESTIONS_REQUIRED');
  });
  test('sends both answers, target meaning and frozen keys to injected evaluator',async()=>{
    let observed;
    const grade=await gradeRFluency({material:material(),response:['answer one','answer two'],wpm:175,evaluator:input=>{observed=input;return {kind:'valid',targetPassed:true,overallPassed:true,wpm:0};}});
    expect(observed).toMatchObject({response:['answer one','answer two'],targetMeaning:'intended sense'});
    expect(grade).toEqual({kind:'valid',targetPassed:true,overallPassed:true,wpm:175});
    expect(scoreRFluency(60,grade)).toMatchObject({kind:'scored',reason:'fluent',score:66.66666666666667});
  });
  test.each(['invalid','uncertain','service_error'])('preserves non-valid evaluator result %s',async kind=>{
    const grade=await gradeRFluency({material:material(),response:['a','b'],wpm:200,evaluator:()=>({kind})});
    expect(grade.kind).toBe(kind);expect(scoreRFluency(75,grade)).toMatchObject({kind:'no_change',score:75});
  });
  test('uses bounded T03 material jobs and does not require book source',async()=>{
    const db=dbWithWord();let calls=0;
    const out=await generateRFluencyMaterial(db,{wordId:1,version:1,meaningVersion:1,now:10},async()=>{calls++;return {...material(),validation:{}};});
    expect(out).toMatchObject({status:'ready',attempts:1});expect(calls).toBe(1);
    db.close();
  });
  test('invalid drafts retry once, then fail after D5 two attempts',async()=>{
    const db=dbWithWord();let calls=0;
    const out=await generateRFluencyMaterial(db,{wordId:1,version:1,meaningVersion:1,now:10},async()=>{calls++;return {...material({n:99}),validation:{}};});
    expect(out).toMatchObject({status:'failed',attempts:2,reason:'PASSAGE_WORD_COUNT_NOT_100'});expect(calls).toBe(2);db.close();
  });
});
