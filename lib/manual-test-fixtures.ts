import type Database from 'better-sqlite3';
import { seed } from './seed';

export const MANUAL_TEST_SCENARIOS = [
  { id: 'baseline', label: '基础词库：ENCODE 起始数据' },
  { id: 'encode', label: 'ENCODE：建立语义连接' },
  { id: 'retrieve-r', label: 'R RETRIEVE：释义识别' },
  { id: 'retrieve-p', label: 'P RETRIEVE：表达回忆' },
  { id: 'fluency-r', label: 'R FLUENCY：连续阅读' },
  { id: 'fluency-p', label: 'P FLUENCY：连续写作' },
  { id: 'missing-gloss', label: '缺少 gloss：补充释义' },
  { id: 'retention-recovery', label: '遗忘后恢复：P 轴重测' },
] as const;

export type ManualTestScenario = (typeof MANUAL_TEST_SCENARIOS)[number]['id'];

const SCENARIO_WORDS = {
  encode: {
    chunk: 'deplete mental energy', meaning: '耗尽心理能量', scene: '连续开会后，脑力和注意力都被消耗殆尽。',
    slots: 'deplete (v. 耗尽) + mental energy (心理能量)', substitute: 'use up mental energy',
    step3: 'After a long day of meetings, I feel completely ___ .',
    step4: ['Context switching can deplete mental energy.', 'A short walk helped her recover after work.'],
  },
  'retrieve-r': {
    chunk: 'remove friction', meaning: '消除阻力，让一件事更容易开始', scene: '把跑鞋提前放在门口，省掉出门前寻找装备的麻烦。',
    slots: 'remove (v. 消除) + friction (n. 阻力)', substitute: 'make something easier to start',
    step3: 'Putting the book on my desk helps ___ before I start reading.',
    step4: ['Good defaults remove friction from starting a new habit.', 'A clear checklist can make the first step easier.'],
  },
  'retrieve-p': {
    chunk: 'pay a hidden tax', meaning: '付出看不见的代价', scene: '免费软件可能用广告和通知消耗你的注意力。',
    slots: 'pay (v. 付出) + a hidden tax (隐性代价)', substitute: 'pay a cost you do not notice',
    step3: 'Every interruption makes the team ___ in lost focus.',
    step4: ['Constant notifications make us pay a hidden tax in attention.', 'The delay cost the team an hour.'],
  },
  'fluency-r': {
    chunk: 'break the ice', meaning: '打破冷场；缓和气氛', scene: '新团队第一次开会，Maya 讲了一个小故事，让大家开始轻松交流。',
    slots: 'break the ice = 缓和气氛、打破冷场', substitute: 'make people feel comfortable and start talking',
    step3: 'Maya told a short story to ___ at the meeting.',
    step4: ['The host asked a light question to break the ice.', 'Everyone started talking after the introduction.'],
  },
  'fluency-p': {
    chunk: 'build momentum', meaning: '积累势头；逐渐形成动力', scene: '先完成一个很小的动作，再借着开始后的惯性继续做。',
    slots: 'build (v. 建立) + momentum (n. 势头)', substitute: 'get moving and keep going',
    step3: 'Starting with a tiny task can help you ___ .',
    step4: ['Small wins build momentum for a larger project.', 'A steady routine helped the team keep moving.'],
  },
  'missing-gloss': {
    chunk: 'offload decisions', meaning: '', scene: '每天穿同一套衣服，是把“今天穿什么”的决定交给默认选项。',
    slots: 'offload (v. 转交) + decisions (n. 决定)', substitute: 'let a routine decide for you',
    step3: 'She prepares breakfast at night to ___ in the morning.',
    step4: ['A routine can offload small decisions.', 'He planned the route before leaving home.'],
  },
  'retention-recovery': {
    chunk: 'reclaim your attention', meaning: '重新掌握自己的注意力', scene: '关掉不必要的通知，把时间和注意力留给重要的事。',
    slots: 'reclaim (v. 重新获得) + your attention (注意力)', substitute: 'take back your focus',
    step3: 'Turning off notifications helped her ___ .',
    step4: ['A quiet morning helps me reclaim my attention.', 'She focused on one task at a time.'],
  },
} as const;

