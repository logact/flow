import Database from 'better-sqlite3';
import path from 'path';
import { CONFIG } from './config';
import { seed } from './seed';
import { parseProfile, targetsFor } from './targets';

// 派生段位：由 min(F_R, F_P) / integrated / graduated 现算，仅作展示，不参与派发
// （题型由任务库的资格谓词直接决定，见 RPD「派生段位」）
export type WordBand =
  | 'NEW' // 从未尝试
  | 'LEARNING' // min F < 50，再认级
  | 'CONSOLIDATING' // 50 ≤ min F < 75，费力但可靠
  | 'INTEGRABLE' // min F ≥ 75 未集成，Part B 候选池
  | 'MASTERED' // min F ≥ 80 已集成
  | 'GRADUATED'; // 双轴均达个人目标且双向 H_time ≥ 30d，永久出队

export interface WordRow {
  id: number;
  chunk: string;
  meaning: string;
  scene: string;
  slots: string;
  substitute: string;
  step3_sentence: string;
  step4_sentences: string; // JSON string[]
  fluency: number; // F_P：产出（写作）方向流利度 0-100
  fluency_r: number; // F_R：接受（阅读）方向流利度 0-100；headline F = min(F_R, F_P)
  prior_mastery_q: number | null; // 导入先验，只用于首次路由，不是成绩
  introduced: number; // 是否已经实际接触或尝试
  has_observation_p: number; // P 轴是否有可归属的真实作答
  has_observation_r: number; // R 轴是否有可归属的真实作答
  verified_p: number; // P 轴当前最高已通过关卡是否有效
  verified_r: number; // R 轴当前最高已通过关卡是否有效
  speed_verified_p: number; // P 轴当前成绩是否有有效连续写作测速
  speed_verified_r: number; // R 轴当前成绩是否有有效连续阅读测速
  integrated_p: number; // P 轴综合运用验证
  integrated_r: number; // R 轴综合运用验证
  pending_relearn_p: number; // P 轴是否待重学
  pending_relearn_r: number; // R 轴是否待重学
  legacy_score_p: number | null; // 仅供兼容展示/诊断的旧 P 分数
  legacy_score_r: number | null; // 仅供兼容展示/诊断的旧 R 分数
  target_in: number; // 阅读方向个人终点（入库时由目标画像推导并物化）
  target_out: number; // 产出方向个人终点
  stability_tick: number; // H_tick：tick 钟半衰期（任务数），双向共享——短时缓存是形式级的
  stability_time: number; // H_time_P：产出方向时间钟半衰期（毫秒）
  stability_time_r: number; // H_time_R：接受方向时间钟半衰期（毫秒）
  last_tick: number; // 末次尝试（任意方向）时的 tick
  last_ts: number; // 末次 P 方向尝试时间戳，0 = 从未尝试
  last_ts_r: number; // 末次 R 方向尝试时间戳，0 = 从未实测
  integrated: number; // Part B 通关标记
  graduated: number; // 毕业标记（永久出队）
  profile: number; // Nation 方面清单位掩码（占位，逐方面核验用）
  goal_id: number | null;
  freq: number | null; // 来源语料中的词频（书源=书中出现次数），NULL 表示无词频信息
  freq_source: string | null; // 词频来源标识，区分通用词频与书内词频
  updated_at: number;
}

export interface Word extends Omit<WordRow, 'step4_sentences'> {
  step4_sentences: string[];
}

export function toWord(row: WordRow): Word {
  return { ...row, step4_sentences: JSON.parse(row.step4_sentences) };
}

export function bandOf(
  w: Pick<WordRow, 'fluency' | 'fluency_r' | 'integrated' | 'graduated' | 'last_ts'>
): WordBand {
  if (w.graduated) return 'GRADUATED';
  if (w.last_ts === 0) return 'NEW';
  const f = Math.min(w.fluency, w.fluency_r); // headline F：词的流利度由较弱的方向决定
  if (f >= 80 && w.integrated) return 'MASTERED';
  if (f >= 75) return 'INTEGRABLE';
  if (f >= 50) return 'CONSOLIDATING';
  return 'LEARNING';
}

