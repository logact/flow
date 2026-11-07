import type Database from 'better-sqlite3';
import { fluencyScore, type FluencyResult, type ScoreOutcome } from './new-algorithm-score';
import { generateNewAlgorithmMaterial, type MaterialDraft, type MaterialJobInput, type MaterialProvider } from './new-algorithm-material-jobs';

export type RFluencyMaterial = {
  publicPayload: { passage: string; questions: Array<{ prompt: string }> };
  answerKey: { questions: Array<{ answer: string; evidence: string }> };
  gradingRequirements: { targetMeaning: string; targetForms: string[]; targetOccurrences: number; level: string };
  timingProtocol: Record<string, unknown>;
};
export type RFluencyGrade = FluencyResult & { reasons?: string[] };
export type RFluencyEvaluator = (input: {
  passage: string; response: [string, string]; targetMeaning: string; answerKey: RFluencyMaterial['answerKey'];
}) => Promise<RFluencyGrade> | RFluencyGrade;

export class InvalidRFluencyMaterialError extends Error {}

export function countRWords(text: string): number {
  return text.trim().split(/\s+/u).filter(Boolean).length;
}

function occurrences(text: string, forms: string[]): number {
  let count = 0;
  for (const form of forms.filter(Boolean)) {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    count += (text.match(new RegExp(`\\b${escaped}\\b`, 'giu')) ?? []).length;
  }
  return count;
}

export function validateRFluencyMaterial(value: unknown): RFluencyMaterial {
  if (!value || typeof value !== 'object') throw new InvalidRFluencyMaterialError('MATERIAL_SCHEMA_INVALID');
  const m = value as RFluencyMaterial;
  if (!m.publicPayload || typeof m.publicPayload.passage !== 'string' || !Array.isArray(m.publicPayload.questions) ||
      !m.answerKey || !Array.isArray(m.answerKey.questions) || !m.gradingRequirements || typeof m.gradingRequirements.targetMeaning !== 'string' || !Array.isArray(m.gradingRequirements.targetForms)) {
    throw new InvalidRFluencyMaterialError('MATERIAL_SCHEMA_INVALID');
  }
  if (countRWords(m.publicPayload.passage) !== 100) throw new InvalidRFluencyMaterialError('PASSAGE_WORD_COUNT_NOT_100');
  if (occurrences(m.publicPayload.passage, m.gradingRequirements.targetForms) < 5) throw new InvalidRFluencyMaterialError('TARGET_OCCURRENCES_BELOW_5');
  if (m.publicPayload.questions.length !== 2 || m.answerKey.questions.length !== 2 ||
      !m.publicPayload.questions.every(q => typeof q.prompt === 'string' && q.prompt.trim()) ||
      !m.answerKey.questions.every(a => typeof a.answer === 'string' && a.answer.trim() && typeof a.evidence === 'string' && a.evidence.trim())) {
    throw new InvalidRFluencyMaterialError('TWO_FROZEN_QUESTIONS_REQUIRED');
  }
  return m;
}

export function gradeRFluency(input: { material: unknown; response: unknown; wpm: number; evaluator: RFluencyEvaluator }): Promise<RFluencyGrade> {
  let material: RFluencyMaterial;
  try { material = validateRFluencyMaterial(input.material); }
  catch (error) { return Promise.resolve({ kind: 'service_error', reasons: [error instanceof Error ? error.message : 'MATERIAL_INVALID'] }); }
  if (!Array.isArray(input.response) || input.response.length !== 2 || !input.response.every(x => typeof x === 'string' && x.trim())) {
    return Promise.resolve({ kind: 'service_error', reasons: ['TWO_ANSWERS_REQUIRED'] });
  }
  return Promise.resolve().then(() => input.evaluator({
    passage: material.publicPayload.passage, response: input.response as [string, string],
    targetMeaning: material.gradingRequirements.targetMeaning, answerKey: material.answerKey,
  })).then((result): RFluencyGrade => {
    if (!result || !['valid', 'invalid', 'uncertain', 'service_error'].includes(result.kind)) return { kind: 'uncertain', reasons: ['EVALUATOR_RESULT_INVALID'] };
    if (result.kind !== 'valid') return result;
    if (!Number.isFinite(input.wpm) || input.wpm < 0) return { kind: 'invalid', reasons: ['READING_SPEED_INVALID'] };
    return { ...result, wpm: input.wpm };
  }).catch((): RFluencyGrade => ({ kind: 'service_error', reasons: ['EVALUATOR_FAILED'] }));
}

export function scoreRFluency(before: number, grade: RFluencyGrade): ScoreOutcome {
  return fluencyScore('r', before, grade);
}

export async function generateRFluencyMaterial(db: Database.Database, input: Omit<MaterialJobInput, 'axis' | 'stage'>, provider: MaterialProvider) {
  const job: MaterialJobInput = { ...input, axis: 'r', stage: 'fluency' };
  return generateNewAlgorithmMaterial(db, job, provider, (_job, draft: MaterialDraft) => {
    try { validateRFluencyMaterial(draft); return { valid: true }; }
    catch (error) { return { valid: false, reason: error instanceof Error ? error.message : 'MATERIAL_INVALID' }; }
  });
}
