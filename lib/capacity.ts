import { logger as appLogger } from './logger';
import { addLocalDays, type AxisSchedule } from './schedule';
import { selectTask } from './scoring';
import type { EstimateBand } from './vocabulary';

export interface DailyCapacity {
  date: string;
  capacity: number;
  completed: number;
  proposed: number;
  confirmed: number;
  overdue: number;
  conditional: number;
  remaining: number;
  shortfall: number;
}
export interface ConditionalReservation {
  wordId: string;
  axis: 'R' | 'P';
  anchorDate: string;
  anchor: 'next_learning_due' | 'next_review_due' | 'projected_learning_completion';
  reviewDate: string;
  modeledPath: 'successful_learning_then_reviews' | 'successful_reviews';
}
export interface CapacityPlan {
  asOf: string;
  through: string;
  days: DailyCapacity[];
  conditionalReservations: ConditionalReservation[];
  firstOverCapacityDate: string | null;
}
export interface CapacityWord {
  id: string;
  R: AxisSchedule;
  P: AxisSchedule;
}
export interface CapacityInput {
  asOf: string;
  maxTasksPerDay: number | Record<string, number>;
  words: CapacityWord[];
  completedByDate: Record<string, number>;
}
export type CapacityReason = 'capacity_reached' | 'candidate_unavailable' | 'no_candidates' | null;
export interface NewWordCandidate {
  id: string;
  band: EstimateBand;
  targets: { R: number; P: number };
  materialAvailable: boolean;
  cooldownReady: boolean;
  timeAvailable: boolean;
}
export interface NewWordCapacityInput extends CapacityInput { candidates: NewWordCandidate[] }
export interface NewWordCapacityResult {
  asOf: string;
  maxNewWordsToday: number;
  admittedWordIds: string[];
  blockedWordId: string | null;
  blockingDate: string | null;
  reason: CapacityReason;
  plan: CapacityPlan;
}

const HORIZON_DAYS = 42;
const REVIEW_OFFSETS = [1, 4, 11, 41] as const;
const INITIAL_SCORES: Readonly<Record<EstimateBand, { R: number; P: number }>> = Object.freeze({
  common: { R: 60, P: 40 }, known: { R: 40, P: 20 }, less_common: { R: 20, P: 5 }, unknown: { R: 0, P: 0 },
});

/** Explicit P4 first-day demand policy, one named place to revise if product policy changes. */
export const FIRST_DAY_TASK_DEMAND: Readonly<Record<EstimateBand, number>> = Object.freeze({
  common: 3,
  known: 5,
  less_common: 7,
  unknown: 9,
});

