import type Database from 'better-sqlite3';
import { bandOf, type WordRow } from './db';
import { lookupGlosses, rankedWords } from './gloss';
import { analyzeBook } from './book';
import { materialFromStat, materialsFromIelts, materialsFromWordlist, type Material } from './material';
import { targetsFor, parseProfile, priorMasteryProbability, type TargetProfile } from './targets';

// IELTS 目标分 → 大致所需词汇量（业界通行的粗略对应，原型够用）
export const IELTS_TARGET_VOCAB: Record<string, number> = {
  '6.0': 5500,
  '6.5': 6200,
  '7.0': 7200,
  '7.5': 8200,
  '8.0': 9000,
};

export interface GoalInput {
  type: 'wordlist' | 'book' | 'ielts';
  title: string;
  text?: string;
  count?: number;
  score?: string;
  sourceId?: number; // 书目标：引用已分析的书源（两阶段流程）
}

export interface GoalResult {
  goalId: number;
  added: number;
  skipped: number;
  info: string;
}

export async function createGoal(
  db: Database.Database,
  input: GoalInput,
  now = Date.now()
): Promise<GoalResult> {
  // 去重基准：已存在的 chunk（不分大小写）跳过
  const existing = new Set(
    (db.prepare('SELECT chunk FROM words').all() as { chunk: string }[]).map((r) =>
      r.chunk.toLowerCase()
    )
  );
  const vocabRow = db.prepare(`SELECT value FROM meta WHERE key = 'vocab_estimate'`).get() as
    | { value: string }
    | undefined;
  const vocabEstimate = vocabRow ? Number(vocabRow.value) : null;

  let materials: Material[];
  let info = '';
  // 目标终态画像（JSON）：F 锚定在可测的表现目标上，见 RPD「目标锚定的流利度」。
  // 缺省 wpm 落在标尺下限（reading 150 / writing 25）→ 个人终点 base 80
  let target: TargetProfile = { writing_wpm: 25 };

  if (input.type === 'wordlist') {
    if (!input.text?.trim()) throw new Error('词表内容为空');
    materials = materialsFromWordlist(input.text);
  } else if (input.type === 'book') {
    target = { reading_wpm: 200, writing_wpm: 25 };
    // count = 0 或缺省 30；count=0 表示"全部"（不限量）
    const limit = input.count && input.count > 0 ? input.count : input.count === 0 ? Infinity : 30;
    if (input.sourceId) {
      // 两阶段流程：从已落库的分析统计选材（先去重再截取，保证数量准确）
      const rows = db
        .prepare(
          `SELECT word, freq, is_proper, sentences FROM book_words
           WHERE source_id = ? ORDER BY freq DESC`
        )
        .all(input.sourceId) as { word: string; freq: number; is_proper: number; sentences: string }[];
      if (rows.length === 0) throw new Error('书源不存在或尚未分析');
      target.source_id = input.sourceId; // MFI 篇章材料来源
      materials = rows
        .filter((r) => !r.is_proper && !existing.has(r.word.toLowerCase()))
        .slice(0, limit)
        .map((r) =>
          materialFromStat(input.title, {
            word: r.word,
            count: r.freq,
            sentences: JSON.parse(r.sentences) as string[],
          })
        );
    } else {
      if (!input.text?.trim()) throw new Error('书籍文本为空');
      // 直接粘贴文本的路径同样落库书源——否则 MFI 无米下锅
      const analysis = analyzeBook(input.text);
      const sourceId = Number(
        db
          .prepare(
            `INSERT INTO book_sources (title, total_tokens, total_sentences, text, summary, created_at)
             VALUES (?, ?, ?, ?, NULL, ?)`
          )
          .run(input.title, analysis.totalTokens, analysis.totalSentences, input.text, now)
          .lastInsertRowid
      );
      target.source_id = sourceId;
      materials = analysis.words
        .filter((w) => !w.isProper)
        .slice(0, limit as number)
        .map((s) => materialFromStat(input.title, s));
    }
  } else {
    materials = materialsFromIelts();
    const vocabTarget = IELTS_TARGET_VOCAB[input.score ?? '7.0'] ?? 7200;
    target = { vocab_size: vocabTarget, reading_wpm: 200, writing_wpm: 30 };
    info =
      vocabEstimate != null
        ? `当前词汇量估计 ${vocabEstimate} → 目标 ${vocabTarget}，差距约 ${Math.max(0, vocabTarget - vocabEstimate)} 词。已将 IELTS 核心词入队（原型为全量入队，正式版应按差距从词频表动态选材）。`
        : `目标 ${vocabTarget} 词汇量。建议先做词汇量测量，系统才能按差距选材。已将 IELTS 核心词入队。`;
  }

  const fresh = materials.filter((m) => !existing.has(m.chunk.toLowerCase()));
  const skipped = materials.length - fresh.length;

  // q is a routing prior only. The unassessed R/P scores remain 0 until evidence is submitted.
  const rankByWord = new Map(rankedWords().map((word, index) => [word.toLowerCase(), index + 1]));
  const priorFor = (chunk: string) => {
    const ranks = chunk.toLowerCase().split(/\s+/).map((word) => rankByWord.get(word)).filter(
      (rank): rank is number => rank != null
    );
    return priorMasteryProbability(vocabEstimate, ranks.length ? Math.max(...ranks) : null);
  };

  // 无释义的语块补 gloss：本地 ECDICT 子集优先，缺失再走在线源（结果缓存）
  const glossless = fresh.filter((m) => !m.meaning).map((m) => m.chunk);
  let glossed = 0;
  if (glossless.length > 0) {
    const glosses = await lookupGlosses(db, glossless);
    for (const m of fresh) {
      if (m.meaning) continue;
      const g = glosses.get(m.chunk.trim().toLowerCase());
      if (g) {
        m.meaning = g;
        glossed++;
      }
    }
  }

  const insertGoal = db.prepare(
    `INSERT INTO goals (type, title, target, created_at) VALUES (?, ?, ?, ?)`
  );
  const insertWord = db.prepare(`
    INSERT INTO words (chunk, meaning, scene, slots, substitute, step3_sentence, step4_sentences,
                       fluency, fluency_r, target_in, target_out, last_tick, last_ts, last_ts_r,
                       goal_id, freq, prior_mastery_q, introduced, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const run = db.transaction(() => {
    const goalId = Number(
      insertGoal.run(input.type, input.title, JSON.stringify(target), now).lastInsertRowid
    );
    for (const m of fresh) {
      // 每词的个人终点在入库时物化（RPD「每词的个人终点」）；目标速度修改时批量重算
      const t = targetsFor(target);
      insertWord.run(
        m.chunk,
        m.meaning,
        m.scene,
        m.slots,
        m.substitute,
        m.step3_sentence,
        JSON.stringify(m.step4_sentences),
        0,
        0,
        t.targetIn,
        t.targetOut,
        0,
        0,
        0,
        goalId,
        m.freq,
        priorFor(m.chunk),
        0,
        now,
        now
      );
    }
    return goalId;
  });

  const goalId = run();
  if (!info) {
    info = `已生成 ${fresh.length} 个语块加入学习队列${skipped > 0 ? `（跳过 ${skipped} 个重复词）` : ''}。`;
  }
  if (glossed > 0) info += `（自动补充 ${glossed} 个释义）`;
  return { goalId, added: fresh.length, skipped, info };
}

// 删除目标：连同其全部语块一起移除（含在学/已掌握的）。events 日志保留作审计，
// 其 word_id 成为悬空引用但不影响调度。若删除的是激活目标，一并清除激活态。
export function deleteGoal(db: Database.Database, goalId: number): boolean {
  const run = db.transaction(() => {
    const r = db.prepare(`DELETE FROM goals WHERE id = ?`).run(goalId);
    if (r.changes === 0) return false;
    db.prepare(`DELETE FROM words WHERE goal_id = ?`).run(goalId);
    const active = db
      .prepare(`SELECT value FROM meta WHERE key = 'active_goal_id'`)
      .get() as { value: string } | undefined;
    if (active && Number(active.value) === goalId) {
      db.prepare(`DELETE FROM meta WHERE key = 'active_goal_id'`).run();
    }
    return true;
  });
  return run();
}

export interface GoalProgress {
  id: number;
  type: string;
  title: string;
  created_at: number;
  target: TargetProfile | null;
  total: number;
  graduated: number;
  mastered: number;
  integrable: number;
  inPipeline: number;
  fresh: number;
  fluency: number; // 词频加权流利度 Σwᵢ·min(F_R,F_P)ᵢ/Σwᵢ（headline = 弱方向）
  attainment: number; // 目标达成度：双轴均达个人目标的 KP 的词频加权占比（0–1）
}

export function listGoals(db: Database.Database): GoalProgress[] {
  const goals = db
    .prepare(`SELECT id, type, title, target, created_at FROM goals ORDER BY id DESC`)
    .all() as { id: number; type: string; title: string; target: string | null; created_at: number }[];
  const words = db
    .prepare(
      `SELECT id, goal_id, freq, fluency, fluency_r, target_in, target_out, integrated, graduated, last_ts FROM words`
    )
    .all() as WordRow[];

  return goals.map((g) => {
    const target = parseProfile(g.target);
    const mine = words.filter((w) => w.goal_id === g.id);
    const bandCount = { graduated: 0, mastered: 0, integrable: 0, inPipeline: 0, fresh: 0 };
    let sw = 0;
    let swf = 0;
    let swHit = 0;
    for (const w of mine) {
      const band = bandOf(w);
      if (band === 'GRADUATED') bandCount.graduated++;
      else if (band === 'MASTERED') bandCount.mastered++;
      else if (band === 'INTEGRABLE') bandCount.integrable++;
      else if (band === 'NEW') bandCount.fresh++;
      else bandCount.inPipeline++;
      const weight = 1 + Math.log(1 + (w.freq ?? 0));
      sw += weight;
      swf += weight * Math.min(w.fluency, w.fluency_r);
      if (w.fluency >= w.target_out && w.fluency_r >= w.target_in) swHit += weight;
    }
    return {
      id: g.id,
      type: g.type,
      title: g.title,
      created_at: g.created_at,
      target: g.target ? target : null,
      total: mine.length,
      ...bandCount,
      fluency: Number((sw > 0 ? swf / sw : 0).toFixed(1)),
      attainment: Number((sw > 0 ? swHit / sw : 0).toFixed(3)),
    };
  });
}
