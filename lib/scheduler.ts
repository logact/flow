import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { CONFIG } from './config';
import { bandOf, cacheResidue, retrievabilityParts, toWord, type Word, type WordRow } from './db';
import { levelOf } from './assessment';
import { getProfile } from './targets';
import {
  candidatesOf,
  eligibleTaskDefinitions,
  materialWords,
  ordinaryCandidates,
  readable,
  taskRank,
  type Candidate,
  type EmptyReason,
  type EmptyTaskInstance,
  type TaskDefinition,
  type TaskEvidence,
  type TaskInstance,
  type TaskPurpose,
  type ScheduledTaskInstance,
  TASK_LIBRARY,
} from './tasks';
import { assessContinuousMaterial } from './material';
import { sliceMfi, sliceMfiDetailed } from './mfi';
import { presumedKnown } from './gloss';

export type Task =
  | { kind: 'STEP12'; word: Word; relearn?: boolean }
  | { kind: 'STEP3'; word: Word; srsReview: boolean }
  | { kind: 'STEP4'; word: Word; timeBudgetMs: number }
  | { kind: 'STEP4R'; word: Word; timeBudgetMs: number }
  | {
      kind: 'MFI';
      word: Word;
      passage: string;
      passageWords: number;
      options: string[];
      answerIndex: number;
      timeBudgetMs: number;
    }
  | { kind: 'PART_B'; words: Word[] }
  | { kind: 'EMPTY'; nextAvailableInMs: number | null };

// 计分方向：R = 接受（阅读），P = 产出（写作）。recognition never implies production，
// 两个方向各自持有 F 与 H_time（见 RPD「流利度分数算法」）
export type Direction = 'p' | 'r';

export function getTick(db: Database.Database): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'global_tick'`).get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

// 当前激活的学习目标：NULL = 全部目标。新词引入只受激活目标限制；复习默认目标盲，
// 纯按优先级 P 竞争——遗忘不等人（见 RPD「作用域规则」）。
// 用户可开启「只学当前目标」（meta.goal_scope_strict）：此时复习同样限定激活目标，
// 代价是其他目标的在学词暂停复习（间隔拉长，回忆率自然下滑）。
export function getActiveGoalId(db: Database.Database): number | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'active_goal_id'`).get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : null;
}