export function planCapacity(input: CapacityInput): CapacityPlan {
  validateInput(input);
  const through = addLocalDays(input.asOf, HORIZON_DAYS - 1);
  const dates = Array.from({ length: HORIZON_DAYS }, (_, i) => addLocalDays(input.asOf, i));
  const completed = { ...input.completedByDate };
  const confirmed = countConfirmed(input);
  const overdue = countOverdue(input);
  const conditionalReservations: ConditionalReservation[] = [];
  const learningProposals = new Map<string, number>();
  // 按当前分数模拟最快成功任务路径，使用 dueAt 作为起点，并受每日剩余任务容量限制，推算实际达标日。
  for (const word of input.words) {
    const sharedEncode = word.R.score === 0 && word.P.score === 0 &&
      !word.R.graduated && !word.P.graduated && word.R.dueAt !== 'infinity' && word.P.dueAt !== 'infinity';
    const sharedEncodeDate = sharedEncode ? maxDate(input.asOf, maxDate(word.R.dueAt, word.P.dueAt)) : null;
    for (const axis of ['R', 'P'] as const) {
      const state = word[axis];
      // 已毕业或 dueAt 为 infinity 的轴没有待安排任务，跳过它。
      if (state.graduated || state.dueAt === 'infinity') continue;

      // dueAt 是该轴下一项任务的最早日期。逾期任务按今天纳入容量，但这里只计算视图，不改写原状态。
      const dueDate = sharedEncodeDate ?? (state.dueAt < input.asOf ? input.asOf : state.dueAt);
      if (state.learningComplete) {
        // 已完成学习的轴不再推算达标过程；dueAt 是下一次已排期复习，按当前 reviewLevel 推算这次成功后的复习。
        for (const offset of successfulReviewOffsets(state.reviewLevel)) {
          const reviewDate = addLocalDays(dueDate, offset);
          if (reviewDate >= input.asOf && reviewDate <= through) conditionalReservations.push({ wordId: word.id, axis, anchorDate: dueDate, anchor: 'next_review_due', reviewDate, modeledPath: 'successful_reviews' });
        }
        continue;
      }

      // 未完成学习时，从当前分数选择最快的成功任务路径；例如 40 分会依次选择 RETRIEVE free 和 FLUENCY。
      const neededTasks = successfulTasksToTarget(state.score, state.target);

      // 当前 dueAt 对应的第一项任务已计入 confirmed/overdue，只安排后续任务；共享 ENCODE 只计一次。
      // 后续任务逐日占用剩余容量；最后一项任务所在日期就是预计达标日。若 42 天内放不下则不生成达标后的预测。
      const attained = scheduleRemainingLearningTasks(input, dueDate, Math.max(0, neededTasks - 1), learningProposals);
      if (!attained) continue;

      // 从预计达标日预留 +1、+4、+11、+41 天的四次成功复习，只保留落在 42 天窗口内的日期。
      for (const offset of REVIEW_OFFSETS) {
        const reviewDate = addLocalDays(attained, offset);
        if (reviewDate >= input.asOf && reviewDate <= through) conditionalReservations.push({ wordId: word.id, axis, anchorDate: attained, anchor: 'projected_learning_completion', reviewDate, modeledPath: 'successful_learning_then_reviews' });
      }
    }
  }
  return buildPlan(input, dates, completed, confirmed, overdue, conditionalReservations, learningProposals);
}

/** Simulates a stable candidate prefix; adding each candidate reserves its stated first-day demand and future axis reviews. */
export function estimateNewWordCapacity(input: NewWordCapacityInput): NewWordCapacityResult {
  let plan = planCapacity(input);
  // 候选池为空时直接返回当前计划，不把“没有候选词”误报为容量不足。
  if (!input.candidates.length) return { asOf: input.asOf, maxNewWordsToday: 0, admittedWordIds: [], blockedWordId: null, blockingDate: null, reason: 'no_candidates', plan };
  const ids = new Set<string>();
  const admittedWordIds: string[] = [];
  const addedDemand = new Map<string, number>();
  const extraReservations: ConditionalReservation[] = [];
  for (const candidate of input.candidates) {
    if (!candidate.id || ids.has(candidate.id)) throw new RangeError('candidate IDs must be non-empty and unique');
    ids.add(candidate.id);

    // 1. 根据 P3 band 还原初始 R/P 分数，并按目标模拟最短的全成功任务路径；路径长度就是首日任务量。
    // ENCODE 若同时初始化 R/P，只计一个任务。
    const scores = INITIAL_SCORES[candidate.band];
    const demand = candidateTaskDemand(scores, candidate.targets);

    // 2. 材料、共享冷却或当天可用时间任一不满足，就在此候选处停止，保留已准入的连续前缀。
    const ineligible = !candidate.materialAvailable || !candidate.cooldownReady || !candidate.timeAvailable;
    if (ineligible) return result(input.asOf, admittedWordIds, candidate.id, input.asOf, 'candidate_unavailable', plan);
    if (!Number.isInteger(demand) || demand < 0) throw new RangeError('firstDayTaskDemand must be a non-negative integer');

    // 3. 复制当前临时计划，叠加该词今天的学习任务，以及从预计达标日开始的 +1/+4/+11/+41 天复习预留。
    const nextDemand = new Map(addedDemand);
    nextDemand.set(input.asOf, (nextDemand.get(input.asOf) ?? 0) + demand);
    const candidateReservations = candidateReservationsFor(input.asOf, plan.through, candidate);
    const proposedPlan = buildPlanFromBase(input, nextDemand, [...extraReservations, ...candidateReservations]);
    const limiting = proposedPlan.days.find(day => day.shortfall > 0);

    // 4. 若 42 天内任一天超额，拒绝当前候选并停止；按日期顺序找到的就是最早阻塞日。
    if (limiting) return result(input.asOf, admittedWordIds, candidate.id, limiting.date, 'capacity_reached', plan);
    admittedWordIds.push(candidate.id);
    addedDemand.set(input.asOf, (addedDemand.get(input.asOf) ?? 0) + demand);
    extraReservations.push(...candidateReservations);
    plan = proposedPlan;
  }
  // 5. 返回连续准入词数、ID，以及已叠加所有准入候选的最终 42 天计划。
  return result(input.asOf, admittedWordIds, null, null, null, plan);
}