// 短时缓存残留（双通道并联，双向共享）：干扰任务能冲掉它（tick 通道），
// 纯粹流逝的时间也能冲掉它（时间通道，H_cache ≈ 20min）——min 取谁冲得狠算谁。
// 练完三小时再回来，即使中间一个任务都没做，热缓存也早已散尽。
export function cacheResidue(
  w: Pick<WordRow, 'stability_tick' | 'last_tick' | 'last_ts' | 'last_ts_r'>,
  tick: number,
  now: number
): number {
  const lastAny = Math.max(w.last_ts, w.last_ts_r);
  if (lastAny === 0) return 0;
  const dTick = Math.max(0, tick - w.last_tick);
  const dTime = Math.max(0, now - lastAny);
  return Math.min(2 ** (-dTick / w.stability_tick), 2 ** (-dTime / CONFIG.H_CACHE_MS));
}

// 语块在当前时刻的可提取度：R_a = C × L_a。
// C 共享（短时缓存是形式级的，任一方向的练习都会刷新它）；
// L_a 按方向独立（再认与产出是两条独立的记忆痕迹，各自遗忘）。
// 注意分工：R_a 只回答「现在值不值得服务」（成熟闸门 + 计分折损）——缓存被干扰任务
// 冲刷后 R 即掉落，新词几个任务后就能回头练；而「是否已死」（RELEARN 路由）与
// 「逾期多久」（urgency）必须看 L_a——隔夜 C≈0 是缓存散尽而非遗忘，拿 R_a 判死会把
// 全词库误判进重编码。
export function retrievabilityParts(
  w: Pick<
    WordRow,
    'stability_tick' | 'stability_time' | 'stability_time_r' | 'last_tick' | 'last_ts' | 'last_ts_r'
  >,
  tick: number,
  now: number,
  dir: 'p' | 'r' = 'p'
): { c: number; l: number; r: number } {
  const lastTs = dir === 'r' ? w.last_ts_r : w.last_ts;
  if (lastTs === 0) return { c: 0, l: 0, r: 0 };
  const hTime = dir === 'r' ? w.stability_time_r : w.stability_time;
  const c = cacheResidue(w, tick, now);
  const l = 2 ** (-Math.max(0, now - lastTs) / hTime);
  return { c, l, r: c * l };
}

export function retrievability(
  w: Pick<
    WordRow,
    'stability_tick' | 'stability_time' | 'stability_time_r' | 'last_tick' | 'last_ts' | 'last_ts_r'
  >,
  tick: number,
  now: number,
  dir: 'p' | 'r' = 'p'
): number {
  return retrievabilityParts(w, tick, now, dir).r;
}

const globalForDb = globalThis as unknown as { __flowDb?: Database.Database };