export function setActiveGoalId(db: Database.Database, goalId: number | null): void {
  if (goalId == null) {
    db.prepare(`DELETE FROM meta WHERE key = 'active_goal_id'`).run();
  } else {
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('active_goal_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(String(goalId));
  }
}

// 「只学当前目标」开关：开启后复习（Part B 批次 + 成熟 KP）也只看激活目标
export function getGoalScopeStrict(db: Database.Database): boolean {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'goal_scope_strict'`).get() as
    | { value: string }
    | undefined;
  return row?.value === '1';
}

export function setGoalScopeStrict(db: Database.Database, strict: boolean): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('goal_scope_strict', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(strict ? '1' : '0');
}

// 目标画像中的目标速度（游标封顶用），缺省/脏数据回退 fallback
function goalSpeed(db: Database.Database, goalId: number | null, key: 'reading_wpm' | 'writing_wpm', fallback: number): number {
  const v = getProfile(db, goalId)[key];
  return typeof v === 'number' && v > 0 ? v : fallback;
}

// 重要性权重：高频 KP 更值钱（log 压平 Zipf 分布的数量级，保留相对排序）
const wFreq = (w: Word) => 1 + Math.log(1 + (w.freq ?? 0));

// 优先级（RPD「分数驱动队列」）：
//   gap     = max(0, target_a − F_a) / target_a      需求度：距个人终点的归一化缺口。
//             轴达标但保持力未验证（H_time < 30d）→ MAINT_GAP 维护缺口，低优先级留在队列；
//             达标且保持力已验证 → 0，自然退场（毕业语义进公式）
//   urgency = ((RIPE_R − L_a) / RIPE_R)²             紧迫度：按长时痕迹 L 计逾期（缓存冷 ≠ 遗忘），平方加速
//   P       = w_freq × gap × (1 + URGENCY_GAIN × urgency)
export function priority(w: Word, dir: Direction, lA: number): number {
  const F = dir === 'r' ? w.fluency_r : w.fluency;
  const target = dir === 'r' ? w.target_in : w.target_out;
  const h = dir === 'r' ? w.stability_time_r : w.stability_time;
  const verified = dir === 'r' ? w.verified_r : w.verified_p;
  const speedVerified = dir === 'r' ? w.speed_verified_r : w.speed_verified_p;
  const axisDone = F >= target && verified === 1 && speedVerified === 1 && h >= CONFIG.H_TIME_GRAD_MS;
  let gap = Math.max(0, target - F) / target;
  if (gap <= 0) {
    if (axisDone) return 0;
    gap = CONFIG.MAINT_GAP;
  }
  const urgency = Math.max(0, (CONFIG.RIPE_R - lA) / CONFIG.RIPE_R) ** 2;
  return wFreq(w) * gap * (1 + CONFIG.URGENCY_GAIN * urgency);
}

// 自适应速度游标（per-user per-modality，存 meta）：游标定压力，标尺定分数
function getCursor(db: Database.Database, modality: string, floor: number): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(`v_cursor_${modality}`) as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : floor;
}

function setCursor(db: Database.Database, modality: string, v: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(`v_cursor_${modality}`, String(v));
}

// T_budget = 材料长度 / v_cursor（游标朝目标速度棘轮）
function step4BudgetMs(db: Database.Database, w: Word): number {
  const cursor = getCursor(db, 'writing', CONFIG.V_FLOOR_WRITING);
  return Math.round((materialWords(w) / cursor) * 60_000);
}

function step4rBudgetMs(db: Database.Database, w: Word): number {
  const cursor = getCursor(db, 'reading', CONFIG.V_FLOOR_READING);
  return Math.round((materialWords(w) / cursor) * 60_000);
}

// 书源语料（MFI 的材料来源）：goal.target.source_id → book_sources.text，模块级缓存
const bookTextCache = new Map<number, string | null>();
function bookTextFor(db: Database.Database, w: Word): string | null {
  const sourceId = getProfile(db, w.goal_id).source_id;
  if (sourceId == null) return null;
  if (!bookTextCache.has(sourceId)) {
    const row = db.prepare(`SELECT text FROM book_sources WHERE id = ?`).get(sourceId) as
      | { text: string | null }
      | undefined;
    bookTextCache.set(sourceId, row?.text ?? null);
  }
  return bookTextCache.get(sourceId) ?? null;
}

// MFI 的「已知词」集合：词频表前 vocab_estimate 词（假定已知）∪ 测量确认词 ∪ 已学 KP 的 token
// （虚词与短词在 sliceMfi 内部视同已知）
function knownTokenSet(db: Database.Database, words: Word[]): Set<string> {
  const attempted = new Set<string>();
  for (const w of words) {
    if (w.last_ts === 0) continue;
    for (const t of w.chunk.toLowerCase().split(/\s+/)) attempted.add(t);
  }
  const vocabRow = db.prepare(`SELECT value FROM meta WHERE key = 'vocab_estimate'`).get() as
    | { value: string }
    | undefined;
  return presumedKnown(db, vocabRow ? Number(vocabRow.value) : null, attempted);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

interface InstanceCandidate {
  word: Word;
  axis: Direction;
  definition: TaskDefinition;
  purpose: TaskPurpose;
  checkpoint: number | null;
  priority: number;
  payload: Record<string, unknown>;
}

const axisScore = (word: Word, axis: Direction) => axis === 'r' ? word.fluency_r : word.fluency;
const axisTarget = (word: Word, axis: Direction) => axis === 'r' ? word.target_in : word.target_out;
const axisVerified = (word: Word, axis: Direction) => axis === 'r' ? word.verified_r : word.verified_p;
const axisSpeedVerified = (word: Word, axis: Direction) => axis === 'r' ? word.speed_verified_r : word.speed_verified_p;
const axisIntegrated = (word: Word, axis: Direction) => axis === 'r' ? word.integrated_r : word.integrated_p;
const axisObservation = (word: Word, axis: Direction) => axis === 'r' ? word.has_observation_r : word.has_observation_p;
const axisTimeAnchor = (word: Word, axis: Direction) => axis === 'r' ? word.last_ts_r : word.last_ts;
const axisStability = (word: Word, axis: Direction) => axis === 'r' ? word.stability_time_r : word.stability_time;
const axisRelearnPending = (word: Word, axis: Direction) => axis === 'r' ? word.pending_relearn_r : word.pending_relearn_p;

function axisComplete(word: Word, axis: Direction): boolean {
  return axisScore(word, axis) >= axisTarget(word, axis) &&
    axisVerified(word, axis) === 1 && axisSpeedVerified(word, axis) === 1 &&
    axisStability(word, axis) >= CONFIG.H_TIME_GRAD_MS;
}

/** Shared P/R cooling: either seven other tasks or twenty minutes is enough. */
function coolingReady(word: Word, tick: number, now: number): boolean {
  const lastAny = Math.max(word.last_ts, word.last_ts_r);
  if (lastAny === 0) return true;
  const tickElapsed = Math.max(0, tick - word.last_tick);
  const timeElapsed = Math.max(0, now - lastAny);
  return tickElapsed >= CONFIG.CACHE_COOLDOWN_TICKS || timeElapsed >= CONFIG.H_CACHE_MS;
}

function nextEligibleAt(word: Word, axis: Direction, tick: number, now: number): number {
  const anchor = axisTimeAnchor(word, axis);
  const matureAt = anchor === 0 || axisObservation(word, axis) !== 1
    ? now
    : anchor + axisStability(word, axis) * Math.log(1 / CONFIG.RIPE_R) / Math.LN2;
  const lastAny = Math.max(word.last_ts, word.last_ts_r);
  const tickElapsed = Math.max(0, tick - word.last_tick);
  const coolingAt = lastAny === 0 || tickElapsed >= CONFIG.CACHE_COOLDOWN_TICKS
    ? now
    : lastAny + CONFIG.H_CACHE_MS;
  return Math.max(now, matureAt, coolingAt);
}

function nextCheckpoint(word: Word, axis: Direction, type: TaskDefinition['type'], purpose: TaskPurpose): number | null {
  if (type === 'ENCODE') return null;
  const score = axisScore(word, axis);
  if (type === 'INTEGRATE') return Math.max(CONFIG.INTEGRATE_FLOOR, score);
  if (type === 'RETRIEVE') {
    if (score === 0) {
      if (purpose === 'verify' && (word.prior_mastery_q ?? 0) >= 0.7) return 50;
      if (purpose === 'diagnose' && (word.prior_mastery_q ?? 0) >= 0.3) return 35;
      return 20;
    }
    // Retrieval can certify only through 50; it cannot restore a higher checkpoint.
    return Math.min(50, axisVerified(word, axis) === 1 ? ([20, 35, 50].find((n) => n > score) ?? 50) : score);
  }
  if (axisVerified(word, axis) !== 1 || score >= axisTarget(word, axis) || (score >= 60 && axisSpeedVerified(word, axis) !== 1)) {
    return score;
  }
  const next = [20, 35, 50, 60, 75, 90, 100].find((n) => n > score) ?? 100;
  return Math.min(next, axisTarget(word, axis));
}

function axisCandidateDefinitions(
  word: Word,
  axis: Direction,
  type: 'RETRIEVE' | 'FLUENCY',
  purpose: TaskPurpose,
  materials: ReadonlySet<'word' | 'example_sentence' | 'continuous_text' | 'book_text'>,
  accuracyChecks: ReadonlySet<'target_word' | 'passage_comprehension' | 'expression'>,
  wordCount: number
): TaskDefinition[] {
  const context = {
    axis,
    score: axisScore(word, axis),
    purpose,
    materials,
    accuracyChecks,
    wordCount,
    independentResponseAvailable: true,
  } as const;
  const { purpose: _purpose, ...ordinaryContext } = context;
  const candidates = purpose === 'review' || purpose === 'maintain'
    ? ordinaryCandidates(ordinaryContext)
    : eligibleTaskDefinitions(context);
  return candidates.filter((definition) => definition.type === type);
}

function createInstance(
  definition: TaskDefinition,
  axis: Direction,
  purpose: TaskPurpose,
  wordIds: readonly number[],
  checkpoint: number | null,
  payload: Record<string, unknown>,
  now: number
): TaskInstance {
  return {
    instance_id: randomUUID(),
    definition_id: definition.id,
    type: definition.type,
    checkpoint,
    axis,
    purpose,
    word_ids: wordIds,
    payload,
    renderer: definition.renderer,
    issued_at: now,
  };
}

/**
 * Abstract scheduler entry point used by the task API. Every chosen definition,
 * axis, purpose, target word and checkpoint is fixed before the response arrives.
 */
export function getNextTaskInstance(db: Database.Database, now = Date.now()): ScheduledTaskInstance {
  const tick = getTick(db);
  const words = (db.prepare('SELECT * FROM words').all() as WordRow[]).map(toWord);
  const goalId = getActiveGoalId(db);
  const strictScope = goalId != null && getGoalScopeStrict(db);
  const inScope = (word: Word) => !strictScope || word.goal_id === goalId;
  const scopedWords = words.filter(inScope);
  const axes: Direction[] = ['r', 'p'];

  const taskMaterial = (word: Word, axis: Direction) => {
    const text = word.step4_sentences.join(' ').trim();
    const minWords = axis === 'r' ? CONFIG.READ_MIN_WORDS : 30;
    const assessment = assessContinuousMaterial(text, {
      minWords,
      maxWords: 2_000,
      targetWords: [{ wordId: word.id, text: word.chunk }],
    });
    const materials = new Set<'word' | 'example_sentence' | 'continuous_text' | 'book_text'>(['word', 'example_sentence']);
    let continuousText = assessment.eligible ? text : null;
    if (assessment.eligible) materials.add('continuous_text');
    let mfi: ReturnType<typeof sliceMfiDetailed> | null = null;
    if (axis === 'r') {
      const sourceText = bookTextFor(db, word);
      if (sourceText) {
        const allWords = words;
        const known = knownTokenSet(db, allWords);
        mfi = sliceMfiDetailed(sourceText, word.chunk, (token) => known.has(token), {
          rotation: tick,
          targetWords: [{ wordId: word.id, chunk: word.chunk, meaning: word.meaning }],
        });
        if (mfi.available) {
          materials.add('book_text');
          materials.add('continuous_text');
          continuousText = mfi.material.passage;
        }
      }
    }
    const checks = new Set<'target_word' | 'passage_comprehension' | 'expression'>(['target_word']);
    // R fluency evidence requires a server-keyed comprehension question. Plain
    // example sentences can support retrieval, but cannot certify continuous
    // reading comprehension. Only MFI material currently carries that answer key.
    if (axis === 'r' && mfi?.available) checks.add('passage_comprehension');
    else if (axis === 'p' && word.meaning.trim()) checks.add('expression');
    return { text: continuousText, materials, checks, wordCount: continuousText?.match(/[\p{L}][\p{L}'’-]*/gu)?.length ?? 0, mfi };
  };

  const makePayload = (word: Word, axis: Direction, definition: TaskDefinition, checkpoint: number | null, material: ReturnType<typeof taskMaterial>) => {
    const cursor = axis === 'r'
      ? getCursor(db, 'reading', CONFIG.V_FLOOR_READING)
      : getCursor(db, 'writing', CONFIG.V_FLOOR_WRITING);
    const budget = Math.max(0, Math.round((material.wordCount || materialWords(word)) / cursor * 60_000));
    const speedAtCheckpoint = checkpoint != null && checkpoint >= 60
      ? axis === 'r' ? 150 + ((checkpoint - 60) * 150) / 40 : 25 + ((checkpoint - 60) * 35) / 40
      : null;
    return {
      word_id: word.id,
      chunk: word.chunk,
      meaning: word.meaning,
      scene: word.scene,
      example_sentence: word.step3_sentence,
      continuous_text: material.text,
      target_checks: material.mfi?.available ? material.mfi.material.targetChecks : [],
      options: material.mfi?.available ? material.mfi.material.options : [],
      answer_index: material.mfi?.available ? material.mfi.material.answerIndex : null,
      passage_words: material.wordCount,
      time_budget_ms: budget,
      speed_target_wpm: speedAtCheckpoint,
      evidence: definition.evidence,
    };
  };

  const pendingMaterialAxes: {
    word_ids: number[];
    axis: Direction;
    definition_id: string | null;
    checkpoint: number | null;
    purpose: TaskPurpose;
    reasons: string[];
  }[] = [];

  // 1. Explicitly pending same-axis relearning always resumes first.
  for (const word of scopedWords) {
    if (word.graduated) continue;
    const axis = axes.find((a) => axisRelearnPending(word, a) === 1);
    if (!axis) continue;
    if (axis === 'r' && !word.meaning.trim()) {
      pendingMaterialAxes.push({
        word_ids: [word.id], axis, definition_id: 'encode-r', checkpoint: null,
        purpose: 'relearn', reasons: ['gloss_missing'],
      });
      continue;
    }
    const material = taskMaterial(word, axis);
    const definition = TASK_LIBRARY.find((item) => item.id === `encode-${axis}`);
    if (definition) return createInstance(definition, axis, 'relearn', [word.id], null, makePayload(word, axis, definition, null, material), now);
  }

  // 2. Same-axis integration has priority over emergency and ordinary review.
  for (const axis of axes) {
    const pool = scopedWords.filter((word) =>
      !word.graduated && !axisComplete(word, axis) && axisIntegrated(word, axis) !== 1 &&
      axisScore(word, axis) >= CONFIG.INTEGRATE_FLOOR && axisVerified(word, axis) === 1 &&
      (word.meaning.trim().length > 0)
    ).sort((a, b) => (b.freq ?? 0) - (a.freq ?? 0) || a.id - b.id);
    if (axis === 'r') {
      const missingGloss = scopedWords.filter((word) =>
        !word.graduated && !axisComplete(word, axis) && axisIntegrated(word, axis) !== 1 &&
        axisScore(word, axis) >= CONFIG.INTEGRATE_FLOOR && axisVerified(word, axis) === 1 &&
        !word.meaning.trim()
      );
      if (missingGloss.length >= CONFIG.BATCH_SIZE) {
        pendingMaterialAxes.push({
          word_ids: missingGloss.slice(0, CONFIG.BATCH_SIZE).map((word) => word.id),
          axis, definition_id: 'integrate-r', checkpoint: CONFIG.INTEGRATE_FLOOR,
          purpose: 'review', reasons: ['gloss_missing'],
        });
      }
    }
    if (axis === 'p') {
      const missingGloss = scopedWords.filter((word) =>
        !word.graduated && !axisComplete(word, axis) && axisIntegrated(word, axis) !== 1 &&
        axisScore(word, axis) >= CONFIG.INTEGRATE_FLOOR && axisVerified(word, axis) === 1 &&
        !word.meaning.trim()
      );
      if (missingGloss.length >= CONFIG.BATCH_SIZE) {
        pendingMaterialAxes.push({
          word_ids: missingGloss.slice(0, CONFIG.BATCH_SIZE).map((word) => word.id),
          axis, definition_id: 'integrate-p', checkpoint: CONFIG.INTEGRATE_FLOOR,
          purpose: 'review', reasons: ['gloss_missing'],
        });
      }
    }
    if (pool.length < CONFIG.BATCH_SIZE) continue;
    if (axis === 'r') {
      const batchesBySource = new Map<number, Word[]>();
      for (const word of pool) {
        const sourceId = getProfile(db, word.goal_id).source_id;
        if (sourceId == null) continue;
        const group = batchesBySource.get(sourceId) ?? [];
        group.push(word);
        batchesBySource.set(sourceId, group);
      }
      const allWords = words;
      const known = knownTokenSet(db, allWords);
      for (const [sourceId, sourceWords] of batchesBySource) {
        if (sourceWords.length < CONFIG.BATCH_SIZE) continue;
        const batch = sourceWords.slice(0, CONFIG.BATCH_SIZE);
        const sourceText = bookTextFor(db, batch[0]);
        if (!sourceText) continue;
        const sliced = sliceMfiDetailed(sourceText, batch[0].chunk, (token) => known.has(token), {
          rotation: tick,
          targetWords: batch.map((word) => ({ wordId: word.id, chunk: word.chunk, meaning: word.meaning })),
        });
        if (!sliced.available) {
          pendingMaterialAxes.push({
            word_ids: batch.map((word) => word.id), axis, definition_id: 'integrate-r',
            checkpoint: CONFIG.INTEGRATE_FLOOR, purpose: 'review', reasons: [sliced.reason],
          });
          continue;
        }
        const definition = eligibleTaskDefinitions({
          axis: 'r', score: CONFIG.INTEGRATE_FLOOR, purpose: 'review',
          materials: new Set(['word', 'example_sentence', 'continuous_text', 'book_text']),
          accuracyChecks: new Set(['target_word', 'passage_comprehension']),
          wordCount: sliced.material.words,
          independentResponseAvailable: true,
        }).find((item) => item.type === 'INTEGRATE');
        if (!definition) continue;
        return createInstance(definition, 'r', 'review', batch.map((word) => word.id), CONFIG.INTEGRATE_FLOOR, {
          word_ids: batch.map((word) => word.id),
          target_words: batch.map((word) => ({ word_id: word.id, chunk: word.chunk, meaning: word.meaning })),
          continuous_text: sliced.material.passage,
          target_checks: sliced.material.targetChecks,
          options: [],
          answer_index: null,
          passage_words: sliced.material.words,
          evidence: definition.evidence,
        }, now);
      }
      {
        const sameSource = [...batchesBySource.values()].find((group) => group.length >= CONFIG.BATCH_SIZE);
        const batch = (sameSource ?? pool).slice(0, CONFIG.BATCH_SIZE);
        if (batch.length >= CONFIG.BATCH_SIZE && !pendingMaterialAxes.some((item) => item.definition_id === 'integrate-r' && item.word_ids.some((id) => batch.some((word) => word.id === id)))) {
          pendingMaterialAxes.push({
            word_ids: batch.map((word) => word.id), axis, definition_id: 'integrate-r',
            checkpoint: CONFIG.INTEGRATE_FLOOR, purpose: 'review',
            reasons: ['book_source_missing_or_incomplete'],
          });
        }
      }
      continue;
    }
    const batch = pool.slice(0, CONFIG.BATCH_SIZE);
    const materialText = batch.map((word) => word.step4_sentences.join(' ')).join(' ');
    const minWords = 30;
    const materialCheck = assessContinuousMaterial(materialText, {
      minWords,
      maxWords: 2_000,
      targetWords: batch.map((word) => ({ wordId: word.id, text: word.chunk })),
    });
    if (!materialCheck.eligible) {
      pendingMaterialAxes.push({
        word_ids: batch.map((word) => word.id),
        axis,
        definition_id: `integrate-${axis}`,
        checkpoint: CONFIG.INTEGRATE_FLOOR,
        purpose: 'review',
        reasons: materialCheck.issues.length ? [...materialCheck.issues] : ['material_ineligible'],
      });
      continue;
    }
    const checks = new Set<'target_word' | 'passage_comprehension' | 'expression'>(['target_word', 'expression']);
    const materials = new Set<'word' | 'example_sentence' | 'continuous_text' | 'book_text'>(['word', 'example_sentence', 'continuous_text']);
    const definition = eligibleTaskDefinitions({
      axis,
      score: CONFIG.INTEGRATE_FLOOR,
      purpose: 'review',
      materials,
      accuracyChecks: checks,
      wordCount: materialCheck.wordCount,
      independentResponseAvailable: true,
    }).find((item) => item.type === 'INTEGRATE');
    if (!definition) {
      pendingMaterialAxes.push({
        word_ids: batch.map((word) => word.id),
        axis,
        definition_id: `integrate-${axis}`,
        checkpoint: CONFIG.INTEGRATE_FLOOR,
        purpose: 'review',
        reasons: ['task_definition_ineligible'],
      });
      continue;
    }
    return createInstance(definition, axis, 'review', batch.map((word) => word.id), CONFIG.INTEGRATE_FLOOR, {
      word_ids: batch.map((word) => word.id),
      target_words: batch.map((word) => ({ word_id: word.id, chunk: word.chunk, meaning: word.meaning })),
      continuous_text: materialText,
      passage_words: materialCheck.wordCount,
      evidence: definition.evidence,
    }, now);
  }

  // 3. Emergency verification: low long-term retention only expires that axis.
  const emergencies: { word: Word; axis: Direction; retention: number }[] = [];
  for (const word of scopedWords) {
    if (word.graduated) continue;
    for (const axis of axes) {
      const anchor = axisTimeAnchor(word, axis);
      if (axisObservation(word, axis) !== 1 || anchor === 0 || axisComplete(word, axis)) continue;
      if (axis === 'r' && !word.meaning.trim()) continue;
      const retention = retrievabilityParts(word, tick, now, axis).l;
      if (retention < CONFIG.RELEARN_R) emergencies.push({ word, axis, retention });
    }
  }
  emergencies.sort((a, b) => a.retention - b.retention || a.word.id - b.word.id || axes.indexOf(a.axis) - axes.indexOf(b.axis));
  const emergency = emergencies[0];
  if (emergency) {
    const { word, axis } = emergency;
    const verifiedColumn = axis === 'r' ? 'verified_r' : 'verified_p';
    const speedColumn = axis === 'r' ? 'speed_verified_r' : 'speed_verified_p';
    db.prepare(`UPDATE words SET ${verifiedColumn} = 0, ${speedColumn} = 0 WHERE id = ?`).run(word.id);
    const material = taskMaterial(word, axis);
    const defs = axisCandidateDefinitions(word, axis, 'RETRIEVE', 'recover', material.materials, material.checks, material.wordCount);
    const definition = defs[0];
    if (definition) {
      const checkpoint = Math.min(axisScore(word, axis) || 20, 50);
      return createInstance(definition, axis, 'recover', [word.id], checkpoint, makePayload(word, axis, definition, checkpoint, material), now);
    }
  }

  // 4. Generate ordinary candidates with independent L_a and shared C gates.
  const ready: InstanceCandidate[] = [];
  const waitingAt: number[] = [];
  for (const word of scopedWords) {
    if (!word.introduced || word.graduated) continue;
    for (const axis of axes) {
      if (axisComplete(word, axis) || axisRelearnPending(word, axis)) continue;
      if (axis === 'r' && !word.meaning.trim()) {
        const missingType: TaskDefinition['type'] = axisScore(word, axis) >= CONFIG.ACCURACY_FLOOR ? 'FLUENCY' : 'RETRIEVE';
        pendingMaterialAxes.push({
          word_ids: [word.id], axis, definition_id: `${missingType.toLowerCase()}-r`,
          checkpoint: nextCheckpoint(word, axis, missingType, 'review'), purpose: 'review',
          reasons: ['gloss_missing'],
        });
        continue;
      }
      const score = axisScore(word, axis);
      const pFluencyNeedsGloss = axis === 'p' && score >= CONFIG.ACCURACY_FLOOR && !word.meaning.trim();
      if (pFluencyNeedsGloss) {
        pendingMaterialAxes.push({
          word_ids: [word.id], axis, definition_id: 'fluency-p',
          checkpoint: nextCheckpoint(word, axis, 'FLUENCY', 'review'), purpose: 'review',
          reasons: ['gloss_missing'],
        });
      }
      const hasObservation = axisObservation(word, axis) === 1;
      const purpose: TaskPurpose = !hasObservation ? 'verify' : score >= axisTarget(word, axis) ? 'maintain' : 'review';
      const material = taskMaterial(word, axis);
      const preferredType = score >= CONFIG.ACCURACY_FLOOR && !pFluencyNeedsGloss ? 'FLUENCY' : 'RETRIEVE';
      let definitions = axisCandidateDefinitions(
        word,
        axis,
        preferredType,
        purpose,
        material.materials,
        material.checks,
        material.wordCount
      );
      let usedFallback = false;
      if (definitions.length === 0 && preferredType === 'FLUENCY') {
        // Same-axis accuracy retrieval is the only fallback when continuous material is missing.
        definitions = axisCandidateDefinitions(word, axis, 'RETRIEVE', purpose, material.materials, material.checks, material.wordCount);
        usedFallback = definitions.length > 0;
      }
      if (definitions.length === 0) {
        const missingType: TaskDefinition['type'] = preferredType === 'FLUENCY' ? 'RETRIEVE' : preferredType;
        pendingMaterialAxes.push({
          word_ids: [word.id],
          axis,
          definition_id: `${missingType.toLowerCase()}-${axis}`,
          checkpoint: nextCheckpoint(word, axis, missingType, purpose),
          purpose,
          reasons: material.text ? ['ineligible_continuous_material'] : ['continuous_text_unavailable'],
        });
        continue;
      }
      const anchor = axisTimeAnchor(word, axis);
      const l = anchor === 0 ? 1 : retrievabilityParts(word, tick, now, axis).l;
      const retentionGate = !hasObservation || anchor === 0 || l <= CONFIG.RIPE_R;
      const cooldownGate = coolingReady(word, tick, now);
      if (!retentionGate || !cooldownGate) {
        waitingAt.push(nextEligibleAt(word, axis, tick, now));
        continue;
      }
      const definition = definitions[0];
      const checkpoint = nextCheckpoint(word, axis, definition.type, purpose);
      const target = axisTarget(word, axis);
      const taskPriority = priority(word, axis, l);
      if (taskPriority <= 0) continue;
      const payload = {
        ...makePayload(word, axis, definition, checkpoint, material),
        material_fallback: pFluencyNeedsGloss
          ? 'p_expression_gloss_missing'
          : usedFallback ? 'continuous_material_unavailable' : undefined,
        ...(pFluencyNeedsGloss ? { material_gap_checkpoint: nextCheckpoint(word, 'p', 'FLUENCY', purpose) } : {}),
        material_gaps: pendingMaterialAxes
          .filter((gap) => gap.axis === axis && gap.word_ids.includes(word.id))
          .flatMap((gap) => gap.reasons.map((reason) => ({
            definition_id: gap.definition_id,
            axis: gap.axis,
            word_ids: gap.word_ids,
            checkpoint: gap.checkpoint,
            purpose: gap.purpose,
            reason,
          }))),
      };
      ready.push({ word, axis, definition, purpose, checkpoint, priority: taskPriority, payload });
    }
  }

  ready.sort((a, b) => b.priority - a.priority || a.word.id - b.word.id || axes.indexOf(a.axis) - axes.indexOf(b.axis) || a.definition.id.localeCompare(b.definition.id));
  if (ready.length > 0 && ready[0].priority >= CONFIG.NEW_WORD_BYPASS) {
    const candidate = ready[0];
    return createInstance(candidate.definition, candidate.axis, candidate.purpose, [candidate.word.id], candidate.checkpoint, candidate.payload, now);
  }

  // 5. New words use q only to choose their first route; axis scores remain untouched.
  const newWord = scopedWords.filter((word) => word.introduced === 0)
    .sort((a, b) => (b.freq ?? -1) - (a.freq ?? -1) || a.id - b.id)[0];
  if (newWord) {
    const axis: Direction = !newWord.meaning.trim()
      ? 'p'
      : (newWord.target_in - newWord.fluency_r) >= (newWord.target_out - newWord.fluency) ? 'r' : 'p';
    const q = newWord.prior_mastery_q ?? 0;
    const purpose: TaskPurpose = q < 0.3 ? 'introduce' : q < 0.7 ? 'diagnose' : 'verify';
    const type = q < 0.3 ? 'ENCODE' : 'RETRIEVE';
    const material = taskMaterial(newWord, axis);
    const definition = type === 'ENCODE'
      ? TASK_LIBRARY.find((item) => item.id === `encode-${axis}`)
      : axisCandidateDefinitions(newWord, axis, 'RETRIEVE', purpose, material.materials, material.checks, material.wordCount)[0];
    if (definition) {
      const checkpoint = type === 'ENCODE' ? null : nextCheckpoint(newWord, axis, type, purpose);
      return createInstance(definition, axis, purpose, [newWord.id], checkpoint, makePayload(newWord, axis, definition, checkpoint, material), now);
    }
  }

  // 6. Return low-demand review work before EMPTY.
  if (ready.length > 0) {
    const candidate = ready[0];
    return createInstance(candidate.definition, candidate.axis, candidate.purpose, [candidate.word.id], candidate.checkpoint, candidate.payload, now);
  }

  const unfinished = scopedWords.flatMap((word) => axes.filter((axis) => !axisComplete(word, axis) && !axisRelearnPending(word, axis)).map((axis) => ({ word, axis })));
  const reason: EmptyReason = waitingAt.length > 0
    ? 'waiting_cooldown'
    : pendingMaterialAxes.length > 0
      ? 'materials_unavailable'
      : unfinished.length === 0 ? 'all_complete' : 'materials_unavailable';
  const nextAvailableAt = reason === 'waiting_cooldown' && waitingAt.length > 0 ? Math.min(...waitingAt) : null;
  const materialGapsByDimension = new Map<string, NonNullable<EmptyTaskInstance['material_gaps']>[number]>();
  for (const item of pendingMaterialAxes) {
    for (const gapReason of item.reasons) {
      const key = JSON.stringify([item.definition_id, item.axis, item.checkpoint, item.purpose, gapReason]);
      const existing = materialGapsByDimension.get(key);
      if (existing) {
        existing.affected_candidate_count += item.word_ids.length;
        existing.word_ids = [...new Set([...existing.word_ids, ...item.word_ids])];
      }
      else materialGapsByDimension.set(key, {
        definition_id: item.definition_id,
        axis: item.axis,
        word_ids: [...item.word_ids],
        checkpoint: item.checkpoint,
        purpose: item.purpose,
        reason: gapReason,
        affected_candidate_count: item.word_ids.length,
      });
    }
  }
  const empty: EmptyTaskInstance = {
    type: 'EMPTY',
    reason,
    next_available_at: nextAvailableAt,
    ...(pendingMaterialAxes.length ? { unavailable_materials: [...new Set(pendingMaterialAxes.flatMap((item) => item.reasons))] } : {}),
    ...(materialGapsByDimension.size ? { material_gaps: [...materialGapsByDimension.values()] } : {}),
  };
  return empty;
}

export function getNextTask(db: Database.Database, now = Date.now()): Task {
  const tick = getTick(db);
  const words = (db.prepare('SELECT * FROM words').all() as WordRow[]).map(toWord);

  // 「只学当前目标」开启且有激活目标时，复习与批次同样限定目标范围
  const gid = getActiveGoalId(db);
  const scoped = gid != null && getGoalScopeStrict(db);
  const inScope = (w: Word) => !scoped || w.goal_id === gid;

  // 1. Part B 批次门禁（不参与 P 竞争）：双轴 F 均 ≥ INTEGRATE_FLOOR 且未整合的 KP
  // 凑满 BATCH_SIZE 个 → 立即触发批次任务
  const integrable = words
    .filter(
      (w) =>
        inScope(w) &&
        !w.graduated &&
        !w.integrated &&
        w.fluency >= CONFIG.INTEGRATE_FLOOR &&
        w.fluency_r >= CONFIG.INTEGRATE_FLOOR
    )
    .sort((a, b) => (b.freq ?? 0) - (a.freq ?? 0) || a.id - b.id);
  if (integrable.length >= CONFIG.BATCH_SIZE)
    return { kind: 'PART_B', words: integrable.slice(0, CONFIG.BATCH_SIZE) };

  // 2. 三元组竞争扫描 + 严重逾期路由
  let relearn: { w: Word; l: number } | null = null;
  let best: { w: Word; cand: Candidate; p: number } | null = null;
  for (const w of words) {
    if (!inScope(w) || w.graduated || w.last_ts === 0) continue;
    const pp = retrievabilityParts(w, tick, now, 'p');
    // 严重逾期（产出痕迹已死）：绕过竞争，直接路由到重编码（Step 1+2 式重新引入）。
    // 判死看长时痕迹 L_P——缓存冷（C→0）只是冲刷到位，不是遗忘。只看 P 轴：
    // R 轴死亡（F_R 托底不刷新 last_ts_r，L_R 自然衰减）不毁 F_P，走正常竞争重测即可。
    if (pp.l < CONFIG.RELEARN_R) {
      if (!relearn || pp.l < relearn.l) relearn = { w, l: pp.l };
      continue;
    }
    const c = pp.c; // 缓存残留双向共享
    const pr = retrievabilityParts(w, tick, now, 'r');
    for (const cand of candidatesOf(w, bookTextFor(db, w) != null)) {
      const parts = cand.dir === 'r' ? pr : pp;
      if (parts.r > CONFIG.RIPE_R) continue; // 闸门一：R = C×L ≤ 阈值（缓存冲刷 × 痕迹尚可）
      if (c > CONFIG.CACHE_COLD) continue; // 闸门二：缓存冷却（≈4–5 个干扰任务或 ≈20 分钟）
      const p = priority(w, cand.dir, parts.l);
      if (p <= 0) continue; // 缺口为 0（该轴已毕业）→ 自然退场
      if (!best || p > best.p || (p === best.p && taskRank(cand.kind) < taskRank(best.cand.kind)))
        best = { w, cand, p };
    }
  }
  if (relearn) return { kind: 'STEP12', word: relearn.w, relearn: true };
  if (best && best.p >= CONFIG.NEW_WORD_BYPASS) return serve(db, best, tick, now);

  // 3. 新词插空引入：复习池空，或最高 P 低于 NEW_WORD_BYPASS（没有紧急复习）。
  // 不设配额或库存上限——引入行为本身制造未来的复习压力，负反馈自我限速。
  const nw = (
    gid == null
      ? db
          .prepare(`SELECT * FROM words WHERE last_ts = 0 ORDER BY freq IS NULL, freq DESC, id LIMIT 1`)
          .get()
      : db
          .prepare(
            `SELECT * FROM words WHERE last_ts = 0 AND goal_id = ? ORDER BY freq IS NULL, freq DESC, id LIMIT 1`
          )
          .get(gid)
  ) as WordRow | undefined;
  if (nw) return { kind: 'STEP12', word: toWord(nw) };
  if (best) return serve(db, best, tick, now); // 无新词可引：低需求复习也胜过空转

  // 4. 彻底没有 → EMPTY：报告最近的成熟时间（所有词所有轴取 min），而不是提前硬刷
  let soonest: number | null = null;
  for (const w of words) {
    if (!inScope(w) || w.graduated || w.last_ts === 0) continue;
    for (const dir of ['p', 'r'] as Direction[]) {
      const lastTs = dir === 'r' ? w.last_ts_r : w.last_ts;
      if (lastTs === 0) continue;
      // 二分求解 R_a(t) = RIPE_R 的时刻（tick 冻结，只有时间通道继续衰减）
      if (retrievabilityParts(w, tick, now, dir).r <= CONFIG.RIPE_R) continue; // 已成熟却在等缓存
      let lo = now;
      let hi = now + 30 * 24 * 3_600_000;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        if (retrievabilityParts(w, tick, mid, dir).r > CONFIG.RIPE_R) lo = mid;
        else hi = mid;
      }
      if (soonest === null || hi < soonest) soonest = hi;
    }
  }
  return { kind: 'EMPTY', nextAvailableInMs: soonest == null ? null : Math.max(0, soonest - now) };
}

// 候选 → 任务：STEP4/STEP4R/MFI 带速度游标预算；MFI 切片失败回退 STEP4R/STEP3
function serve(db: Database.Database, b: { w: Word; cand: Candidate }, tick: number, now: number): Task {
  const { w, cand } = b;
  if (cand.kind === 'STEP4') return { kind: 'STEP4', word: w, timeBudgetMs: step4BudgetMs(db, w) };
  if (cand.kind === 'MFI') {
    const text = bookTextFor(db, w);
    if (text) {
      const words = (db.prepare('SELECT * FROM words').all() as WordRow[]).map(toWord);
      const known = knownTokenSet(db, words);
      const mfi = sliceMfi(text, w.chunk, (t) => known.has(t), tick);
      if (mfi && mfi.options.length === 3 && mfi.answerIndex >= 0) {
        const cursor = getCursor(db, 'reading', CONFIG.V_FLOOR_READING);
        return {
          kind: 'MFI',
          word: w,
          passage: mfi.passage,
          passageWords: mfi.words,
          options: mfi.options,
          answerIndex: mfi.answerIndex,
          timeBudgetMs: Math.round((mfi.words / cursor) * 60_000),
        };
      }
    }
    // 切片失败（覆盖率不足/无命中）：落回 STEP4R，材料太短再落回 STEP3
    if (readable(w)) return { kind: 'STEP4R', word: w, timeBudgetMs: step4rBudgetMs(db, w) };
    return { kind: 'STEP3', word: w, srsReview: bandOf(w) === 'MASTERED' };
  }
  if (cand.kind === 'STEP4R') return { kind: 'STEP4R', word: w, timeBudgetMs: step4rBudgetMs(db, w) };
  return { kind: 'STEP3', word: w, srsReview: bandOf(w) === 'MASTERED' };
}

export interface ResultInput {
  kind: 'STEP12' | 'STEP3' | 'STEP4' | 'STEP4R' | 'MFI' | 'PART_B';
  wordIds: number[];
  pass: boolean;
  srsReview?: boolean;
  missedWordId?: number;
  latencyMs?: number; // 从出题到提交的实测耗时
  wordsProduced?: number; // Step 4 产出的词数（实测写作 wpm）
  wordsRead?: number; // MFI 篇章词数（实测阅读 wpm）
  hint?: boolean; // 看了提示/自我纠正 → 准确性按 0.5 计
}

interface ScoreResult {
  attempt: number;
  fluency: number;
  stabilityTime: number;
  speed: number | null;
  s: number;
}

// 一次计分尝试的流利度更新：F_d ← (1−α)·F_d·R_服务 + α·attempt；该方向稳定性成功 ×2 / 失败 ÷2。
// 只更新被练到的那个方向（dir）——另一方向的 F 与 H 不动（迁移走 transferR，见 applyResult）
function scoreAttempt(
  w: Word,
  opts: { pass: boolean; accuracy: number; speed: number | null; s: number },
  tick: number,
  now: number,
  dir: Direction = 'p'
): ScoreResult {
  const attempt = opts.accuracy * (60 + 40 * opts.s);
  // R_服务 = max(L_a, SCORE_R_FLOOR)：计分问的是「间隔之后长时痕迹还剩多少」——
  // 看 L 不看 C×L：缓存冷是设计服务点而非调度迟到；L 低于 0.8 才是真的排队过久
  const R = Math.max(retrievabilityParts(w, tick, now, dir).l, CONFIG.SCORE_R_FLOOR);
  const f0 = dir === 'r' ? w.fluency_r : w.fluency;
  const h0 = dir === 'r' ? w.stability_time_r : w.stability_time;
  const fluency = (1 - CONFIG.ALPHA) * f0 * R + CONFIG.ALPHA * attempt;
  const stabilityTime = opts.pass ? h0 * 2 : Math.max(h0 / 2, CONFIG.H_TIME_MIN_MS);
  return { attempt, fluency, stabilityTime, speed: opts.speed, s: opts.s };
}

// P 方向更新后 F_R / H_time_R / last_ts_r 的跟随值：
// - 短材料（无阅读构念）：F_R 完整镜像 F_P，单一构念同升同降；
// - 其余且通过：P⊃R 迁移——F_R 托底到「知识确认线」A×60（干净 60 / hint 30）。
//   只托底不拖低，不动 R 方向稳定性与时间锚；60 < INTEGRATE_FLOOR 75：
//   读速必须靠 STEP4R / MFI 实测挣得。失败不迁移（写不出 ≠ 认不出）。
function followR(
  w: Word,
  r: ScoreResult,
  accuracy: number,
  now: number
): { fluencyR: number; stabilityTimeR: number; lastTsR: number } {
  if (!readable(w)) {
    return { fluencyR: r.fluency, stabilityTimeR: r.stabilityTime, lastTsR: now };
  }
  if (accuracy > 0) {
    return {
      fluencyR: Math.max(w.fluency_r, accuracy * 60),
      stabilityTimeR: w.stability_time_r,
      lastTsR: w.last_ts_r,
    };
  }
  return { fluencyR: w.fluency_r, stabilityTimeR: w.stability_time_r, lastTsR: w.last_ts_r };
}

// 毕业判定（RPD「毕业——停止派练习」）：双轴都达成个人终点 且 双向都扛住了长时遗忘。
// 「全速通过」条件被 target 蕴含——F 由含速度分的 attempt 喂大，F ≥ target 本身就意味着速度达标
function graduatedNow(
  w: Word,
  fP: number,
  fR: number,
  hP: number,
  hR: number
): number {
  return fP >= w.target_out &&
    fR >= w.target_in &&
    hP >= CONFIG.H_TIME_GRAD_MS &&
    hR >= CONFIG.H_TIME_GRAD_MS
    ? 1
    : w.graduated;
}

// 打字类任务的速度分：T_target = 350ms × 语块字符数，S = min(1, T_target / T_response)
function typingSpeed(chunk: string, latencyMs: number | undefined, pass: boolean): number {
  if (!latencyMs || latencyMs <= 0) return pass ? 0.5 : 0;
  const tTarget = CONFIG.T_TARGET_PER_CHAR_MS * chunk.length;
  return clamp01(tTarget / latencyMs);
}

// Step 4 写作速度：实测 wpm 在绝对标尺 v_floor → v_ceil（25 → 60）上的位置
function writingSpeed(input: ResultInput): { v: number | null; s: number } {
  if (input.wordsProduced && input.latencyMs && input.latencyMs > 0) {
    const v = input.wordsProduced / (input.latencyMs / 60_000);
    const s = clamp01(
      (v - CONFIG.V_FLOOR_WRITING) / (CONFIG.V_CEIL_WRITING - CONFIG.V_FLOOR_WRITING)
    );
    return { v, s };
  }
  return { v: null, s: input.pass ? 0.5 : 0 };
}

// 阅读速度：wpm = 篇章词数 / 用时（自报读懂才算有效测速），绝对标尺 150 → 300。
// 游标朝目标画像的 reading_wpm 棘轮（压力），实测的 v 在绝对标尺上计分（尺子）。
function readingSpeed(wordCount: number, latencyMs: number | undefined, pass: boolean): { v: number | null; s: number } {
  if (latencyMs && latencyMs > 0) {
    const v = wordCount / (latencyMs / 60_000);
    const s = clamp01((v - CONFIG.V_FLOOR_READING) / (CONFIG.V_CEIL_READING - CONFIG.V_FLOOR_READING));
    return { v, s };
  }
  return { v: null, s: pass ? 0.5 : 0 };
}

export interface CheckpointWriteback {
  passed: boolean;
  qualified: boolean;
  checkpoint: number | null;
  updatedWordIds: number[];
}

/**
 * Persist a result against the server-issued task instance. The checkpoint is read
 * only from that instance; client evidence can prove or fail it, but cannot choose it.
 */
export function applyTaskResult(
  db: Database.Database,
  instance: TaskInstance,
  evidence: TaskEvidence,
  now = Date.now()
): CheckpointWriteback {
  const run = db.transaction((): CheckpointWriteback => {
    const tick = getTick(db);
    const nextTick = tick + 1;
    const axis = instance.axis;
    const scoreColumn = axis === 'r' ? 'fluency_r' : 'fluency';
    const verifiedColumn = axis === 'r' ? 'verified_r' : 'verified_p';
    const speedColumn = axis === 'r' ? 'speed_verified_r' : 'speed_verified_p';
    const stabilityColumn = axis === 'r' ? 'stability_time_r' : 'stability_time';
    const timestampColumn = axis === 'r' ? 'last_ts_r' : 'last_ts';
    const integrationColumn = axis === 'r' ? 'integrated_r' : 'integrated_p';
    const checkpoint = instance.checkpoint;
    const definition = TASK_LIBRARY.find((item) => item.id === instance.definition_id);
    const checkpointRange = definition?.checkpoint_range;
    const definitionValid = definition != null &&
      definition.type === instance.type &&
      definition.supported_axes.includes(axis) &&
      definition.supported_purposes.includes(instance.purpose) &&
      (checkpoint == null
        ? definition.checkpoint_range == null
        : checkpointRange != null && checkpoint >= checkpointRange.min && checkpoint <= checkpointRange.max);
    const wordResults = new Map(evidence.word_results.map((result) => [result.word_id, result.correct]));
    const allWordsAnswered = instance.word_ids.length > 0 && instance.word_ids.every((id) => wordResults.has(id));
    const allWordsCorrect = allWordsAnswered && instance.word_ids.every((id) => wordResults.get(id) === true);
    const checkEntries = Object.entries(evidence.accuracy);
    const checksPresent = checkEntries.length > 0 &&
      checkEntries.every(([, pass]) => pass === true) &&
      (definition?.evidence.accuracy_check.every((key) => evidence.accuracy[key] === true) ?? false);
    const targetWordPassed = evidence.accuracy.target_word === true;
    const independent = evidence.independent && !evidence.answer_revealed && !evidence.hint_used;
    const speedRequired = checkpoint != null && checkpoint >= 60;
    const expectedSpeedMode = axis === 'r' ? 'reading_wpm' : 'writing_wpm';
    const speedEvidenceRequired = speedRequired || definition?.type === 'FLUENCY';
    const speedAtCheckpoint = speedRequired
      ? axis === 'r'
        ? 150 + ((checkpoint! - 60) * 150) / 40
        : 25 + ((checkpoint! - 60) * 35) / 40
      : null;
    const speedPassed = !speedEvidenceRequired || (
      evidence.speed_mode === expectedSpeedMode &&
      evidence.speed_value != null &&
      Number.isFinite(evidence.speed_value) &&
      (!speedRequired || evidence.speed_value >= speedAtCheckpoint!)
    );
    const overallCheckPassed = !speedRequired || (
      axis === 'r'
        ? evidence.accuracy.passage_comprehension === true
        : evidence.accuracy.expression === true
    );
    const attemptedIndependently = independent && instance.type !== 'ENCODE';
    const qualified = definitionValid && checkpoint != null &&
      instance.type !== 'ENCODE' &&
      instance.type !== 'INTEGRATE' &&
      independent &&
      targetWordPassed &&
      checksPresent &&
      allWordsCorrect &&
      speedPassed &&
      overallCheckPassed;
    const taskPassed = instance.type === 'INTEGRATE'
      ? definitionValid && independent && checksPresent && allWordsCorrect
      : qualified;
    const recheck = checkpoint != null && instance.word_ids.some((id) => {
      const row = db.prepare(`SELECT ${scoreColumn} AS score FROM words WHERE id = ?`).get(id) as
        | { score: number }
        | undefined;
      return row != null && row.score > 0 && checkpoint <= row.score;
    });
    const updatedWordIds: number[] = [];

    for (const id of instance.word_ids) {
      const row = db.prepare('SELECT * FROM words WHERE id = ?').get(id) as WordRow | undefined;
      if (!row) continue;
      const word = toWord(row);
      const isTeaching = instance.type === 'ENCODE' ||
        instance.purpose === 'introduce' || instance.purpose === 'relearn';

      if (isTeaching) {
        const pendingColumn = axis === 'r' ? 'pending_relearn_r' : 'pending_relearn_p';
        const relearnCertification = instance.purpose === 'relearn'
          ? `, ${verifiedColumn} = 0, ${speedColumn} = 0`
          : '';
        db.prepare(
          `UPDATE words SET introduced = 1, ${timestampColumn} = ?, last_tick = ?, ${pendingColumn} = 0${relearnCertification}, updated_at = ? WHERE id = ?`
        ).run(now, nextTick, now, id);
      } else if (instance.type === 'INTEGRATE') {
        if (taskPassed) {
          db.prepare(
            `UPDATE words SET ${integrationColumn} = 1, last_tick = ?, ${timestampColumn} = ?, updated_at = ? WHERE id = ?`
          ).run(nextTick, now, now, id);
        } else if (attemptedIndependently) {
          db.prepare(
            `UPDATE words SET last_tick = ?, ${timestampColumn} = ?, updated_at = ? WHERE id = ?`
          ).run(nextTick, now, now, id);
        }
      } else if (qualified) {
        const oldScore = axis === 'r' ? word.fluency_r : word.fluency;
        const oldVerified = axis === 'r' ? word.verified_r : word.verified_p;
        const oldSpeedVerified = axis === 'r' ? word.speed_verified_r : word.speed_verified_p;
        const oldStability = axis === 'r' ? word.stability_time_r : word.stability_time;
        const raisesOrReconfirms = checkpoint! >= oldScore;
        const score = Math.max(oldScore, checkpoint!);
        const verified = raisesOrReconfirms ? 1 : oldVerified;
        const speedVerified = raisesOrReconfirms && speedRequired ? 1 : oldSpeedVerified;
        const stability = oldStability * 2;
        const nextFp = axis === 'p' ? score : word.fluency;
        const nextFr = axis === 'r' ? score : word.fluency_r;
        const graduated =
          nextFp >= word.target_out &&
          nextFr >= word.target_in &&
          (axis === 'p' ? verified : word.verified_p) === 1 &&
          (axis === 'r' ? verified : word.verified_r) === 1 &&
          (axis === 'p' ? speedVerified : word.speed_verified_p) === 1 &&
          (axis === 'r' ? speedVerified : word.speed_verified_r) === 1 &&
          (axis === 'p' ? stability : word.stability_time) >= CONFIG.H_TIME_GRAD_MS &&
          (axis === 'r' ? stability : word.stability_time_r) >= CONFIG.H_TIME_GRAD_MS;
        db.prepare(
          `UPDATE words SET ${scoreColumn} = ?, ${verifiedColumn} = ?, ${speedColumn} = ?, ${stabilityColumn} = ?, introduced = 1, has_observation_${axis} = 1, ${timestampColumn} = ?, last_tick = ?, graduated = ?, updated_at = ? WHERE id = ?`
        ).run(score, verified, speedVerified, stability, now, nextTick, graduated ? 1 : word.graduated, now, id);

      } else if (attemptedIndependently) {
        const oldStability = axis === 'r' ? word.stability_time_r : word.stability_time;
        const pendingColumn = axis === 'r' ? 'pending_relearn_r' : 'pending_relearn_p';
        const targetWordFailed = evidence.accuracy.target_word !== true;
        db.prepare(
          `UPDATE words SET ${verifiedColumn} = 0, ${speedColumn} = 0, ${stabilityColumn} = ?, ${pendingColumn} = CASE WHEN ? = 1 THEN 1 ELSE ${pendingColumn} END, introduced = 1, has_observation_${axis} = 1, ${timestampColumn} = ?, last_tick = ?, updated_at = ? WHERE id = ?`
        ).run(Math.max(oldStability / 2, CONFIG.H_TIME_MIN_MS), targetWordFailed ? 1 : 0, now, nextTick, now, id);
      } else {
        // A guided attempt can refresh practice timing, but it cannot alter scores or certification.
        db.prepare(
          `UPDATE words SET introduced = 1, ${timestampColumn} = ?, last_tick = ?, updated_at = ? WHERE id = ?`
        ).run(now, nextTick, now, id);
      }
      updatedWordIds.push(id);
    }

    // A valid continuous measurement adjusts only its own axis cursor, once per task.
    const measuredInExpectedMode = evidence.speed_mode === expectedSpeedMode &&
      evidence.speed_value != null && Number.isFinite(evidence.speed_value);
    if (attemptedIndependently && speedRequired && measuredInExpectedMode && instance.word_ids.length > 0) {
      const first = db.prepare('SELECT goal_id FROM words WHERE id = ?').get(instance.word_ids[0]) as
        | { goal_id: number | null }
        | undefined;
      const modality = axis === 'r' ? 'reading' : 'writing';
      const floor = axis === 'r' ? CONFIG.V_FLOOR_READING : CONFIG.V_FLOOR_WRITING;
      const cursor = getCursor(db, modality, floor);
      const cap = goalSpeed(db, first?.goal_id ?? null, axis === 'r' ? 'reading_wpm' : 'writing_wpm', floor);
      setCursor(
        db,
        modality,
        taskPassed ? Math.min(cap, cursor * CONFIG.CURSOR_UP) : Math.max(floor, cursor * CONFIG.CURSOR_DOWN)
      );
    }

    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('global_tick', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(String(nextTick));
    db.prepare(
      `INSERT INTO events (tick, ts, kind, word_id, result, detail) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      nextTick,
      now,
      `${instance.type}:${instance.purpose}:${axis}`,
      instance.word_ids[0] ?? null,
      taskPassed ? 'pass' : attemptedIndependently ? 'fail' : 'practice',
      JSON.stringify({
        instance_id: instance.instance_id,
        definition_id: instance.definition_id,
        checkpoint,
        recheck,
        qualified,
        independent,
        accuracy: evidence.accuracy,
        speed_mode: evidence.speed_mode,
        speed_value: evidence.speed_value,
        duration_ms: evidence.duration_ms,
        word_results: evidence.word_results,
      })
    );
    return { passed: taskPassed, qualified, checkpoint, updatedWordIds };
  });
  return run();
}