function candidateReservationsFor(asOf: string, through: string, candidate: NewWordCandidate): ConditionalReservation[] {
  const result: ConditionalReservation[] = [];
  for (const axis of ['R', 'P'] as const) {
    // 准入前要求整条最快学习路径能在今天完成，因此候选轴的预计达标锚点就是 asOf。
    const attained = asOf;
    assertDate(attained);
    for (const offset of REVIEW_OFFSETS) {
      const reviewDate = addLocalDays(attained, offset);
      if (reviewDate >= asOf && reviewDate <= through) result.push({ wordId: candidate.id, axis, anchorDate: attained, anchor: 'projected_learning_completion', reviewDate, modeledPath: 'successful_learning_then_reviews' });
    }
  }
  return result;
}

function buildPlanFromBase(input: CapacityInput, added: Map<string, number>, reservations: ConditionalReservation[]): CapacityPlan {
  const base = planCapacity(input);
  const dates = base.days.map(day => day.date);
  const completed = { ...input.completedByDate };
  // Candidate reviews are conditional overlays; current-word forecasts are already in the base plan.
  const currentReservations = base.conditionalReservations;
  const baseProposed = new Map<string, number>();
  for (const day of base.days) if (day.proposed > 0) baseProposed.set(day.date, day.proposed);
  for (const [date, count] of added) baseProposed.set(date, (baseProposed.get(date) ?? 0) + count);
  return buildPlan(input, dates, completed, countConfirmed(input), countOverdue(input), [...currentReservations, ...reservations], baseProposed);
}

