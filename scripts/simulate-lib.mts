// 方案 B 调度的确定性端到端验证：直接驱动 lib（无 server），用合成时钟快进时间。
// 运行：npx tsx scripts/simulate-lib.mts
// 覆盖：冷启动连续引入 → 缓存冲冷后高 P 复习抢占新词引入 → STEP3 失败/迁移
//      → STEP4/STEP4R 解锁 → PART_B 门禁 → 集成认证 → 维护复习 → 毕业（H ≥ 30d）
//      → RELEARN_R 重编码路由（按 L 判死）→ MFI 切片单测 → tick 全程单调
import { rmSync } from 'node:fs';
import { createDb, type WordRow } from '../lib/db';
import { getNextTask, applyResult, type Task } from '../lib/scheduler';
import { sliceMfi } from '../lib/mfi';

const DB_PATH = '/tmp/flow-sim.db';
for (const suffix of ['', '-wal', '-shm']) rmSync(DB_PATH + suffix, { force: true });
const db = createDb(DB_PATH);

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let now = 1_700_000_000_000;

let failures = 0;
const check = (cond: boolean, msg: string) => {
  if (cond) console.log(`  OK  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
};

const words = () => db.prepare('SELECT * FROM words').all() as WordRow[];
const word = (id: number) => words().find((w) => w.id === id)!;

let taskCount = 0;
const answer = (t: Task, opts: { fail?: boolean } = {}) => {
  taskCount++;
  switch (t.kind) {
    case 'STEP12':
      applyResult(db, { kind: 'STEP12', wordIds: [t.word.id], pass: true, latencyMs: 2500 }, now);
      break;
    case 'STEP3':
      applyResult(
        db,
        {
          kind: 'STEP3',
          wordIds: [t.word.id],
          pass: !opts.fail,
          srsReview: t.srsReview,
          latencyMs: 350 * t.word.chunk.length, // 目标击键速度 → S=1
        },
        now
      );
      break;
    case 'STEP4': {
      const wc = t.word.step4_sentences.join(' ').split(/\s+/).filter(Boolean).length;
      applyResult(
        db,
        {
          kind: 'STEP4',
          wordIds: [t.word.id],
          pass: !opts.fail,
          latencyMs: Math.round((wc / 60) * 60000), // 60 wpm = v_ceil → S=1
          wordsProduced: wc,
        },
        now
      );
      break;
    }
    case 'STEP4R': {
      const wc = t.word.step4_sentences.join(' ').split(/\s+/).filter(Boolean).length;
      applyResult(
        db,
        {
          kind: 'STEP4R',
          wordIds: [t.word.id],
          pass: !opts.fail,
          latencyMs: Math.round((wc / 300) * 60000), // 300 wpm = v_ceil → S=1
        },
        now
      );
      break;
    }
    case 'MFI':
      applyResult(
        db,
        {
          kind: 'MFI',
          wordIds: [t.word.id],
          pass: !opts.fail,
          latencyMs: Math.round((t.passageWords / 300) * 60000),
          wordsRead: t.passageWords,
        },
        now
      );
      break;
    case 'PART_B':
      applyResult(db, { kind: 'PART_B', wordIds: t.words.map((w) => w.id), pass: !opts.fail }, now);
      break;
    case 'EMPTY':
      throw new Error('cannot answer EMPTY');
  }
};

const next = (): Task => getNextTask(db, now);

// --- Phase A：冷启动。复习池空（条件 a）→ 连续引入新词
console.log('--- Phase A: 冷启动连续引入 ---');
let t = next();
check(t.kind === 'STEP12', `首任务 STEP12（实际 ${t.kind}）`);
const w1id = t.kind === 'STEP12' ? t.word.id : 0;
answer(t);
const w1 = word(w1id);
check(w1.fluency === 15 && w1.fluency_r === 8, `双轴播种 F_P=15 / F_R=8（实际 ${w1.fluency}/${w1.fluency_r}）`);
check(
  w1.stability_time === HOUR && w1.stability_time_r === HOUR,
  '双向 H_time 均播种 1h'
);

now += 90 * 1000;
t = next();
check(t.kind === 'STEP12', `第一词缓存还热 → 继续插空引入（实际 ${t.kind}）`);
answer(t);

// --- Phase B：冲刷冷却后，高 P 词的复习抢在剩余新词前面（不把生词无止境塞给用户）
console.log('--- Phase B: 缓存冲冷 → 复习抢占（P ≥ NEW_WORD_BYPASS） ---');
// 把 w1 调成高频词（w_freq 大）：它一旦成熟，P 就足以阻断继续引入
db.prepare(`UPDATE words SET freq = 200 WHERE id = ?`).run(w1id);
for (let i = 0; i < 3; i++) {
  now += 90 * 1000;
  t = next();
  check(t.kind === 'STEP12', `冲刷期继续引入（第 ${i + 2} 个，实际 ${t.kind}）`);
  answer(t);
}
now += 90 * 1000;
t = next();
check(
  t.kind === 'STEP3' && t.word.id === w1id,
  `w1 缓存冲冷（Δtick≥4）后复习杀回，抢在剩余 ${8 - 5} 个新词前（实际 ${t.kind}${t.kind !== 'EMPTY' && t.kind !== 'PART_B' ? ` w${t.word.id}` : ''}）`
);

// --- Phase C：第一次 STEP3 故意失败 → F_P 回落、H 守下限；下一次通过验证迁移托底
console.log('--- Phase C: 失败回落 + P⊃R 迁移 ---');
const failId = t.kind === 'STEP3' ? t.word.id : 0;
answer(t, { fail: true });
const wf = word(failId);
check(wf.fluency < 15, `STEP3 失败拖低 F_P（15 → ${wf.fluency.toFixed(1)}）`);
check(wf.stability_time >= HOUR, `H_time_P 减半守 1h 下限（实际 ${(wf.stability_time / HOUR).toFixed(1)}h）`);

let transferOk = false;
for (let i = 0; i < 40 && !transferOk; i++) {
  now += 2 * MIN;
  t = next();
  if (t.kind === 'EMPTY') {
    now += (t.nextAvailableInMs ?? 5 * MIN) + 1000;
    t = next();
  }
  if (t.kind === 'EMPTY') continue;
  const id = t.kind === 'PART_B' ? 0 : t.word.id;
  const wasStep3 = t.kind === 'STEP3';
  answer(t);
  if (wasStep3 && id !== failId) {
    const wa = word(id);
    if (wa.fluency_r >= 59.9) {
      transferOk = true;
      check(true, `P⊃R 迁移：STEP3 通过托底 F_R=60（实际 ${wa.fluency_r.toFixed(1)}）`);
    }
  }
}
check(transferOk, '出现过迁移托底');

// --- Phase D：主循环 → STEP4/STEP4R 解锁 → 双轴 ≥75 ×5 触发 PART_B
console.log('--- Phase D: 主循环至 PART_B ---');
const seen = new Set<string>();
let partBDone = false;
for (let i = 0; i < 2000 && !partBDone; i++) {
  t = next();
  if (t.kind === 'EMPTY') {
    now += (t.nextAvailableInMs ?? 10 * MIN) + 1000;
    continue;
  }
  seen.add(t.kind);
  if (t.kind === 'PART_B') partBDone = true;
  answer(t);
  now += 2 * MIN;
}
check(seen.has('STEP4'), 'F_P ≥ 50 后解锁 STEP4（限时写作）');
check(seen.has('STEP4R'), 'F_R ≥ 50 后解锁 STEP4R（限时速读）');
check(partBDone, 'PART_B 门禁在凑满 5 个双轴 ≥75 词后触发');
const integrated = words().filter((w) => w.integrated === 1);
check(integrated.length === 5, `恰好 5 个词集成认证（实际 ${integrated.length}）`);
check(
  integrated.every((w) => w.fluency >= 80 && w.stability_time >= DAY),
  `集成认证 F_P 保底 80、H_time_P 跳 1d 档（F: ${integrated.map((w) => w.fluency.toFixed(0)).join(',')}）`
);

// --- Phase E：维护复习 → 毕业。达标轴以 MAINT_GAP 留队，H 满 30d 才毕业
console.log('--- Phase E: 维护复习 → 毕业 ---');
let graduatedCount = 0;
for (let i = 0; i < 4000 && graduatedCount === 0; i++) {
  t = next();
  if (t.kind === 'EMPTY') {
    now += (t.nextAvailableInMs ?? DAY) + 60_000;
    continue;
  }
  answer(t);
  now += 30 * MIN;
  graduatedCount = words().filter((w) => w.graduated === 1).length;
}
check(graduatedCount > 0, `维护复习把 H 喂到 30d 后有词毕业（实际 ${graduatedCount} 个）`);
const g = words().find((w) => w.graduated === 1);
if (g) {
  check(
    g.fluency >= g.target_out && g.fluency_r >= g.target_in &&
      g.stability_time >= 30 * DAY && g.stability_time_r >= 30 * DAY,
    `毕业条件齐备：双轴达标 + 双向 H ≥ 30d（w${g.id} "${g.chunk}"）`
  );
}

// --- Phase F：严重逾期路由 → STEP12 relearn
console.log('--- Phase F: RELEARN_R 重编码路由 ---');
const victim = words().find((w) => !w.graduated && !w.integrated && w.last_ts > 0);
if (victim) {
  db.prepare(
    `UPDATE words SET last_ts = ?, last_ts_r = ?, stability_time = ?, stability_time_r = ? WHERE id = ?`
  ).run(now - 3 * HOUR, now - 3 * HOUR, HOUR, HOUR, victim.id);
  t = next();
  check(
    t.kind === 'STEP12' && t.relearn === true && t.word.id === victim.id,
    `R 跌穿 0.2 的词绕过竞争直路由重编码（实际 ${t.kind}${t.kind === 'STEP12' && t.relearn ? '(relearn)' : ''} w${t.kind !== 'EMPTY' && t.kind !== 'PART_B' ? t.word.id : ''}）`
  );
  answer(t);
  const wv = word(victim.id);
  check(wv.fluency === 15 && wv.fluency_r === 8, `重编码后重新播种（F_P=${wv.fluency} F_R=${wv.fluency_r}）`);
} else {
  console.log('  .. 无可拨库的在学词，跳过');
}

// --- Phase G：MFI 切片单测（合成文本）
console.log('--- Phase G: MFI 切片 ---');
const filler = (i: number) =>
  `Sentence number ${String.fromCharCode(97 + Math.floor(i / 26))}${String.fromCharCode(97 + (i % 26))} of the quiet morning brings fresh air and gentle light across the small town. People walk slowly through the narrow streets and greet each other with warm smiles.`;
const book = Array.from({ length: 60 }, (_, i) =>
  i === 30 ? 'She decided to break the ice with a funny story.' : filler(i)
).join(' ');
const mfi = sliceMfi(book, 'break the ice', () => true, 0);
check(mfi != null, '切出篇章');
if (mfi) {
  check(
    mfi.words >= 150 && mfi.words <= 300,
    `篇章词数在 150–300 窗口（实际 ${mfi.words}）`
  );
  check(/break the ice/.test(mfi.passage), '篇章包含目标 KP');
  check(
    mfi.options.length === 3 && mfi.answerIndex >= 0 && mfi.answerIndex < 3,
    `主旨三选一（正确项 index=${mfi.answerIndex}）`
  );
  check(mfi.options[mfi.answerIndex] === 'She decided to break the ice with a funny story.' ||
    book.includes(mfi.options[mfi.answerIndex]), '正确项来自篇内');
  const lowCov = sliceMfi(book, 'break the ice', () => false, 0);
  check(lowCov === null, '已知覆盖率不足 95% 时拒绝切片（不可派）');
}

// --- Phase H：tick 单调 = 每次 applyResult +1，无归零
console.log('--- Phase H: tick 单调 ---');
const tickRow = db.prepare(`SELECT value FROM meta WHERE key = 'global_tick'`).get() as { value: string };
check(Number(tickRow.value) === taskCount, `tick 全程单调递增（${tickRow.value} == ${taskCount} 次任务）`);
const sessionEvents = db
  .prepare(`SELECT COUNT(*) AS c FROM events WHERE kind = 'SESSION_END'`)
  .get() as { c: number };
check(sessionEvents.c === 0, '无 SESSION_END 事件（会话概念已删除）');

console.log(failures === 0 ? '\n全部断言通过 ✔' : `\n${failures} 个断言失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
