import type Database from 'better-sqlite3';
import { settleNewAlgorithmAttempt } from './new-algorithm-settlement';
export type RetrievalAxis='r'|'p';
export type RetrievalStage='choice'|'cued'|'free';
export type RetrievalMaterial={
  axis:RetrievalAxis;stage:RetrievalStage;
  publicPayload:Record<string,unknown>;
  answerKey:Record<string,unknown>;
  gradingRequirements:Record<string,unknown>;
};
export type RetrievalGrade={kind:'pass'|'fail'|'uncertain'|'service_error';reason?:string};
export type RetrievalSettlementDecision=
  | {action:'settle';judgment:{kind:'retrieval';passed:boolean}}
  | {action:'retry';reason:string};
export type SemanticEvaluator=(input:{axis:'r';response:string;targetMeaning:string;gradingRequirements:Record<string,unknown>})=>Promise<RetrievalGrade>|RetrievalGrade;

export class InvalidRetrievalMaterialError extends Error {}

function isRecord(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function hasText(value:unknown):value is string{return typeof value==='string'&&value.trim().length>0;}

function containsPrivateAnswerField(value:unknown):boolean {
  if(Array.isArray(value))return value.some(containsPrivateAnswerField);
  if(!isRecord(value))return false;
  return Object.entries(value).some(([key,nested])=>['answer_key','answerkey','answer_index','answerindex','correct_index','correctindex','correct_answer','correctanswer'].includes(key.toLowerCase())||containsPrivateAnswerField(nested));
}

/** Validate the frozen shape for one of the six R/P retrieval paths; this does not invent content. */
export function validateRetrievalMaterial(value:unknown):RetrievalMaterial {
  if(!isRecord(value)||(value.axis!=='r'&&value.axis!=='p')||!['choice','cued','free'].includes(String(value.stage))||!isRecord(value.publicPayload)||!isRecord(value.answerKey)||!isRecord(value.gradingRequirements))throw new InvalidRetrievalMaterialError('MATERIAL_SCHEMA_INVALID');
  const axis=value.axis as RetrievalAxis,stage=value.stage as RetrievalStage;
  const payload=value.publicPayload,key=value.answerKey;
  if(containsPrivateAnswerField(payload))throw new InvalidRetrievalMaterialError('PUBLIC_ANSWER_LEAK');
  if(!hasText(payload.prompt))throw new InvalidRetrievalMaterialError('PROMPT_REQUIRED');
  if(stage==='choice'){
    if(!Array.isArray(payload.options)||payload.options.length<2||!payload.options.every(hasText))throw new InvalidRetrievalMaterialError('CHOICE_OPTIONS_INVALID');
    const normalizedOptions=(payload.options as string[]).map(option=>option.trim().toLowerCase());
    if(new Set(normalizedOptions).size!==normalizedOptions.length)throw new InvalidRetrievalMaterialError('CHOICE_OPTIONS_DUPLICATE');
    const correct=key.correct_index;
    if(!Number.isSafeInteger(correct)||Number(correct)<0||Number(correct)>=payload.options.length)throw new InvalidRetrievalMaterialError('CHOICE_KEY_INVALID');
    if('accepted_answers'in key||'allowed_inflections'in key)throw new InvalidRetrievalMaterialError('CHOICE_KEY_SHAPE_INVALID');
  }else if(axis==='r'){
    if(!hasText(key.target_meaning))throw new InvalidRetrievalMaterialError('R_TARGET_MEANING_REQUIRED');
    if('options'in payload)throw new InvalidRetrievalMaterialError('NON_CHOICE_OPTIONS_FORBIDDEN');
  }else{
    if(!hasText(key.target_form))throw new InvalidRetrievalMaterialError('P_TARGET_FORM_REQUIRED');
    if(!Array.isArray(key.allowed_inflections)||!key.allowed_inflections.every(hasText))throw new InvalidRetrievalMaterialError('P_INFLECTION_ALLOWLIST_REQUIRED');
    if('options'in payload)throw new InvalidRetrievalMaterialError('NON_CHOICE_OPTIONS_FORBIDDEN');
    const publicText=JSON.stringify(payload).toLowerCase();
    const privateForms=[key.target_form,...(key.allowed_inflections as string[])].map(form=>form.toLowerCase()).filter(Boolean);
    if(privateForms.some(form=>publicText.includes(form)))throw new InvalidRetrievalMaterialError('P_TARGET_FORM_LEAK');
  }
  return value as RetrievalMaterial;
}

/** P matching intentionally changes only case and surrounding whitespace. */
export function normalizePAnswer(value:string):string{return value.trim().toLowerCase();}

/** Keep non-final evaluator outcomes out of T02 scoring settlement. */
export function toRetrievalSettlementDecision(grade:RetrievalGrade):RetrievalSettlementDecision {
  if(grade.kind==='pass')return {action:'settle',judgment:{kind:'retrieval',passed:true}};
  if(grade.kind==='fail')return {action:'settle',judgment:{kind:'retrieval',passed:false}};
  return {action:'retry',reason:grade.reason??(grade.kind==='uncertain'?'GRADING_UNCERTAIN':'GRADING_SERVICE_ERROR')};
}

/** Grade a frozen retrieval response; non-final outcomes are persisted as retry-only transitions. */
export async function gradeAndSettleFrozenRetrievalAttempt(db:Database.Database,input:{instanceId:string;attemptId:string;now:number;semanticEvaluator?:SemanticEvaluator}):Promise<
  {action:'settled';grade:RetrievalGrade;settlement:unknown;replay:boolean}|{action:'retry';grade:RetrievalGrade;attempts:number}
>{
  if(!Number.isSafeInteger(input.now)||input.now<0)throw new RangeError('Invalid grading timestamp');
  const instance=db.prepare('SELECT * FROM task_instances WHERE instance_id=?').get(input.instanceId) as {
    instance_id:string;word_id:number;axis:'r'|'p'|'both';type:string;stage:string;material_id:string;material_version:number;meaning_version:number;status:string;
  }|undefined;
  const attempt=db.prepare('SELECT * FROM attempts WHERE attempt_id=? AND instance_id=?').get(input.attemptId,input.instanceId) as {
    attempt_id:string;response_json:string;exposure_json:string;status:string;grading_attempts:number;
  }|undefined;
  if(!instance||!attempt)throw new Error('Unknown frozen retrieval attempt');
  if(!['r','p'].includes(instance.axis)||!['choice','cued','free'].includes(instance.stage)||instance.type!=='RETRIEVE')throw new Error('Instance is not a retrieval task');
  let saved:Record<string,unknown>;
  try{saved=JSON.parse(attempt.response_json) as Record<string,unknown>;}catch{throw new Error('Frozen response JSON is invalid');}
  const response=saved.response??saved;
  if(instance.status==='completed'&&attempt.status==='completed'){
    const judgment=saved.judgment as {kind:'retrieval';passed:boolean}|undefined;
    if(!judgment||judgment.kind!=='retrieval'||typeof judgment.passed!=='boolean')throw new Error('Completed attempt lacks frozen judgment');
    const settlement=settleNewAlgorithmAttempt(db,{instanceId:input.instanceId,attemptId:input.attemptId,judgment,exposedBeforeFeedback:false,now:input.now});
    return {action:'settled',grade:{kind:judgment.passed?'pass':'fail'},settlement,replay:true};
  }
  if(!['grading','grading_retry'].includes(instance.status)||!['frozen','grading_retry'].includes(attempt.status))throw new Error('Attempt is not ready for retrieval grading');
  if(attempt.status==='grading_retry'&&attempt.grading_attempts>=2)return {action:'retry',grade:{kind:'service_error',reason:'GRADING_RETRY_LIMIT'},attempts:attempt.grading_attempts};
  const material=db.prepare(`SELECT public_payload,answer_key,grading_requirements FROM materials
    WHERE id=? AND version=? AND word_id=? AND axis=? AND stage=? AND meaning_version=? AND status='ready'`)
    .get(instance.material_id,instance.material_version,instance.word_id,instance.axis,instance.stage,instance.meaning_version) as {public_payload:string;answer_key:string;grading_requirements:string}|undefined;
  if(!material)throw new Error('Frozen retrieval material is unavailable');
  const grade=await gradeRetrieval({material:{axis:instance.axis,stage:instance.stage,publicPayload:JSON.parse(material.public_payload),answerKey:JSON.parse(material.answer_key),gradingRequirements:JSON.parse(material.grading_requirements)},response,semanticEvaluator:input.semanticEvaluator});
  const decision=toRetrievalSettlementDecision(grade);
  if(decision.action==='retry'){
    const nextAttempt=attempt.grading_attempts+1;
    if(nextAttempt>2)return {action:'retry',grade:{kind:'service_error',reason:'GRADING_RETRY_LIMIT'},attempts:attempt.grading_attempts};
    db.transaction(()=>{
      db.prepare("UPDATE attempts SET status='grading_retry',grading_attempts=? WHERE attempt_id=?").run(nextAttempt,input.attemptId);
      db.prepare("UPDATE task_instances SET status='grading_retry' WHERE instance_id=?").run(input.instanceId);
      db.prepare(`INSERT INTO events(event_id,dedupe_key,event_type,instance_id,attempt_id,word_id,axis,ts,payload_json)
        VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(dedupe_key) DO NOTHING`)
        .run(`retrieval-retry:${input.attemptId}:${nextAttempt}`,`retrieval-retry:${input.attemptId}:${nextAttempt}`,'grading_retry',input.instanceId,input.attemptId,instance.word_id,instance.axis,input.now,JSON.stringify({reason:decision.reason,grade:grade.kind}));
    })();
    return {action:'retry',grade,attempts:nextAttempt};
  }
  const settlement=db.transaction(()=>{
    db.prepare('UPDATE attempts SET response_json=? WHERE attempt_id=?').run(JSON.stringify({response,judgment:decision.judgment}),input.attemptId);
    db.prepare("UPDATE task_instances SET status='grading' WHERE instance_id=?").run(input.instanceId);
    return settleNewAlgorithmAttempt(db,{instanceId:input.instanceId,attemptId:input.attemptId,judgment:decision.judgment,exposedBeforeFeedback:false,now:input.now});
  })();
  return {action:'settled',grade,settlement,replay:false};
}

export async function gradeRetrieval(input:{material:unknown;response:unknown;semanticEvaluator?:SemanticEvaluator}):Promise<RetrievalGrade>{
  let material:RetrievalMaterial;
  try{material=validateRetrievalMaterial(input.material);}catch(error){return {kind:'service_error',reason:error instanceof Error?error.message:'MATERIAL_SCHEMA_INVALID'};}
  if(material.stage==='choice'){
    const selected=isRecord(input.response)?input.response.selected_index:undefined;
    if(!Number.isSafeInteger(selected)||Number(selected)<0||Number(selected)>=(material.publicPayload.options as unknown[]).length)return {kind:'service_error',reason:'RESPONSE_SCHEMA_INVALID'};
    return Number(selected)===Number(material.answerKey.correct_index)?{kind:'pass'}:{kind:'fail'};
  }
  if(!hasText((isRecord(input.response)?input.response.answer:undefined)))return {kind:'service_error',reason:'RESPONSE_SCHEMA_INVALID'};
  const response=(input.response as {answer:string}).answer;
  if(material.axis==='p'){
    const accepted=[material.answerKey.target_form,...(material.answerKey.allowed_inflections as string[])].map(form=>normalizePAnswer(form as string));
    return accepted.includes(normalizePAnswer(response))?{kind:'pass'}:{kind:'fail'};
  }
  if(!input.semanticEvaluator)return {kind:'service_error',reason:'SEMANTIC_EVALUATOR_UNAVAILABLE'};
  try{
    const result=await input.semanticEvaluator({axis:'r',response,targetMeaning:material.answerKey.target_meaning as string,gradingRequirements:material.gradingRequirements});
    if(!result||!['pass','fail','uncertain','service_error'].includes(result.kind))return {kind:'uncertain',reason:'SEMANTIC_RESULT_INVALID'};
    return result;
  }catch{return {kind:'service_error',reason:'SEMANTIC_EVALUATOR_FAILED'};}
}

/** T06 producer adapter. T03 owns the bounded D5 job/retry/timeout persistence. */
export async function generateNewAlgorithmRetrievalMaterial(
  db:import('better-sqlite3').Database,
  input:import('./new-algorithm-material-jobs').MaterialJobInput,
  provider:import('./new-algorithm-material-jobs').MaterialProvider,
):Promise<{id:string;status:'ready'|'failed';attempts:number;reason?:string}> {
  if((input.axis!=='r'&&input.axis!=='p')||!['choice','cued','free'].includes(input.stage))throw new Error('RETRIEVAL_STAGE_REQUIRED');
  const {generateNewAlgorithmMaterial}=await import('./new-algorithm-material-jobs');
  return generateNewAlgorithmMaterial(db,input,provider,(job,draft)=>{
    if(!isRecord(draft.publicPayload)||!isRecord(draft.answerKey)||!isRecord(draft.gradingRequirements)||!isRecord(draft.timingProtocol))return {valid:false,reason:'MATERIAL_SCHEMA_INVALID'};
    try{
      validateRetrievalMaterial({axis:job.axis,stage:job.stage,publicPayload:draft.publicPayload,answerKey:draft.answerKey,gradingRequirements:draft.gradingRequirements});
      return {valid:true};
    }catch(error){return {valid:false,reason:error instanceof Error?error.message:'MATERIAL_SCHEMA_INVALID'};}
  });
}
