import { logger as appLogger } from './logger';
import type { AxisSchedule } from './schedule';
import { selectTask, type Axis, type RetrieveStage, type TaskType } from './scoring';
import type { ListSource } from './vocabulary';

export interface AssignmentAxis extends AxisSchedule {
  materialAvailable: boolean;
}
export interface AssignmentWord { id: string; R: AssignmentAxis; P: AssignmentAxis }
export interface AssignmentNewWord {
  id: string;
  band: 'common' | 'known' | 'less_common' | 'unknown';
  targets: { R: number; P: number };
  rank: number | null;
  rankSource: ListSource | null;
  materialAvailable: { R: boolean; P: boolean };
}
export interface TaskAssignmentInput {
  asOf: string;
  words: AssignmentWord[];
  newWords: AssignmentNewWord[];
  /** Date (YYYY-MM-DD); a candidate remains cooling while this date is later than asOf. */
  cooldownUntil: string | null;
  completedToday: number;
  maxTasksToday: number;
  capacity: { admittedWordIds: string[]; blockedWordId: string | null; blockingDate: string | null; reason: string | null };
}
export type CandidateKind = 'review' | 'learning' | 'new_word';
export interface TaskCandidate {
  wordId: string;
  axis: Axis | 'both';
  kind: CandidateKind;
  task: TaskType;
  stage?: RetrieveStage;
  dueAt?: string;
  eligible: boolean;
  skippedReason?: 'cooldown' | 'material_unavailable' | 'capacity' | 'not_admitted';
  priority: string;
}
export interface TaskAssignmentResult {
  status: 'task_selected' | 'no_due_tasks' | 'cooldown' | 'material_unavailable' | 'capacity_reached' | 'no_candidates';
  task: (TaskCandidate & { reason: string }) | null;
  candidates: TaskCandidate[];
  reason: string;
  asOf: string;
}
export interface TaskAssignmentEvent { event: 'task_assignment.decided'; decision: TaskAssignmentResult }
export type TaskAssignmentLogger = (event: TaskAssignmentEvent) => void;

const defaultLogger: TaskAssignmentLogger = event => appLogger.info(event, 'Task assignment decided');
const axes: Axis[] = ['R', 'P'];

/** Selects one task without changing vocabulary, schedule, or P4 capacity state. */
export function selectNextTask(input: TaskAssignmentInput): TaskAssignmentResult {
  validate(input);
  const candidates: TaskCandidate[] = [];
  for (const word of [...input.words].sort((a, b) => a.id.localeCompare(b.id))) {
    const sharedEncode = word.R.score === 0 && word.P.score === 0 &&
      !word.R.graduated && !word.P.graduated && word.R.dueAt !== 'infinity' && word.P.dueAt !== 'infinity' &&
      !word.R.learningComplete && !word.P.learningComplete &&
      word.R.dueAt <= input.asOf && word.P.dueAt <= input.asOf;
    if (sharedEncode) {
      candidates.push(makeCandidate(input, word.id, 'both', 'learning', 'ENCODE', undefined, minDate(word.R.dueAt, word.P.dueAt), word.R.materialAvailable && word.P.materialAvailable));
      continue;
    }
    for (const axis of axes) {
      const state = word[axis];
      if (state.graduated || state.dueAt === 'infinity' || state.dueAt > input.asOf) continue;
      const kind: CandidateKind = state.learningComplete ? 'review' : 'learning';
      const selected = kind === 'review' ? { task: 'FLUENCY' as const } : selectTask(state.score);
      // ENCODE initializes both axes and is represented once by the shared candidate above.
      if (selected.task === 'ENCODE') continue;
      candidates.push(makeCandidate(input, word.id, axis, kind, selected.task, selected.stage, state.dueAt, state.materialAvailable));
    }
  }

  const dueOld = candidates.filter(candidate => candidate.kind !== 'new_word' && candidate.eligible);
  if (dueOld.length) return finish(input.asOf, candidates, choose(dueOld), 'Due existing work is always selected before introducing a new word.');

  const admitted = new Set(input.capacity.admittedWordIds);
  for (const word of [...input.newWords].sort(compareNewWords)) {
    const bandScores = initialScores(word.band);
    const bothEncode = bandScores.R === 0 && bandScores.P === 0;
    if (bothEncode) {
      candidates.push(makeCandidate(input, word.id, 'both', 'new_word', 'ENCODE', undefined, undefined,
        word.materialAvailable.R && word.materialAvailable.P, admitted.has(word.id), `band=${word.band}; source=${word.rankSource?.id ?? ''};basis=${word.rankSource?.basis ?? ''};rank=${word.rank ?? 'unavailable'}`));
      continue;
    }
    for (const axis of axes) {
      const score = bandScores[axis];
      const selected = selectTask(score);
      if (selected.task === 'ENCODE') continue;
      candidates.push(makeCandidate(input, word.id, axis, 'new_word', selected.task, selected.stage, undefined,
        word.materialAvailable[axis], admitted.has(word.id), `band=${word.band}; source=${word.rankSource?.id ?? ''};basis=${word.rankSource?.basis ?? ''};rank=${word.rank ?? 'unavailable'};targetGap=${Math.max(0, word.targets[axis] - score)}`));
    }
  }

  const eligibleNew = candidates.filter(candidate => candidate.kind === 'new_word' && candidate.eligible);
  if (eligibleNew.length) {
    const selected = choose(eligibleNew);
    return finish(input.asOf, candidates, selected, 'No due existing task is eligible; selected the highest-priority P4-admitted new-word task.');
  }
  const status = noTaskStatus(input, candidates);
  return { status, task: null, candidates, reason: noTaskReason(status, input), asOf: input.asOf };
}