export function applyResult(db: Database.Database, input: ResultInput, now = Date.now()): void {
  const tick = getTick(db);
  const next = tick + 1;
  const getWord = (id: number) => toWord(db.prepare('SELECT * FROM words WHERE id = ?').get(id) as WordRow);
  const details: Record<number, unknown> = {};

  if (input.kind === 'STEP12') {
    const w = getWord(input.wordIds[0]);
    // 形态检查即种子：双轴同时播种（见过拼写 ≠ 验证过再认），三个半衰期一并初始化。
    // relearn（严重逾期路由）走同一分支：承认它已死、重新来过
    const fP = input.pass && !input.hint ? CONFIG.SEED_F_P : CONFIG.SEED_F_R;
    db.prepare(
      `UPDATE words SET fluency = ?, fluency_r = ?, stability_tick = ?, stability_time = ?, stability_time_r = ?,
         last_tick = ?, last_ts = ?, last_ts_r = ?, updated_at = ? WHERE id = ?`
    ).run(
      fP,
      CONFIG.SEED_F_R,
      CONFIG.H_TICK_SEED,
      CONFIG.H_TIME_SEED_MS,
      CONFIG.H_TIME_SEED_MS,
      next,
      now,
      now,
      now,
      w.id
    );
    details[w.id] = { latencyMs: input.latencyMs, seeded: true, ...(input.hint ? { hint: true } : {}) };
  }

  if (input.kind === 'STEP3') {
    const w = getWord(input.wordIds[0]);
    const accuracy = input.pass ? (input.hint ? 0.5 : 1) : 0;
    const s = typingSpeed(w.chunk, input.latencyMs, input.pass);
    const r = scoreAttempt(w, { pass: input.pass, accuracy, speed: null, s }, tick, now);
    const follow = followR(w, r, accuracy, now);
    const graduated = graduatedNow(w, r.fluency, follow.fluencyR, r.stabilityTime, follow.stabilityTimeR);
    db.prepare(
      `UPDATE words SET fluency = ?, fluency_r = ?, stability_time = ?, stability_time_r = ?,
         last_tick = ?, last_ts = ?, last_ts_r = ?, graduated = ?, updated_at = ? WHERE id = ?`
    ).run(
      r.fluency,
      follow.fluencyR,
      r.stabilityTime,
      follow.stabilityTimeR,
      next,
      now,
      follow.lastTsR,
      graduated,
      now,
      w.id
    );
    details[w.id] = {
      latencyMs: input.latencyMs,
      A: accuracy,
      S: Number(s.toFixed(2)),
      attempt: Math.round(r.attempt),
      F: Number(r.fluency.toFixed(1)),
      F_r: Number(follow.fluencyR.toFixed(1)),
      H_time_h: Number((r.stabilityTime / 3_600_000).toFixed(1)),
      H_time_r_h: Number((follow.stabilityTimeR / 3_600_000).toFixed(1)),
      ...(graduated && !w.graduated ? { graduated: true } : {}),
    };
  }

  if (input.kind === 'STEP4') {
    const w = getWord(input.wordIds[0]);
    const accuracy = input.pass ? (input.hint ? 0.5 : 1) : 0;
    const { v, s } = writingSpeed(input);
    const r = scoreAttempt(w, { pass: input.pass, accuracy, speed: v, s }, tick, now);
    const follow = followR(w, r, accuracy, now);
    const graduated = graduatedNow(w, r.fluency, follow.fluencyR, r.stabilityTime, follow.stabilityTimeR);
    db.prepare(
      `UPDATE words SET fluency = ?, fluency_r = ?, stability_time = ?, stability_time_r = ?,
         last_tick = ?, last_ts = ?, last_ts_r = ?, graduated = ?, updated_at = ? WHERE id = ?`
    ).run(
      r.fluency,
      follow.fluencyR,
      r.stabilityTime,
      follow.stabilityTimeR,
      next,
      now,
      follow.lastTsR,
      graduated,
      now,
      w.id
    );
    // 游标棘轮：预算内干净通过 → 加压 5%（封顶目标画像的 writing_wpm）；准确性失败 → 泄压 10%
    const vCap = goalSpeed(db, w.goal_id, 'writing_wpm', CONFIG.V_FLOOR_WRITING);
    const cursor = getCursor(db, 'writing', CONFIG.V_FLOOR_WRITING);
    const budget = step4BudgetMs(db, w);
    if (input.pass && !input.hint && input.latencyMs != null && input.latencyMs <= budget) {
      setCursor(db, 'writing', Math.min(vCap, cursor * CONFIG.CURSOR_UP));
    } else if (!input.pass) {
      setCursor(db, 'writing', Math.max(CONFIG.V_FLOOR_WRITING, cursor * CONFIG.CURSOR_DOWN));
    }
    details[w.id] = {
      latencyMs: input.latencyMs,
      words: input.wordsProduced,
      wpm: v == null ? null : Number(v.toFixed(1)),
      A: accuracy,
      S: Number(s.toFixed(2)),
      attempt: Math.round(r.attempt),
      F: Number(r.fluency.toFixed(1)),
      F_r: Number(follow.fluencyR.toFixed(1)),
      H_time_h: Number((r.stabilityTime / 3_600_000).toFixed(1)),
      H_time_r_h: Number((follow.stabilityTimeR / 3_600_000).toFixed(1)),
      cursor_wpm: Number(getCursor(db, 'writing', CONFIG.V_FLOOR_WRITING).toFixed(1)),
      ...(graduated && !w.graduated ? { graduated: true } : {}),
    };
  }

  // Step 4R 与 MFI 共用 R 轴结算：只写 _r 列，不反向迁移到 P
  if (input.kind === 'STEP4R' || input.kind === 'MFI') {
    const w = getWord(input.wordIds[0]);
    const accuracy = input.pass ? (input.hint ? 0.5 : 1) : 0;
    const wordCount =
      input.kind === 'MFI' ? (input.wordsRead ?? 0) : materialWords(w);
    const { v, s } = readingSpeed(wordCount, input.latencyMs, input.pass);
    const r = scoreAttempt(w, { pass: input.pass, accuracy, speed: v, s }, tick, now, 'r');
    const graduated = graduatedNow(w, w.fluency, r.fluency, w.stability_time, r.stabilityTime);
    db.prepare(
      `UPDATE words SET fluency_r = ?, stability_time_r = ?, last_tick = ?, last_ts_r = ?, graduated = ?, updated_at = ? WHERE id = ?`
    ).run(r.fluency, r.stabilityTime, next, now, graduated, now, w.id);
    // 阅读游标棘轮：预算内读懂 → 加压 5%（封顶目标画像的 reading_wpm）；没读懂 → 泄压 10%
    const vCap = goalSpeed(db, w.goal_id, 'reading_wpm', 200);
    const cursor = getCursor(db, 'reading', CONFIG.V_FLOOR_READING);
    const budgetMs = Math.round((wordCount / cursor) * 60_000);
    if (input.pass && !input.hint && input.latencyMs != null && input.latencyMs <= budgetMs) {
      setCursor(db, 'reading', Math.min(vCap, cursor * CONFIG.CURSOR_UP));
    } else if (!input.pass) {
      setCursor(db, 'reading', Math.max(CONFIG.V_FLOOR_READING, cursor * CONFIG.CURSOR_DOWN));
    }
    details[w.id] = {
      latencyMs: input.latencyMs,
      words: wordCount,
      wpm: v == null ? null : Number(v.toFixed(1)),
      A: accuracy,
      S: Number(s.toFixed(2)),
      attempt: Math.round(r.attempt),
      F_r: Number(r.fluency.toFixed(1)),
      H_time_r_h: Number((r.stabilityTime / 3_600_000).toFixed(1)),
      cursor_reading_wpm: Number(getCursor(db, 'reading', CONFIG.V_FLOOR_READING).toFixed(1)),
      ...(graduated && !w.graduated ? { graduated: true } : {}),
    };
  }

  if (input.kind === 'PART_B') {
    if (input.pass) {
      // 集成认证（P 方向）：F_P 保底 80，H_time_P 跳上 1d 档。
      // 短材料词无独立阅读构念，F_R / H_time_R 一并镜像；长材料词的 F_R 本就 ≥75（双门槛），不动。
      const stmt = db.prepare(
        `UPDATE words SET fluency = MAX(fluency, 80), integrated = 1,
           stability_time = MAX(stability_time, ?), last_tick = ?, last_ts = ?, updated_at = ?
         WHERE id = ?`
      );
      const mirror = db.prepare(
        `UPDATE words SET fluency_r = MAX(fluency_r, 80),
           stability_time_r = MAX(stability_time_r, ?), last_ts_r = ? WHERE id = ?`
      );
      for (const id of input.wordIds) {
        stmt.run(CONFIG.H_TIME_PART_B_MS, next, now, now, id);
        const w = getWord(id);
        if (!readable(w)) mirror.run(CONFIG.H_TIME_PART_B_MS, now, id);
        details[id] = { integrated: true };
      }
    } else if (input.missedWordId != null) {
      // 漏掉的词 attempt=0：F_P 被拖低、H_time_P 减半，自动跌回低优先级重学，无需降级规则
      const w = getWord(input.missedWordId);
      const r = scoreAttempt(w, { pass: false, accuracy: 0, speed: null, s: 0 }, tick, now);
      const follow = followR(w, r, 0, now); // 短材料镜像回落；长材料失败不迁移
      db.prepare(
        `UPDATE words SET fluency = ?, fluency_r = ?, stability_time = ?, stability_time_r = ?,
           last_tick = ?, last_ts = ?, last_ts_r = ?, updated_at = ? WHERE id = ?`
      ).run(
        r.fluency,
        follow.fluencyR,
        r.stabilityTime,
        follow.stabilityTimeR,
        next,
        now,
        follow.lastTsR,
        now,
        w.id
      );
      details[w.id] = { missed: true, F: Number(r.fluency.toFixed(1)), F_r: Number(follow.fluencyR.toFixed(1)) };
    }
  }

  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('global_tick', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(String(next));
  db.prepare(
    `INSERT INTO events (tick, ts, kind, word_id, result, detail) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    next,
    now,
    input.kind,
    input.wordIds[0] ?? null,
    input.pass ? 'pass' : 'fail',
    Object.keys(details).length > 0
      ? JSON.stringify(
          input.kind === 'PART_B'
            ? { batch: input.wordIds, ...details }
            : details[input.wordIds[0]]
        )
      : null
  );
}

// 系统没有「会话」概念：tick 永久单调不归零，缓存冷却靠干扰∥时间双通道，
// 隔夜只是 Δt 很大的普通情形。分析层若需练习段落统计，从 events 时间戳间隔事后切分。

export function snapshot(db: Database.Database, now = Date.now()) {
  const tick = getTick(db);
  const vocabRow = db
    .prepare(`SELECT value FROM meta WHERE key = 'vocab_estimate'`)
    .get() as { value: string } | undefined;
  const vocabEstimate = vocabRow ? Number(vocabRow.value) : null;
  const activeGoalId = getActiveGoalId(db);
  const words = (db.prepare('SELECT * FROM words ORDER BY id').all() as WordRow[]).map(toWord);

  // 目标流利度 = 词频加权的 min(F_R, F_P) 均值（headline）；另报 R/P 拆分作仪表盘展示指标
  const pool = words.filter((w) => activeGoalId == null || w.goal_id === activeGoalId);
  let sw = 0;
  let swf = 0;
  let swr = 0;
  let swp = 0;
  for (const w of pool) {
    const weight = wFreq(w);
    sw += weight;
    swf += weight * Math.min(w.fluency, w.fluency_r);
    swr += weight * w.fluency_r;
    swp += weight * w.fluency;
  }
  const goalFluency = sw > 0 ? swf / sw : null;
  const goalFluencyR = sw > 0 ? swr / sw : null;
  const goalFluencyP = sw > 0 ? swp / sw : null;

  // 目标达成度 = 双轴均达个人目标的 KP 的词频加权占比
  let swHit = 0;
  for (const w of pool) {
    if (w.fluency >= w.target_out && w.fluency_r >= w.target_in) swHit += wFreq(w);
  }
  const goalAttainment = sw > 0 ? swHit / sw : null;

  // 用户水平 = 词汇量估计（广度）× 已学词平均 min 流利度（深度）→ CEFR/IELTS 档
  const attempted = words.filter((w) => w.last_ts > 0);
  const meanFluency =
    attempted.length > 0
      ? attempted.reduce((s, w) => s + Math.min(w.fluency, w.fluency_r), 0) / attempted.length
      : null;
  const userLevel =
    vocabEstimate != null && meanFluency != null
      ? { estimate: Math.round(vocabEstimate * (meanFluency / 100)), ...levelOf(Math.round(vocabEstimate * (meanFluency / 100))) }
      : null;

  return {
    tick,
    words: words.map((w) => ({
      ...w,
      band: bandOf(w),
      r: Number(retrievabilityParts(w, tick, now, 'p').r.toFixed(3)),
      r_r: Number(retrievabilityParts(w, tick, now, 'r').r.toFixed(3)),
      c: Number(cacheResidue(w, tick, now).toFixed(3)),
    })),
    events: db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 12').all(),
    vocabEstimate,
    activeGoalId,
    goalScopeStrict: getGoalScopeStrict(db),
    goalFluency: goalFluency == null ? null : Number(goalFluency.toFixed(1)),
    goalFluencyR: goalFluencyR == null ? null : Number(goalFluencyR.toFixed(1)),
    goalFluencyP: goalFluencyP == null ? null : Number(goalFluencyP.toFixed(1)),
    goalAttainment: goalAttainment == null ? null : Number(goalAttainment.toFixed(3)),
    userLevel,
    cursorWritingWpm: Number(getCursor(db, 'writing', CONFIG.V_FLOOR_WRITING).toFixed(1)),
    cursorReadingWpm: Number(getCursor(db, 'reading', CONFIG.V_FLOOR_READING).toFixed(1)),
  };
}