function countConfirmed(input: CapacityInput): Map<string, number> {
  const map = new Map<string, number>();
  const through = addLocalDays(input.asOf, 41);
  for (const word of input.words) {
    const sharedEncode = word.R.score === 0 && word.P.score === 0 && !word.R.graduated && !word.P.graduated && word.R.dueAt !== 'infinity' && word.P.dueAt !== 'infinity';
    if (sharedEncode) {
      const date = maxDate(word.R.dueAt, word.P.dueAt);
      if (date >= input.asOf && date <= through) map.set(date, (map.get(date) ?? 0) + 1);
      continue;
    }
    for (const axis of ['R', 'P'] as const) {
      const s = word[axis]; if (!s.graduated && s.dueAt !== 'infinity' && s.dueAt >= input.asOf && s.dueAt <= through) map.set(s.dueAt, (map.get(s.dueAt) ?? 0) + 1);
    }
  }
  return map;
}
function countOverdue(input: CapacityInput): number {
  return input.words.reduce((sum, word) => {
    const sharedEncode = word.R.score === 0 && word.P.score === 0 && !word.R.graduated && !word.P.graduated && word.R.dueAt !== 'infinity' && word.P.dueAt !== 'infinity';
    if (sharedEncode) return sum + (maxDate(word.R.dueAt, word.P.dueAt) < input.asOf ? 1 : 0);
    return sum + (['R', 'P'] as const).filter(axis => !word[axis].graduated && word[axis].dueAt !== 'infinity' && word[axis].dueAt < input.asOf).length;
  }, 0);
}
function buildPlan(input: CapacityInput, dates: string[], completed: Record<string, number>, confirmed: Map<string, number>, overdue: number, reservations: ConditionalReservation[], proposed = new Map<string, number>()): CapacityPlan {
  const reservationCounts = new Map<string, number>();
  for (const item of reservations) reservationCounts.set(item.reviewDate, (reservationCounts.get(item.reviewDate) ?? 0) + 1);
  const days = dates.map(date => {
    const capacity = typeof input.maxTasksPerDay === 'number' ? input.maxTasksPerDay : input.maxTasksPerDay[date] ?? 0;
    const done = completed[date] ?? 0;
    const proposedDemand = proposed.get(date) ?? 0;
    const due = confirmed.get(date) ?? 0;
    const overdueToday = date === input.asOf ? overdue : 0;
    const conditional = reservationCounts.get(date) ?? 0;
    const remaining = capacity - done - proposedDemand - due - overdueToday - conditional;
    return { date, capacity, completed: done, proposed: proposedDemand, confirmed: due, overdue: overdueToday, conditional, remaining, shortfall: Math.max(0, -remaining) };
  });
  return { asOf: input.asOf, through: dates[dates.length - 1], days, conditionalReservations: reservations.map(r => ({ ...r })), firstOverCapacityDate: days.find(day => day.shortfall > 0)?.date ?? null };
}
function result(asOf: string, admittedWordIds: string[], blockedWordId: string | null, blockingDate: string | null, reason: CapacityReason, plan: CapacityPlan): NewWordCapacityResult {
  return { asOf, maxNewWordsToday: admittedWordIds.length, admittedWordIds: [...admittedWordIds], blockedWordId, blockingDate, reason, plan };
}
function successfulReviewOffsets(level: AxisSchedule['reviewLevel']): number[] {
  switch (level) {
    case 1: return [3, 10, 40]; // next levels: 3, 7, 30 days
    case 3: return [7, 37];
    case 7: return [30];
    case 30: return []; // passing the final review graduates the axis
  }
}
function successfulTasksToTarget(score: number, target: number): number {
  if (!Number.isFinite(score) || score < 0 || score > 100 || !Number.isFinite(target) || target <= 0 || target > 100) throw new RangeError('score and target must be in valid score ranges');
  let current = score;
  let tasks = 0;
  if (current === 0) {
    const task = selectTask(current);
    if (task.task === 'ENCODE') { tasks++; current = 5; }
  }
  while (current < 60) {
    const task = selectTask(current);
    if (task.task !== 'RETRIEVE' || !task.stage) throw new Error('Unexpected task path before fluency');
    tasks++;
    current = task.stage === 'choice' ? 20 : task.stage === 'cued' ? 40 : 60;
  }
  // A learning-incomplete axis must still pass FLUENCY, even if its score already meets target.
  if (current >= 60) tasks++;
  return tasks;
}
function candidateTaskDemand(scores: { R: number; P: number }, targets: { R: number; P: number }): number {
  const bothEncode = scores.R === 0 && scores.P === 0;
  return successfulTasksToTarget(scores.R, targets.R) + successfulTasksToTarget(scores.P, targets.P) - (bothEncode ? 1 : 0);
}
function scheduleRemainingLearningTasks(input: CapacityInput, dueDate: string, remainingTasks: number, proposed: Map<string, number>): string | null {
  if (remainingTasks === 0) return dueDate <= addLocalDays(input.asOf, 41) ? dueDate : null;
  let lastTaskDate: string | null = null;
  let date = dueDate;
  const through = addLocalDays(input.asOf, HORIZON_DAYS - 1);
  for (let day = 0; date <= through && remainingTasks > 0; day++, date = addLocalDays(date, 1)) {
    const capacity = typeof input.maxTasksPerDay === 'number' ? input.maxTasksPerDay : input.maxTasksPerDay[date] ?? 0;
    const existing = (input.completedByDate[date] ?? 0) + (countConfirmed(input).get(date) ?? 0) + (date === input.asOf ? countOverdue(input) : 0) + (proposed.get(date) ?? 0);
    const slots = Math.max(0, capacity - existing);
    const used = Math.min(slots, remainingTasks);
    if (used) { proposed.set(date, (proposed.get(date) ?? 0) + used); remainingTasks -= used; lastTaskDate = date; }
  }
  return remainingTasks === 0 ? lastTaskDate : null;
}
function maxDate(a: string, b: string): string { return [a, b].sort().at(-1)!; }
function validateInput(input: CapacityInput): void {
  assertDate(input.asOf);
  if (!Array.isArray(input.words) || !input.completedByDate || typeof input.completedByDate !== 'object') throw new RangeError('words and completedByDate are required');
  if (typeof input.maxTasksPerDay === 'number') validateCount(input.maxTasksPerDay, 'maxTasksPerDay');
  else for (const [date, count] of Object.entries(input.maxTasksPerDay)) { assertDate(date); validateCount(count, `capacity for ${date}`); }
  const ids = new Set<string>();
  for (const word of input.words) {
    if (!word.id || ids.has(word.id)) throw new RangeError('word IDs must be non-empty and unique'); ids.add(word.id);
    for (const axis of ['R', 'P'] as const) {
      const s = word[axis];
      if (!Number.isFinite(s.score) || s.score < 0 || s.score > 100 || !Number.isFinite(s.target) || s.target <= 0 || s.target > 100) throw new RangeError('axis score and target must be in valid score ranges');
      if (s.dueAt !== 'infinity') assertDate(s.dueAt);
    }
  }
  for (const [date, count] of Object.entries(input.completedByDate)) { assertDate(date); validateCount(count, `completed count for ${date}`); }
}
function validateCount(value: number, name: string): void { if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`); }
function assertDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) throw new RangeError('Expected valid ISO local calendar date');
}

export interface CapacityDecisionEvent {
  event: 'capacity.new_words_estimated';
  asOf: string;
  maxTasksPerDay: CapacityInput['maxTasksPerDay'];
  candidates: Array<{ id: string; band: EstimateBand; firstDayTaskDemand: number; targets: NewWordCandidate['targets'] }>;
  before: Array<Pick<DailyCapacity, 'date' | 'capacity' | 'completed' | 'confirmed' | 'overdue' | 'conditional' | 'remaining' | 'shortfall'>>;
  addedConditionalReservations: ConditionalReservation[];
  result: NewWordCapacityResult;
}
export function recordNewWordCapacityEstimate(input: NewWordCapacityInput, log: (event: CapacityDecisionEvent) => void = event => appLogger.info(event, 'New word capacity estimated')): CapacityDecisionEvent {
  const estimated = estimateNewWordCapacity(input);
  const before = planCapacity(input);
  const event: CapacityDecisionEvent = {
    event: 'capacity.new_words_estimated', asOf: input.asOf,
    maxTasksPerDay: typeof input.maxTasksPerDay === 'number' ? input.maxTasksPerDay : { ...input.maxTasksPerDay },
    candidates: input.candidates.map(candidate => ({ id: candidate.id, band: candidate.band, firstDayTaskDemand: candidateTaskDemand(INITIAL_SCORES[candidate.band], candidate.targets), targets: { ...candidate.targets } })),
    before: before.days.map(({ date, capacity, completed, confirmed, overdue, conditional, remaining, shortfall }) => ({ date, capacity, completed, confirmed, overdue, conditional, remaining, shortfall })),
    addedConditionalReservations: estimated.plan.conditionalReservations.filter(reservation => !before.conditionalReservations.some(existing => existing.wordId === reservation.wordId && existing.axis === reservation.axis && existing.reviewDate === reservation.reviewDate)),
    result: estimated,
  };
  log(event);
  return event;
}