function init(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk TEXT NOT NULL,
      meaning TEXT NOT NULL,
      scene TEXT NOT NULL,
      slots TEXT NOT NULL,
      substitute TEXT NOT NULL,
      step3_sentence TEXT NOT NULL,
      step4_sentences TEXT NOT NULL,
      fluency REAL NOT NULL DEFAULT 0,
      fluency_r REAL NOT NULL DEFAULT 0,
      prior_mastery_q REAL,
      introduced INTEGER NOT NULL DEFAULT 0,
      has_observation_p INTEGER NOT NULL DEFAULT 0,
      has_observation_r INTEGER NOT NULL DEFAULT 0,
      verified_p INTEGER NOT NULL DEFAULT 0,
      verified_r INTEGER NOT NULL DEFAULT 0,
      speed_verified_p INTEGER NOT NULL DEFAULT 0,
      speed_verified_r INTEGER NOT NULL DEFAULT 0,
      integrated_p INTEGER NOT NULL DEFAULT 0,
      integrated_r INTEGER NOT NULL DEFAULT 0,
      pending_relearn_p INTEGER NOT NULL DEFAULT 0,
      pending_relearn_r INTEGER NOT NULL DEFAULT 0,
      legacy_score_p REAL,
      legacy_score_r REAL,
      target_in REAL NOT NULL DEFAULT 80,
      target_out REAL NOT NULL DEFAULT 80,
      stability_tick REAL NOT NULL DEFAULT 4,
      stability_time REAL NOT NULL DEFAULT 3600000,
      stability_time_r REAL NOT NULL DEFAULT 3600000,
      last_tick INTEGER NOT NULL DEFAULT 0,
      last_ts INTEGER NOT NULL DEFAULT 0,
      last_ts_r INTEGER NOT NULL DEFAULT 0,
      integrated INTEGER NOT NULL DEFAULT 0,
      graduated INTEGER NOT NULL DEFAULT 0,
      profile INTEGER NOT NULL DEFAULT 0,
      goal_id INTEGER,
      freq INTEGER,
      freq_source TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tick INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      word_id INTEGER,
      result TEXT,
      detail TEXT
    );
    CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      target TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS glosses (
      word TEXT PRIMARY KEY,
      meaning TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS known_words (
      word TEXT PRIMARY KEY,
      band INTEGER NOT NULL,
      ts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      raw INTEGER NOT NULL,
      estimate INTEGER NOT NULL,
      nonwords_claimed INTEGER NOT NULL,
      detail TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS book_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      total_tokens INTEGER NOT NULL,
      total_sentences INTEGER NOT NULL,
      text TEXT,
      summary TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS book_words (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      word TEXT NOT NULL,
      freq INTEGER NOT NULL,
      per_million REAL NOT NULL,
      is_proper INTEGER NOT NULL DEFAULT 0,
      sentences TEXT NOT NULL DEFAULT '[]',
      UNIQUE(source_id, word)
    );
    CREATE TABLE IF NOT EXISTS book_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      filename TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      total_pages INTEGER NOT NULL DEFAULT 0,
      processed_pages INTEGER NOT NULL DEFAULT 0,
      ocr_pages INTEGER NOT NULL DEFAULT 0,
      text_chars INTEGER NOT NULL DEFAULT 0,
      source_id INTEGER,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  migrate(db);
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('global_tick', '0') ON CONFLICT(key) DO NOTHING`
  ).run();
  const count = (db.prepare('SELECT COUNT(*) AS c FROM words').get() as { c: number }).c;
  if (count === 0) seed(db);
}

// 老库迁移：状态机列 → 连续流利度模型（见 RPD「Schema changes vs the current code」）
function migrate(db: Database.Database) {
  const wordCols = new Set(
    (db.prepare('PRAGMA table_info(words)').all() as { name: string }[]).map((c) => c.name)
  );
  const addColumn = (name: string, ddl: string) => {
    if (!wordCols.has(name)) db.exec(`ALTER TABLE words ADD COLUMN ${ddl}`);
  };
  const legacy = wordCols.has('state');
  addColumn('fluency', 'fluency REAL NOT NULL DEFAULT 0');
  addColumn('fluency_r', 'fluency_r REAL NOT NULL DEFAULT 0');
  addColumn('prior_mastery_q', 'prior_mastery_q REAL');
  addColumn('introduced', 'introduced INTEGER NOT NULL DEFAULT 0');
  addColumn('has_observation_p', 'has_observation_p INTEGER NOT NULL DEFAULT 0');
  addColumn('has_observation_r', 'has_observation_r INTEGER NOT NULL DEFAULT 0');
  addColumn('verified_p', 'verified_p INTEGER NOT NULL DEFAULT 0');
  addColumn('verified_r', 'verified_r INTEGER NOT NULL DEFAULT 0');
  addColumn('speed_verified_p', 'speed_verified_p INTEGER NOT NULL DEFAULT 0');
  addColumn('speed_verified_r', 'speed_verified_r INTEGER NOT NULL DEFAULT 0');
  addColumn('integrated_p', 'integrated_p INTEGER NOT NULL DEFAULT 0');
  addColumn('integrated_r', 'integrated_r INTEGER NOT NULL DEFAULT 0');
  addColumn('pending_relearn_p', 'pending_relearn_p INTEGER NOT NULL DEFAULT 0');
  addColumn('pending_relearn_r', 'pending_relearn_r INTEGER NOT NULL DEFAULT 0');
  addColumn('legacy_score_p', 'legacy_score_p REAL');
  addColumn('legacy_score_r', 'legacy_score_r REAL');
  addColumn('stability_tick', 'stability_tick REAL NOT NULL DEFAULT 4');
  addColumn('stability_time', 'stability_time REAL NOT NULL DEFAULT 3600000');
  addColumn('stability_time_r', 'stability_time_r REAL NOT NULL DEFAULT 3600000');
  addColumn('last_tick', 'last_tick INTEGER NOT NULL DEFAULT 0');
  addColumn('last_ts', 'last_ts INTEGER NOT NULL DEFAULT 0');
  addColumn('last_ts_r', 'last_ts_r INTEGER NOT NULL DEFAULT 0');
  addColumn('integrated', 'integrated INTEGER NOT NULL DEFAULT 0');
  addColumn('graduated', 'graduated INTEGER NOT NULL DEFAULT 0');
  addColumn('profile', 'profile INTEGER NOT NULL DEFAULT 0');
  addColumn('goal_id', 'goal_id INTEGER');
  addColumn('freq', 'freq INTEGER');
  addColumn('freq_source', 'freq_source TEXT');
  addColumn('target_in', 'target_in REAL NOT NULL DEFAULT 80');
  addColumn('target_out', 'target_out REAL NOT NULL DEFAULT 80');

  const migrated = db
    .prepare(`SELECT value FROM meta WHERE key = 'migrated_fluency'`)
    .get() as { value: string } | undefined;
  if (legacy && !migrated) {
    // 旧状态一次性折算为流利度锚点，学习进度不丢失
    db.exec(`
      UPDATE words SET
        fluency = CASE state
          WHEN '4_MASTERED' THEN 85
          WHEN '3_BATCH_READY' THEN 75
          WHEN '2_FLUENCY_WAIT' THEN 60
          WHEN '1_FORGETTING' THEN 30
          ELSE 0 END,
        integrated = CASE WHEN state = '4_MASTERED' THEN 1 ELSE 0 END,
        last_ts = CASE WHEN state = '0_NEW' THEN 0 ELSE updated_at END
    `);
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('migrated_fluency', '1') ON CONFLICT(key) DO NOTHING`
    ).run();
  }
  // R/P 拆分回填（一次性）：存量 F 大多由产出任务挣得，阅读方向按「知识已确认、读速未认证」
  // 封顶 60 回填（RPD「Schema changes」），而非照抄原值高估阅读流利度
  const rpMigrated = db
    .prepare(`SELECT value FROM meta WHERE key = 'migrated_rp'`)
    .get() as { value: string } | undefined;
  if (!rpMigrated) {
    db.exec(
      `UPDATE words SET fluency_r = MIN(fluency, 60), stability_time_r = stability_time, last_ts_r = last_ts`
    );
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('migrated_rp', '1') ON CONFLICT(key) DO NOTHING`
    ).run();
  }

  // 个人终点回填（一次性）：按目标画像推导 target_in / target_out，词频不改变目标。
  // 老目标 JSON 里的 fluency_threshold 从此作废——毕业判定改为每词双轴达标
  const targetsMigrated = db
    .prepare(`SELECT value FROM meta WHERE key = 'migrated_targets_60_100'`)
    .get() as { value: string } | undefined;
  if (!targetsMigrated) {
    const goalRows = db.prepare(`SELECT id, target FROM goals`).all() as {
      id: number;
      target: string | null;
    }[];
    const profileByGoal = new Map(goalRows.map((g) => [g.id, parseProfile(g.target)]));
    const wordRows = db.prepare(`SELECT id, goal_id FROM words`).all() as {
      id: number;
      goal_id: number | null;
    }[];
    const stmt = db.prepare(`UPDATE words SET target_in = ?, target_out = ? WHERE id = ?`);
    for (const w of wordRows) {
      const t = targetsFor((w.goal_id != null && profileByGoal.get(w.goal_id)) || {});
      stmt.run(t.targetIn, t.targetOut, w.id);
    }
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('migrated_targets_60_100', '1') ON CONFLICT(key) DO NOTHING`
    ).run();
  }

  // 旧状态机列退役（老版本 sqlite 不支持 DROP COLUMN 时容忍保留，代码已不再读取）
  for (const col of ['state', 'ready_at_tick', 'ready_at_time', 'step4_fail_count', 'srs_level', 'due_at']) {
    if (wordCols.has(col)) {
      try {
        db.exec(`ALTER TABLE words DROP COLUMN ${col}`);
      } catch {
        /* 保留无害 */
      }
    }
  }

  const goalCols = new Set(
    (db.prepare('PRAGMA table_info(goals)').all() as { name: string }[]).map((c) => c.name)
  );
  if (!goalCols.has('target')) db.exec('ALTER TABLE goals ADD COLUMN target TEXT');

  const sourceCols = new Set(
    (db.prepare('PRAGMA table_info(book_sources)').all() as { name: string }[]).map((c) => c.name)
  );
  if (!sourceCols.has('text')) db.exec('ALTER TABLE book_sources ADD COLUMN text TEXT');
  if (!sourceCols.has('summary')) db.exec('ALTER TABLE book_sources ADD COLUMN summary TEXT');
}

export function createDb(file: string): Database.Database {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  init(db);
  return db;
}

export function getDb(): Database.Database {
  if (!globalForDb.__flowDb) {
    globalForDb.__flowDb = createDb(path.join(process.cwd(), 'flow.db'));
  }
  return globalForDb.__flowDb;
}
