import { NextResponse } from 'next/server';
import { requestLlmJson } from '../../../../lib/llm';
import { generatePFluencyMaterial } from '../../../../lib/new-algorithm-p-fluency';
import { generateRFluencyMaterial } from '../../../../lib/new-algorithm-r-fluency';
import type { MaterialDraft, MaterialJobInput } from '../../../../lib/new-algorithm-material-jobs';
import { getNewAlgorithmDb } from '../../../../lib/new-algorithm-runtime-db';

export const runtime='nodejs';
export const dynamic='force-dynamic';

function isMaterialDraft(value:unknown):value is MaterialDraft {
  if(!value||typeof value!=='object')return false;
  const draft=value as Record<string,unknown>;
  return ['publicPayload','answerKey','gradingRequirements','timingProtocol','validation'].every(key=>key in draft);
}

function providerFor(word:{term:string;level:string},axis:'r'|'p') {
  return async(job:MaterialJobInput,meaning:string):Promise<MaterialDraft>=>requestLlmJson<MaterialDraft>({
    system:axis==='r'
      ?'Create one English reading fluency item. Return exactly these JSON fields: publicPayload {passage, questions:[{prompt},{prompt}]}; answerKey {questions:[{answer,evidence},{answer,evidence}]}; gradingRequirements {targetMeaning,targetForms,targetOccurrences,level}; timingProtocol {}; validation {}. passage must contain exactly 100 whitespace-separated words and include the target form at least five times. Questions must be answerable from the passage; every private answer evidence string must quote evidence from the passage. Do not include answers in publicPayload.'
      :'Create one Chinese-scene English writing fluency item. Return exactly these JSON fields: publicPayload {scene_zh,instructions_zh}; answerKey with a private sample response and scoring notes; gradingRequirements {target_form,forbidden_target_forms}; timingProtocol {}; validation {}. Public Chinese text must naturally elicit the target expression while never spelling the target form or any forbidden form. The private sample answer must use the target form and faithfully convey the confirmed meaning.',
    user:JSON.stringify({term:word.term,confirmedMeaning:meaning,axis,stage:'fluency',level:word.level,targetForms:[word.term],targetOccurrences:5}),
    validate:isMaterialDraft,
    timeoutMs:7_500,
  });
}

export async function POST(request:Request) {
  try{
    const body=await request.json() as {wordId?:unknown;axis?:unknown};
    if(!Number.isSafeInteger(body.wordId)||typeof body.wordId!=='number'||body.wordId<=0||(body.axis!=='r'&&body.axis!=='p'))return NextResponse.json({error:'wordId and axis r/p are required'},{status:400});
    const axis=body.axis as 'r'|'p';const db=getNewAlgorithmDb();
    const word=db.prepare('SELECT term,meaning,meaning_version,level FROM words WHERE id=?').get(body.wordId) as {term:string;meaning:string;meaning_version:number;level:string}|undefined;
    if(!word)return NextResponse.json({error:'Unknown word'},{status:404});
    if(!word.meaning.trim())return NextResponse.json({error:'Confirmed meaning is required'},{status:409});
    const version=((db.prepare("SELECT COALESCE(MAX(version),0) version FROM materials WHERE word_id=? AND axis=? AND stage='fluency'").get(body.wordId,axis) as {version:number}).version)+1;
    const input={wordId:body.wordId,version,meaningVersion:word.meaning_version,now:Date.now()};
    const provider=providerFor(word,axis);
    const result=axis==='r'
      ?await generateRFluencyMaterial(db,input,provider)
      :await generatePFluencyMaterial(db,input,provider);
    return NextResponse.json(result,result.status==='ready'?{status:200}:{status:422});
  }catch(error){
    if(error instanceof SyntaxError)return NextResponse.json({error:'invalid JSON body'},{status:400});
    return NextResponse.json({error:(error as Error).message},{status:400});
  }
}
