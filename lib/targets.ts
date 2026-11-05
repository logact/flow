import type Database from 'better-sqlite3';
// 目标画像（goals.target JSON）：用可测量的术语声明终态（RPD「目标锚定的流利度」）
export interface TargetProfile {
  vocab_size?: number; // 决定哪些 KP 进入队列（IELTS 目标）
  reading_wpm?: number; // 阅读目标速度 → target_in 与阅读游标封顶
  writing_wpm?: number; // 写作目标速度 → target_out 与写作游标封顶
  source_id?: number; // 书源（MFI 篇章材料的来源；无则 MFI 不可派）
}

const SCORE_BASE = 60;
const SCORE_SPAN = 40;

const assertSpeedRange = (
  key: 'reading_wpm' | 'writing_wpm',
  value: number | undefined,
  min: number,
  max: number
) => {
  if (value == null) return;
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new RangeError(`${key} must be between ${min} and ${max} wpm`);
  }
};

export function parseProfile(json: string | null | undefined): TargetProfile {
  if (!json) return {};
  try {
    const p: unknown = JSON.parse(json);
    return p && typeof p === 'object' ? (p as TargetProfile) : {};
  } catch {
    return {};
  }
}

export function getProfile(db: Database.Database, goalId: number | null): TargetProfile {
  if (goalId == null) return {};
  const row = db.prepare(`SELECT target FROM goals WHERE id = ?`).get(goalId) as
    | { target: string | null }
    | undefined;
  return parseProfile(row?.target);
}

// 目标速度 → 每词个人终点：速度位置线性映射到 60–100。词频不改变个人目标。
export function targetsFor(profile: TargetProfile): { targetIn: number; targetOut: number } {
  assertSpeedRange('reading_wpm', profile.reading_wpm, 150, 300);
  assertSpeedRange('writing_wpm', profile.writing_wpm, 25, 60);
  const readPos = ((profile.reading_wpm ?? 150) - 150) / (300 - 150);
  const writePos = ((profile.writing_wpm ?? 25) - 25) / (60 - 25);
  return {
    targetIn: SCORE_BASE + SCORE_SPAN * readPos,
    targetOut: SCORE_BASE + SCORE_SPAN * writePos,
  };
}

/** Import prior used only to choose the first route; it must never become an axis score. */
export function priorMasteryProbability(vocabEstimate: number | null, rank: number | null): number | null {
  if (
    vocabEstimate == null || !Number.isFinite(vocabEstimate) || vocabEstimate <= 0 ||
    rank == null || !Number.isFinite(rank) || rank <= 0
  ) return null;
  const z = (Math.log(vocabEstimate) - Math.log(rank)) / 0.7;
  return 1 / (1 + Math.exp(-z));
}

// 入库物化：目标速度修改时对该目标下所有词批量重算
export function materializeTargets(db: Database.Database, goalId: number): void {
  const profile = getProfile(db, goalId);
  const rows = db.prepare(`SELECT id FROM words WHERE goal_id = ?`).all(goalId) as { id: number }[];
  const stmt = db.prepare(`UPDATE words SET target_in = ?, target_out = ? WHERE id = ?`);
  for (const r of rows) {
    const t = targetsFor(profile);
    stmt.run(t.targetIn, t.targetOut, r.id);
  }
}