const now = () => Date.now();

const samplePassage = Array.from({ length: 20 }, () =>
  'The meeting team shared a story and helped everyone break the ice together.',
).join(' ');

function resetTables(db: Database.Database) {
  db.exec(`
    DELETE FROM task_instances;
    DELETE FROM task_analytics_events;
    DELETE FROM events;
    DELETE FROM book_words;
    DELETE FROM book_sources;
    DELETE FROM assessments;
    DELETE FROM known_words;
    DELETE FROM glosses;
    DELETE FROM words;
    DELETE FROM goals;
    DELETE FROM meta;
  `);
}

function putMeta(db: Database.Database, key: string, value: string) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, value);
}

function addGoal(db: Database.Database, sourceId: number | null) {
  const target = sourceId == null
    ? { reading_wpm: 150, writing_wpm: 25 }
    : { reading_wpm: 150, writing_wpm: 25, source_id: sourceId };
  return Number(db.prepare(
    'INSERT INTO goals (type, title, target, created_at) VALUES (?, ?, ?, ?)'
  ).run('wordlist', '手动测试目标（可重置）', JSON.stringify(target), now()).lastInsertRowid);
}

function addWord(
  db: Database.Database,
  goalId: number,
  scenario: Exclude<ManualTestScenario, 'baseline'>,
  sourceId: number | null,
) {
  const timestamp = now();
  const missingGloss = scenario === 'missing-gloss';
  const isR = scenario === 'retrieve-r' || scenario === 'fluency-r';
  const isFluency = scenario === 'fluency-r' || scenario === 'fluency-p';
  const isRecovery = scenario === 'retention-recovery';
  const completeR = scenario === 'retrieve-p' || scenario === 'fluency-p';
  const completeP = scenario === 'retrieve-r' || scenario === 'fluency-r';
  const scoreR = isR || isRecovery ? (isFluency ? 55 : 35) : completeR ? 80 : 0;
  const scoreP = completeP ? 80 : scenario === 'fluency-p' ? 55 : isRecovery ? 55 : 0;
  const lastTsP = isRecovery
    ? timestamp - 60 * 24 * 60 * 60 * 1000
    : scenario === 'fluency-p' ? timestamp - 25 * 60 * 1000 : 0;
  const lastTsR = scenario === 'fluency-r' ? timestamp - 25 * 60 * 1000 : 0;
  const content = SCENARIO_WORDS[scenario];
  const writingText = `Starting a new project can feel difficult at first. I choose one small task, ask a teammate for a clear first step, and use the early success to ${content.chunk}. This helps everyone stay focused, share ideas, and keep working when the next challenge appears.`;
  const step4 = scenario === 'fluency-p' ? [writingText] : content.step4;

  const result = db.prepare(`
    INSERT INTO words (
      chunk, meaning, scene, slots, substitute, step3_sentence, step4_sentences,
      fluency, fluency_r, introduced, has_observation_p, has_observation_r,
      verified_p, verified_r, speed_verified_p, speed_verified_r,
      target_in, target_out, stability_tick, stability_time, stability_time_r,
      last_tick, last_ts, last_ts_r, goal_id, freq, prior_mastery_q,
      created_at, updated_at
    ) VALUES (
      @chunk, @meaning, @scene, @slots, @substitute, @step3_sentence, @step4_sentences,
      @fluency, @fluency_r, @introduced, @has_observation_p, @has_observation_r,
      @verified_p, @verified_r, @speed_verified_p, @speed_verified_r,
      80, 80, 4, @stability_time, @stability_time_r,
      0, @last_ts, @last_ts_r, @goal_id, 100, @prior_mastery_q, @created_at, @updated_at
    )
  `).run({
    chunk: content.chunk,
    meaning: content.meaning,
    scene: content.scene,
    slots: content.slots,
    substitute: content.substitute,
    step3_sentence: content.step3,
    step4_sentences: JSON.stringify(step4),
    fluency: scoreP,
    fluency_r: scoreR,
    introduced: scenario === 'encode' || missingGloss ? 0 : 1,
    has_observation_p: isRecovery || scenario === 'fluency-p' || completeP ? 1 : 0,
    has_observation_r: scenario === 'fluency-r' || completeR ? 1 : 0,
    verified_p: completeP || scenario === 'fluency-p' || isRecovery ? 1 : 0,
    verified_r: completeR || scenario === 'fluency-r' ? 1 : 0,
    speed_verified_p: completeP || isRecovery ? 1 : 0,
    speed_verified_r: completeR ? 1 : 0,
    stability_time: isRecovery ? 60 * 60 * 1000 : completeP || completeR ? 30 * 24 * 60 * 60 * 1000 : 60 * 60 * 1000,
    stability_time_r: completeR ? 30 * 24 * 60 * 60 * 1000 : 60 * 60 * 1000,
    last_ts: lastTsP,
    last_ts_r: lastTsR,
    goal_id: goalId,
    prior_mastery_q: scenario === 'encode' || missingGloss ? 0 : 0.5,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return { wordId: Number(result.lastInsertRowid), chunk: content.chunk };
}

/** Replace only the isolated manual-test database contents with one deterministic scenario. */
export function resetManualTestFixture(db: Database.Database, scenario: ManualTestScenario = 'baseline') {
  if (!MANUAL_TEST_SCENARIOS.some((item) => item.id === scenario)) throw new Error('未知的测试场景');
  const run = db.transaction(() => {
    resetTables(db);
    putMeta(db, 'global_tick', '100');
    putMeta(db, 'goal_scope_strict', '1');

    if (scenario === 'baseline') {
      // Seed the same eight real sample entries used by a fresh database, then
      // attach them to a test goal so the normal scheduler can issue ENCODE cards.
      seed(db);
      const goalId = addGoal(db, null);
      db.prepare('UPDATE words SET goal_id = ?').run(goalId);
      putMeta(db, 'active_goal_id', String(goalId));
      const seededWords = db.prepare('SELECT id, chunk FROM words ORDER BY id').all() as { id: number; chunk: string }[];
      return { scenario, goalId, wordIds: seededWords.map((row) => row.id), words: seededWords.map((row) => row.chunk), wordCount: seededWords.length, sourceId: null };
    }

    if (scenario === 'baseline') throw new Error('基础词库场景初始化失败');

    let sourceId: number | null = null;
    if (scenario === 'fluency-r') {
      sourceId = Number(db.prepare(`
        INSERT INTO book_sources (title, total_tokens, total_sentences, text, summary, topic_terms, created_at)
        VALUES (?, ?, ?, ?, NULL, ?, ?)
      `).run(
        '手动测试篇章：团队会议', 260, 20, samplePassage,
        JSON.stringify(['meeting', 'team', 'story']), now(),
      ).lastInsertRowid);

      const words = [...new Set(samplePassage.toLowerCase().match(/[a-z]+/g) ?? [])];
      const insertKnown = db.prepare('INSERT INTO known_words (word, band, ts) VALUES (?, 5, ?)');
      for (const word of words) insertKnown.run(word, now());
      putMeta(db, 'vocab_estimate', '5000');
    }

    const goalId = addGoal(db, sourceId);
    putMeta(db, 'active_goal_id', String(goalId));
    const { wordId, chunk } = addWord(db, goalId, scenario, sourceId);
    return { scenario, goalId, wordId, words: [chunk], wordCount: 1, sourceId };
  });
  return run();
}
