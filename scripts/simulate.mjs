// 端到端调度验证：方案 B「双轴目标驱动调度」的完整学习闭环。
// 新模型里成熟由真实 wall-clock 衰减驱动（无会话、无 tick 归零），
// 因此必须用加速时钟跑 dev server，否则一个复习间隔就是真实的一小时：
//
//   rm -f flow.db flow.db-wal flow.db-shm
//   H_TIME_SEED_MS=15000 H_TIME_MIN_MS=15000 H_CACHE_MS=8000 H_TIME_PART_B_MS=120000 npm run dev
//   node scripts/simulate.mjs
//
// 验证路径：冷启动连续引入（复习池空 → 条件 a）→ 全部 NEW 耗尽后诚实 EMPTY
//          → 缓存冷却 + L 衰减后复习杀回 → STEP3 故意失败（F_P 回落、H 守下限）
//          → P⊃R 迁移托底 F_R=60 → F≥50 解锁 STEP4/STEP4R → 双轴 ≥75 ×5 触发 PART_B
//          → 集成认证 F_P 保底 80 → tick 全程单调递增 → 严重逾期路由（RELEARN_R → STEP12 relearn）
const base = process.env.BASE || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get() {
  const res = await fetch(`${base}/api/task`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`GET /api/task -> ${res.status}`);
  return res.json();
}

async function post(body) {
  const res = await fetch(`${base}/api/task/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST /api/task/result -> ${res.status}`);
  return res.json();
}

const label = (t) =>
  t.kind === 'EMPTY'
    ? 'EMPTY'
    : t.kind === 'PART_B'
      ? `PART_B [${t.words.map((w) => w.id)}]`
      : t.kind === 'MFI'
        ? `MFI w${t.word.id} "${t.word.chunk}"`
        : `${t.kind}${t.relearn ? '(relearn)' : ''}${t.srsReview ? '(srs)' : ''} w${t.word.id} "${t.word.chunk}" F写${t.word.fluency.toFixed(0)}/读${t.word.fluency_r.toFixed(0)}`;

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  OK  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
};

// 以满分表现回答任意任务；STEP3 可通过 failNext 故意失败一次
let failNextStep3 = false;
const answer = async (t) => {
  if (t.kind === 'STEP12')
    return post({ kind: 'STEP12', wordIds: [t.word.id], pass: true, latencyMs: 2500 });
  if (t.kind === 'STEP3') {
    const pass = !failNextStep3;
    failNextStep3 = false;
    return post({
      kind: 'STEP3',
      wordIds: [t.word.id],
      pass,
      srsReview: t.srsReview,
      latencyMs: 350 * t.word.chunk.length, // 恰好目标击键速度 → S=1
    });
  }
  if (t.kind === 'STEP4') {
    const words = t.word.step4_sentences.join(' ').split(/\s+/).filter(Boolean).length;
    return post({
      kind: 'STEP4',
      wordIds: [t.word.id],
      pass: true,
      latencyMs: Math.round((words / 60) * 60000), // 60 wpm = v_ceil → S=1
      wordsProduced: words,
    });
  }
  if (t.kind === 'STEP4R') {
    const words = t.word.step4_sentences.join(' ').split(/\s+/).filter(Boolean).length;
    return post({
      kind: 'STEP4R',
      wordIds: [t.word.id],
      pass: true,
      latencyMs: Math.round((words / 300) * 60000), // 300 wpm = v_ceil → S=1
    });
  }
  if (t.kind === 'MFI')
    return post({
      kind: 'MFI',
      wordIds: [t.word.id],
      pass: true,
      latencyMs: Math.round((t.passageWords / 300) * 60000),
      wordsRead: t.passageWords,
    });
  return post({ kind: 'PART_B', wordIds: t.words.map((w) => w.id), pass: true });
};

let snap = await get();

// --- Phase A：冷启动播种。复习池空（条件 a）→ 连续引入新词
console.log('--- Phase A: 冷启动连续引入（复习池空 → 插空引入） ---');
if (snap.task.kind !== 'STEP12') {
  console.error(`  FAIL 期望 STEP12，实际 ${label(snap.task)}（请先删除 flow.db 重跑）`);
  process.exit(1);
}
const w1id = snap.task.word.id;
let lastTick = snap.tick;
snap = await post({ kind: 'STEP12', wordIds: [w1id], pass: true, latencyMs: 3000 });
const w1 = snap.words.find((w) => w.id === w1id);
check(
  w1.band === 'LEARNING' && w1.fluency === 15 && w1.fluency_r === 8,
  `STEP12 双轴播种 F_P=15 / F_R=8（实际 ${w1.fluency.toFixed(1)}/${w1.fluency_r.toFixed(1)}）`
);
check(snap.tick === lastTick + 1, 'tick 单调 +1（无会话、无归零）');

