import { fluencyScore, type FluencyResult } from './new-algorithm-score';
import type Database from 'better-sqlite3';
import { generateNewAlgorithmMaterial, type MaterialDraft, type MaterialJobInput, type MaterialProvider } from './new-algorithm-material-jobs';

export type PFluencyDraft = { scene_zh: string; instructions_zh: string };

export function validatePFluencyDraft(draft: PFluencyDraft, privateRequirements: {target_form:string; forbidden_target_forms:string[]}, answerKey: unknown): string[] {
  const errors: string[] = [];
  const safe = draft && typeof draft === 'object' ? draft : {} as PFluencyDraft;
  if (!draft || typeof draft !== 'object' || Object.keys(draft).sort().join(',') !== 'instructions_zh,scene_zh') errors.push('public_schema_invalid');
  if (typeof safe.scene_zh !== 'string' || typeof safe.instructions_zh !== 'string' || !safe.scene_zh.trim() || !safe.instructions_zh.trim() || !/[\u3400-\u9fff]/u.test(`${safe.scene_zh} ${safe.instructions_zh}`)) errors.push('missing_chinese_prompt');
  if (typeof privateRequirements.target_form !== 'string' || !privateRequirements.target_form.trim() || !Array.isArray(privateRequirements.forbidden_target_forms) || !privateRequirements.forbidden_target_forms.every(x=>typeof x==='string')) errors.push('private_requirements_invalid');
  const visible = `${safe.scene_zh ?? ''} ${safe.instructions_zh ?? ''}`.toLocaleLowerCase();
  const forbidden = Array.isArray(privateRequirements.forbidden_target_forms) ? privateRequirements.forbidden_target_forms : [];
  for (const form of [privateRequirements.target_form, ...forbidden]) {
    if (form && visible.includes(form.toLocaleLowerCase())) errors.push('target_form_leak');
  }
  if (!(typeof answerKey === 'string' && answerKey.trim()) && !(answerKey && typeof answerKey === 'object' && Object.keys(answerKey as object).length > 0)) errors.push('missing_private_answer_key');
  return [...new Set(errors)];
}

const STOP = new Set(['the','and','that','with','from','have','this','then','when','were','your','about','into','very','really','just','because','after','before','would','could','should','there','their','them','they','what','which','while','also','some','more','than','been','being']);
export function meaningfulWordCount(text: string): number {
  const tokens = text.toLocaleLowerCase().match(/[a-z][a-z0-9]*(?:['-][a-z][a-z0-9]*)*/g) ?? [];
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  return tokens.filter(token => !STOP.has(token) && (counts.get(token) ?? 0) <= 3).length;
}

export type PFluencyEvaluation = { kind:'valid'; targetPassed:boolean; overallPassed:boolean; evidence:{target:string; overall:string}; meaningfulWords:number; wpm:number } | { kind:'uncertain'|'service_error'|'invalid'; reason:string; meaningfulWords:number; wpm:number };
export type PFluencyEvaluator = (input:{text:string; targetForm:string; answerKey:unknown})=>Promise<{targetPassed:boolean|'uncertain';overallPassed:boolean|'uncertain';targetEvidence:string;overallEvidence:string}|{kind:'service_error'|'uncertain'}>;
export async function evaluatePFluency(input:{text:string; elapsedSeconds:number; targetForm:string; answerKey:unknown; evaluator:PFluencyEvaluator}): Promise<PFluencyEvaluation> {
  const meaningfulWords = meaningfulWordCount(input.text);
  const wpm = input.elapsedSeconds > 0 ? meaningfulWords * 60 / input.elapsedSeconds : 0;
  if (!Number.isFinite(input.elapsedSeconds) || input.elapsedSeconds <= 0) return {kind:'invalid',reason:'elapsed_time_invalid',meaningfulWords,wpm:0};
  let judgment;
  try { judgment=await input.evaluator({text:input.text,targetForm:input.targetForm,answerKey:input.answerKey}); }
  catch { return {kind:'service_error',reason:'evaluator_failed',meaningfulWords,wpm}; }
  if (!judgment || typeof judgment !== 'object') return {kind:'uncertain',reason:'evaluator_result_invalid',meaningfulWords,wpm};
  if ('kind' in judgment) return {kind:judgment.kind,reason:judgment.kind,meaningfulWords,wpm};
  if (!['boolean'].includes(typeof judgment.targetPassed) || !['boolean'].includes(typeof judgment.overallPassed)) return {kind:'uncertain',reason:'evaluator_verdict_invalid',meaningfulWords,wpm};
  if (judgment.targetPassed === 'uncertain' || judgment.overallPassed === 'uncertain') return {kind:'uncertain',reason:'evaluator_uncertain',meaningfulWords,wpm};
  if (typeof judgment.targetEvidence !== 'string' || !judgment.targetEvidence.trim() || typeof judgment.overallEvidence !== 'string' || !judgment.overallEvidence.trim()) return {kind:'uncertain',reason:'evaluator_evidence_invalid',meaningfulWords,wpm};
  if (input.elapsedSeconds <= 5 && !judgment.targetPassed) return {kind:'invalid',reason:'too_fast_without_target',meaningfulWords,wpm};
  if (meaningfulWords < 30) return {kind:'invalid',reason:'fewer_than_30_meaningful_words',meaningfulWords,wpm};
  return {kind:'valid',targetPassed:judgment.targetPassed,overallPassed:judgment.overallPassed,evidence:{target:judgment.targetEvidence,overall:judgment.overallEvidence},meaningfulWords,wpm};
}

export async function generatePFluencyMaterial(db:Database.Database,input:Omit<MaterialJobInput,'axis'|'stage'>,provider:MaterialProvider) {
 const job:MaterialJobInput={...input,axis:'p',stage:'fluency'};
 return generateNewAlgorithmMaterial(db,job,provider,(_job,draft:MaterialDraft)=>{
  const data=draft.publicPayload as PFluencyDraft;
  const req=draft.gradingRequirements as {target_form?:string;forbidden_target_forms?:string[]};
  const errors=validatePFluencyDraft(data,{target_form:req?.target_form as string,forbidden_target_forms:req?.forbidden_target_forms as string[]},draft.answerKey);
  return {valid:errors.length===0,reason:errors.join(',')||undefined};
 });
}

export function pFluencySettlement(before:number, result:PFluencyEvaluation) {
  const scoreResult: FluencyResult = result.kind === 'valid' ? result : {kind:result.kind};
  return fluencyScore('p',before,scoreResult);
}
