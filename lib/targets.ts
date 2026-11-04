import type Database from 'better-sqlite3';
import { CONFIG } from './config';

// 目标画像（goals.target JSON）：用可测量的术语声明终态（RPD「目标锚定的流利度」）
export interface TargetProfile {
  vocab_size?: number; // 决定哪些 KP 进入队列（IELTS 目标）
  reading_wpm?: number; // 阅读目标速度 → target_in 与阅读游标封顶
  writing_wpm?: number; // 写作目标速度 → target_out 与写作游标封顶
  source_id?: number; // 书源（MFI 篇章材料的来源；无则 MFI 不可派）
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

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

// 词频调制 ∈ [1, 1+FREQ_FACTOR_MAX]，只向上：高频词在阅读中密度高、对速度拖累大，
// 目标只被往上推；无词频信息（freq = NULL）取 1.0，流利下限不被任何因素稀释
export function freqFactor(freq: number | null): number {
  if (freq == null || freq <= 0) return 1;
  const t = Math.min(1, Math.log(1 + freq) / Math.log(1 + CONFIG.FREQ_REF));
  return 1 + CONFIG.FREQ_FACTOR_MAX * t;
}

// 目标速度 → 每词个人终点：速度在绝对标尺上的位置映射到 80–95，再按词频向上调制
export function targetsFor(
  profile: TargetProfile,
  freq: number | null
): { targetIn: number; targetOut: number } {
  const readPos = clamp01(
    ((profile.reading_wpm ?? CONFIG.V_FLOOR_READING) - CONFIG.V_FLOOR_READING) /
      (CONFIG.V_CEIL_READING - CONFIG.V_FLOOR_READING)
  );
  const writePos = clamp01(
    ((profile.writing_wpm ?? CONFIG.V_FLOOR_WRITING) - CONFIG.V_FLOOR_WRITING) /
      (CONFIG.V_CEIL_WRITING - CONFIG.V_FLOOR_WRITING)
  );
  const f = freqFactor(freq);
  return {
    targetIn: Math.min(100, (CONFIG.TARGET_BASE + CONFIG.TARGET_SPAN * readPos) * f),
    targetOut: Math.min(100, (CONFIG.TARGET_BASE + CONFIG.TARGET_SPAN * writePos) * f),
  };
}

// 入库物化：目标速度修改时对该目标下所有词批量重算
export function materializeTargets(db: Database.Database, goalId: number): void {
  const profile = getProfile(db, goalId);
  const rows = db.prepare(`SELECT id, freq FROM words WHERE goal_id = ?`).all(goalId) as {
    id: number;
    freq: number | null;
  }[];
  const stmt = db.prepare(`UPDATE words SET target_in = ?, target_out = ? WHERE id = ?`);
  for (const r of rows) {
    const t = targetsFor(profile, r.freq);
    stmt.run(t.targetIn, t.targetOut, r.id);
  }
}
