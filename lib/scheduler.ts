import type Database from 'better-sqlite3';
import { CONFIG } from './config';
import { bandOf, cacheResidue, retrievabilityParts, toWord, type Word, type WordRow } from './db';
import { levelOf } from './assessment';
import { getProfile } from './targets';
import { candidatesOf, materialWords, readable, taskRank, type Candidate } from './tasks';
import { sliceMfi } from './mfi';
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
  let gap = Math.max(0, target - F) / target;
  if (gap <= 0) {
    if (h >= CONFIG.H_TIME_GRAD_MS) return 0;
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
      if (mfi) {
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