/** Decision boundary: run the pure selector and persist its full explanation. */
export function recordNextTaskDecision(input: TaskAssignmentInput, logger: TaskAssignmentLogger = defaultLogger): TaskAssignmentResult {
  const decision = selectNextTask(input);
  logger({ event: 'task_assignment.decided', decision });
  return decision;
}

function makeCandidate(input: TaskAssignmentInput, wordId: string, axis: Axis | 'both', kind: CandidateKind, task: TaskType, stage: RetrieveStage | undefined, dueAt: string | undefined, material: boolean, admitted = true, priority = ''): TaskCandidate {
  const cooling = input.cooldownUntil !== null && input.cooldownUntil > input.asOf;
  const capacityFull = input.completedToday >= input.maxTasksToday;
  const eligible = material && admitted && !cooling && !capacityFull;
  const skippedReason = !material ? 'material_unavailable' : !admitted ? (input.capacity.blockedWordId === wordId ? 'capacity' : 'not_admitted') : cooling ? 'cooldown' : capacityFull ? 'capacity' : undefined;
  const kindPriority = kind === 'review' ? '1_review' : kind === 'learning' ? '2_learning' : '3_new_word';
  return { wordId, axis, kind, task, ...(stage ? { stage } : {}), ...(dueAt ? { dueAt } : {}), eligible, ...(skippedReason ? { skippedReason } : {}), priority: `${kindPriority};${priority}` };
}
function choose(list: TaskCandidate[]): TaskCandidate {
  return [...list].sort((a, b) => {
    const order: Record<CandidateKind, number> = { review: 0, learning: 1, new_word: 2 };
    const category = order[a.kind] - order[b.kind];
    if (category) return category;
    if (a.kind !== 'new_word' && a.dueAt !== b.dueAt) return (a.dueAt ?? '').localeCompare(b.dueAt ?? '');
    if (a.kind === 'new_word') {
      const [aSrc = '', aBasis = ''] = a.priority.match(/source=([^;]*);basis=([^;]*)/)?.slice(1) ?? [];
      const [bSrc = '', bBasis = ''] = b.priority.match(/source=([^;]*);basis=([^;]*)/)?.slice(1) ?? [];
      if (aSrc !== bSrc || aBasis !== bBasis) return `${aSrc};${aBasis}`.localeCompare(`${bSrc};${bBasis}`);
      const ar = Number(a.priority.match(/rank=(\d+(?:\.\d+)?)/)?.[1] ?? Infinity);
      const br = Number(b.priority.match(/rank=(\d+(?:\.\d+)?)/)?.[1] ?? Infinity);
      if (ar !== br) return ar - br;
      const ag = Number(a.priority.match(/targetGap=(\d+)/)?.[1] ?? 0);
      const bg = Number(b.priority.match(/targetGap=(\d+)/)?.[1] ?? 0);
      if (ag !== bg) return bg - ag;
    }
    return a.wordId.localeCompare(b.wordId) || axisOrder(a.axis) - axisOrder(b.axis);
  })[0];
}
function finish(asOf: string, candidates: TaskCandidate[], selected: TaskCandidate, reason: string): TaskAssignmentResult {
  return { status: 'task_selected', task: { ...selected, reason }, candidates, reason, asOf };
}
function noTaskStatus(input: TaskAssignmentInput, candidates: TaskCandidate[]): TaskAssignmentResult['status'] {
  if (input.completedToday >= input.maxTasksToday) return 'capacity_reached';
  if (!input.newWords.length && !input.words.some(word => axes.some(axis => !word[axis].graduated && word[axis].dueAt !== 'infinity' && word[axis].dueAt <= input.asOf))) return 'no_due_tasks';
  if (candidates.some(candidate => candidate.skippedReason === 'capacity') || input.capacity.reason === 'capacity_reached') return 'capacity_reached';
  if (candidates.some(candidate => candidate.skippedReason === 'cooldown')) return 'cooldown';
  if (candidates.some(candidate => candidate.skippedReason === 'material_unavailable')) return 'material_unavailable';
  if (!input.newWords.length && !input.capacity.admittedWordIds.length) return 'no_candidates';
  return 'no_due_tasks';
}
function noTaskReason(status: TaskAssignmentResult['status'], input: TaskAssignmentInput): string {
  if (status === 'capacity_reached') return `Daily task capacity is full or P4 blocks the next word${input.capacity.blockingDate ? ` on ${input.capacity.blockingDate}` : ''}.`;
  if (status === 'cooldown') return `Shared cooldown is active until ${input.cooldownUntil}.`;
  if (status === 'material_unavailable') return 'No eligible task has its required material available.';
  if (status === 'no_candidates') return 'There are no new-word candidates to assign.';
  return 'There are no due tasks and no eligible new-word task.';
}
function compareNewWords(a: AssignmentNewWord, b: AssignmentNewWord): number {
  const sourceKey = (w: AssignmentNewWord) => `${w.rankSource?.id ?? ''};${w.rankSource?.basis ?? ''}`;
  if (sourceKey(a) !== sourceKey(b)) return sourceKey(a).localeCompare(sourceKey(b));
  if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
  const gap = (w: AssignmentNewWord) => Math.max(0, w.targets.R - initialScores(w.band).R) + Math.max(0, w.targets.P - initialScores(w.band).P);
  return gap(b) - gap(a) || a.id.localeCompare(b.id);
}
function initialScores(band: AssignmentNewWord['band']): { R: number; P: number } {
  return { common: { R: 60, P: 40 }, known: { R: 40, P: 20 }, less_common: { R: 20, P: 5 }, unknown: { R: 0, P: 0 } }[band];
}
function axisOrder(axis: Axis | 'both'): number { return axis === 'R' || axis === 'both' ? 0 : 1; }
function minDate(a: string, b: string): string { return a < b ? a : b; }
function validate(input: TaskAssignmentInput): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf)) throw new RangeError('asOf must be an ISO local date');
  if (!Number.isInteger(input.completedToday) || input.completedToday < 0 || !Number.isInteger(input.maxTasksToday) || input.maxTasksToday < 0) throw new RangeError('task counts must be non-negative integers');
  if (input.cooldownUntil && !/^\d{4}-\d{2}-\d{2}$/.test(input.cooldownUntil)) throw new RangeError('cooldownUntil must be an ISO local date or null');
  if (new Set(input.words.map(word => word.id)).size !== input.words.length || new Set(input.newWords.map(word => word.id)).size !== input.newWords.length) throw new RangeError('word IDs must be unique within each list');
  for (const word of input.words) for (const axis of axes) if (word[axis].dueAt !== 'infinity' && !/^\d{4}-\d{2}-\d{2}$/.test(word[axis].dueAt)) throw new RangeError('dueAt must be an ISO local date or infinity');
}
