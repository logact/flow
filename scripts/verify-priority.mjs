// 验证：①选定学习目标后只从该目标引入新词 ②新词按词频降序进入流水线
// 流利度模型下 STEP12 与复习任务（R 成熟即杀回）交错出现，
// 本脚本消费途中任意任务，只对 STEP12 子序列做断言。
const base = process.env.BASE || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  OK  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
};
const j = async (r) => {
  if (!r.ok) throw new Error(`${r.url} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const get = (p) => fetch(`${base}${p}`, { cache: 'no-store' }).then(j);
const post = (p, body) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);

// 以满分表现回答任意任务，保证队列持续推进
const answer = (t) => {
  if (t.kind === 'STEP12')
    return post('/api/task/result', { kind: 'STEP12', wordIds: [t.word.id], pass: true, latencyMs: 2000 });
  if (t.kind === 'STEP3')
    return post('/api/task/result', {
      kind: 'STEP3',
      wordIds: [t.word.id],
      pass: true,
      srsReview: t.srsReview,
      latencyMs: 350 * t.word.chunk.length,
    });
  if (t.kind === 'STEP4') {
    const words = t.word.step4_sentences.join(' ').split(/\s+/).filter(Boolean).length;
    return post('/api/task/result', {
      kind: 'STEP4',
      wordIds: [t.word.id],
      pass: true,
      latencyMs: Math.round((words / 60) * 60000), // 60 wpm = 写作标尺 v_ceil → S=1
      wordsProduced: words,
    });
  }
  if (t.kind === 'STEP4R') {
    const words = t.word.step4_sentences.join(' ').split(/\s+/).filter(Boolean).length;
    return post('/api/task/result', {
      kind: 'STEP4R',
      wordIds: [t.word.id],
      pass: true,
      latencyMs: Math.round((words / 300) * 60000), // 300 wpm = 阅读标尺 v_ceil → S=1
    });
  }
  if (t.kind === 'MFI') {
    return post('/api/task/result', {
      kind: 'MFI',
      wordIds: [t.word.id],
      pass: true,
      latencyMs: Math.round((t.passageWords / 300) * 60000),
      wordsRead: t.passageWords,
    });
  }
  return post('/api/task/result', { kind: 'PART_B', wordIds: t.words.map((w) => w.id), pass: true });
};

// 消费任务直到收集到 n 个 STEP12（复习任务照常作答，不干涉调度）
const collectStep12 = async (n) => {
  const served = [];
  for (let i = 0; i < 120 && served.length < n; i++) {
    const snap = await get('/api/task');
    const t = snap.task;
    if (t.kind === 'EMPTY') {
      await sleep(Math.min(t.nextAvailableInMs ?? 1000, 3000) + 300);
      continue;
    }
    if (t.kind === 'STEP12') served.push({ chunk: t.word.chunk, freq: t.word.freq });
    await answer(t);
  }
  return served;
};

const SAMPLE = `Deep work is the ability to focus without distraction on a demanding task. Most people believe they focus well, but constant distraction has weakened their attention. Every notification pulls attention away from the task, and each switch makes the brain slower. To rebuild attention, schedule a daily deep work session and protect it. During a session, the phone stays outside the room. One task, one hour, zero distraction. At first the brain resists. Boredom appears within minutes, and the urge to check the phone feels physical. That discomfort is the training. A short session every morning builds the focus muscle faster than a long session once a week. Over a month, the brain adapts: distraction loses its grip, and deep focus becomes the default. The quality of work rises, tasks finish faster, and attention turns into a genuine advantage.`;

console.log('--- 建立两个目标 ---');
const a = await post('/api/books', { title: 'Priority Book', text: SAMPLE });
const ga = await post('/api/goals', { type: 'book', title: 'Priority Book', sourceId: a.sourceId, count: 10 });
const expected = a.topWords.filter((w) => !w.isProper).slice(0, 10).map((w) => w.word);
console.log(`  词频降序前 5：${expected.slice(0, 5).join(', ')}`);

const gb = await post('/api/goals', { type: 'wordlist', title: '无词频词表', text: 'zzz-alpha\nzzz-beta' });

console.log('--- 激活书目标：新词必须按词频降序出现 ---');
await post('/api/goals/active', { goalId: ga.goalId });
const served = await collectStep12(3);
// 正确性 = 全部落在词频最高的词集合内，且 freq 序列非递增（并列组内顺序任意）
const maxFreq = a.topWords.filter((w) => !w.isProper)[0].count;
check(served.length === 3, `收集到 3 个 STEP12（实际 ${served.length}）`);
check(
  served.every((s) => expected.includes(s.chunk)),
  `前 3 个新词都来自最高词频组：${served.map((s) => s.chunk).join(', ')}`
);
check(
  served.every((s) => s.freq === maxFreq),
  `词频全部 = 最高值 ${maxFreq}：${served.map((s) => `${s.chunk}:${s.freq}`).join(', ')}`
);
check(
  served.every((s, i) => i === 0 || served[i - 1].freq >= s.freq),
  'freq 序列非递增'
);

console.log('--- 切换到词表目标：只从该目标引入，书目标的词不插队 ---');
await post('/api/goals/active', { goalId: gb.goalId });
const wl = await collectStep12(2);
check(
  wl[0]?.chunk === 'zzz-alpha',
  `只引入词表目标的词（实际 ${wl[0]?.chunk}）`
);
check(wl[1]?.chunk === 'zzz-beta', `词表内按 id 顺序（无词频信息兜底），实际 ${wl[1]?.chunk}`);

console.log('--- 切回全部目标：继续按词频降序 ---');
await post('/api/goals/active', { goalId: null });
const rest = await collectStep12(1);
const remaining = expected.filter((w) => !served.some((s) => s.chunk === w));
check(
  rest[0] != null && remaining.includes(rest[0].chunk) && rest[0].freq === maxFreq,
  `恢复引入剩余最高频词之一（${remaining.slice(0, 3).join('/')}），实际 ${rest[0] ? `${rest[0].chunk}:${rest[0].freq}` : '无'}`
);

console.log(failures === 0 ? '\n全部断言通过 ✔' : `\n${failures} 个断言失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