// 刚播种的词缓存热（C≈1）被双闸门挡住 → 下一个任务还是新词引入
let binge = 0;
while (snap.task.kind === 'STEP12' && !snap.task.relearn && binge < 20) {
  binge++;
  snap = await answer(snap.task);
}
check(binge >= 2, `复习池空时连续引入新词（实际连续 ${binge} 个 STEP12）`);

// --- Phase B：新词耗尽 → 诚实 EMPTY（报告最近成熟时间，不提前硬刷） ---
console.log('--- Phase B: 新词耗尽 → EMPTY + 等待成熟 ---');
let empties = 0;
for (let i = 0; i < 60 && snap.task.kind === 'EMPTY'; i++) {
  empties++;
  const waitMs = Math.min(snap.task.nextAvailableInMs ?? 1500, 5000) + 300;
  await sleep(waitMs);
  snap = await get();
}
check(empties > 0, `8 个种子词全部引入后出现 EMPTY（实际 ${empties} 次）`);
check(snap.task.kind !== 'EMPTY', `等待后复习杀回：${label(snap.task)}`);

// --- Phase C：主循环。第一个 STEP3 故意失败；随后验证迁移托底与批次门禁 ---
console.log('--- Phase C: 主循环（故意失败一次 + 迁移 + PART_B） ---');
failNextStep3 = true;
let sawFail = false;
let partBDone = false;
let transferChecked = false;
let firstStep3Id = null;
for (let i = 0; i < 600; i++) {
  const t = snap.task;
  if (t.kind === 'EMPTY') {
    const waitMs = Math.min(t.nextAvailableInMs ?? 1500, 6000) + 300;
    await sleep(waitMs);
    snap = await get();
    continue;
  }
  const preF = t.kind === 'PART_B' ? null : t.word.fluency;
  const wordId = t.kind === 'PART_B' ? null : t.word.id;
  const wasStep3 = t.kind === 'STEP3';
  if (wasStep3 && firstStep3Id === null) firstStep3Id = wordId;
  if (t.kind === 'PART_B') partBDone = true;
  snap = await answer(t);
  console.log(`  t${snap.tick}: ${label(t)} -> next ${label(snap.task)}`);
  if (wordId != null) {
    const wAfter = snap.words.find((w) => w.id === wordId);
    if (wasStep3 && wordId === firstStep3Id && !sawFail) {
      sawFail = true;
      check(wAfter.fluency < preF, `STEP3 失败拖低 F_P（${preF.toFixed(1)} → ${wAfter.fluency.toFixed(1)}）`);
      check(
        wAfter.stability_time >= 15000,
        `失败后 H_time_P 减半但守下限（实际 ${(wAfter.stability_time / 1000).toFixed(1)}s）`
      );
    }
    if (wasStep3 && sawFail && !transferChecked && wAfter.fluency_r >= 59.9) {
      transferChecked = true;
      check(true, `P⊃R 迁移：STEP3 通过后 F_R 托底知识确认线 60（实际 ${wAfter.fluency_r.toFixed(1)}）`);
    }
  }
  if (partBDone) break;
}

check(transferChecked, '出现过一次 F_R 迁移托底（≥60）');
check(partBDone, 'PART_B 批次门禁在凑满 5 个双轴 ≥75 词后触发');
const integrated = snap.words.filter((w) => w.integrated === 1);
check(integrated.length === 5, `恰好 5 个词完成集成认证（实际 ${integrated.length}）`);
check(
  integrated.every((w) => w.fluency >= 80),
  `集成认证 F_P 保底 80（${integrated.map((w) => w.fluency.toFixed(0)).join(', ')}）`
);

// --- Phase D：tick 单调性 + 严重逾期路由 ---
console.log('--- Phase D: 严重逾期 → 重编码路由（RELEARN_R） ---');
// 直接拨库：把某个词的 P 轴锚点拨到 3 小时前（默认 H_time 下 L ≈ 0，C ≈ 0 → R < 0.2）
const Database = (await import('better-sqlite3')).default;
const db = new Database('flow.db');
db.pragma('busy_timeout = 5000');
const victim = snap.words.find((w) => w.integrated !== 1 && w.last_ts > 0);
if (victim) {
  db.prepare(`UPDATE words SET last_ts = ?, last_ts_r = ?, stability_time = 3600000, stability_time_r = 3600000 WHERE id = ?`)
    .run(Date.now() - 3 * 3600_000, Date.now() - 3 * 3600_000, victim.id);
  const t = (await get()).task;
  check(
    t.kind === 'STEP12' && t.relearn === true && t.word.id === victim.id,
    `R 跌穿 RELEARN_R 的词绕过竞争直路由重编码（实际 ${label(t)}）`
  );
  snap = await answer(t);
} else {
  console.log('  .. 没有可拨库的在学词，跳过');
}
db.close();

console.log(failures === 0 ? '\n全部断言通过 ✔' : `\n${failures} 个断言失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
