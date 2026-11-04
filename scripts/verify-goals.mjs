// 词汇量测量 + 目标系统的端到端验证（对运行中的 dev/prod server 打 API）
const base = process.env.BASE || 'http://localhost:3000';
let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  OK  ${msg}`);
  else {
    failures++;
    console.error(`  FAIL ${msg}`);
  }
};
const j = async (r) => {
  if (!r.ok) throw new Error(`${r.url} -> ${r.status}`);
  return r.json();
};
const get = (p) => fetch(`${base}${p}`, { cache: 'no-store' }).then(j);
const post = (p, body) =>
  fetch(`${base}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(j);

// --- 词汇量测量 ---
console.log('--- Assessment ---');
const { items } = await get('/api/assess');
check(items.length === 43, `抽样 43 词（40 真词 + 3 伪词），实际 ${items.length}`);

// 模拟一个"1k~4k 段全会、5k+ 全不会、不虚报"的用户
const KNOWN = new Set(
  `happy water family money night friend journey honest kitchen usual weight soldier
   achieve bother compete distant elderly factor abandon cautious delicate emerge fragile genuine`.split(
    /\s+/
  )
);
const answers = items.map((it) => ({ word: it.word, known: KNOWN.has(it.word) }));
const result = await post('/api/assess', { answers });
check(result.estimate === 4000, `估计值 = 4000（4 个段全对），实际 ${result.estimate}`);
check(result.nonwordsClaimed === 0, `伪词虚报数 = 0，实际 ${result.nonwordsClaimed}`);
check(result.bandDetail.length === 10, `返回 10 个词频段明细，实际 ${result.bandDetail.length}`);

// --- 目标：词表（含一个重复词验证去重） ---
console.log('--- Goal: wordlist ---');
const wl = await post('/api/goals', {
  type: 'wordlist',
  title: '三月词表',
  text: 'resilient - 有韧性的\nremove friction\nstumble upon - 偶然发现',
});
check(wl.added === 2 && wl.skipped === 1, `新增 2 / 去重 1，实际 added=${wl.added} skipped=${wl.skipped}`);

// --- 目标：书（词频提取 + 原句材料） ---
console.log('--- Goal: book ---');
const TEXT = `Deep work is the ability to focus without distraction on a demanding task. Most people believe they focus well, but constant distraction has weakened their attention. Every notification pulls attention away from the task, and each switch makes the brain slower. To rebuild attention, schedule a daily deep work session and protect it. During a session, the phone stays outside the room. One task, one hour, zero distraction. At first the brain resists. Boredom appears within minutes, and the urge to check the phone feels physical. That discomfort is the training. A short session every morning builds the focus muscle faster than a long session once a week. Over a month, the brain adapts: distraction loses its grip, and deep focus becomes the default. The quality of work rises, tasks finish faster, and attention turns into a genuine advantage.`;
const bk = await post('/api/goals', { type: 'book', title: 'Deep Work', text: TEXT, count: 20 });
check(bk.added >= 10, `从示例文本提取 >= 10 个高频内容词，实际 ${bk.added}`);

// --- 目标：IELTS ---
console.log('--- Goal: ielts ---');
const ie = await post('/api/goals', { type: 'ielts', title: 'IELTS 8.0', score: '8.0' });
check(ie.added >= 40, `IELTS 核心词入队（>= 40），实际 ${ie.added}`);
check(ie.info.includes('9000') && ie.info.includes('4000'), `IELTS 目标读取了测量结果做差距分析：${ie.info}`);

// --- 目标进度 + 调度器接管 ---
console.log('--- 进度与调度接管 ---');
const { goals } = await get('/api/goals');
check(goals.length >= 3, `至少 3 个目标，实际 ${goals.length}`);
const wlGoal = goals.find((g) => g.title === '三月词表');
check(wlGoal.total === 2 && wlGoal.fresh === 2, `词表目标 total=2 且全部待学，实际 total=${wlGoal.total} fresh=${wlGoal.fresh}`);

const snap = await get('/api/task');
check(snap.vocabEstimate === 4000, `首页快照带词汇量估计 4000，实际 ${snap.vocabEstimate}`);
const bookWords = snap.words.filter((w) => w.scene.includes('Deep Work'));
check(
  bookWords.length > 0 && bookWords.every((w) => w.step3_sentence.includes('___')),
  `书源语块的 Step3 全部来自原句挖空（抽检 ${bookWords.length} 个）`
);
check(
  bookWords.some((w) => w.step4_sentences[0].toLowerCase().includes(w.chunk)),
  `书源语块的 Step4 首句包含目标词（原句闪视）`
);
const ieltsWords = snap.words.filter((w) => w.scene === 'IELTS 学术核心词');
check(
  ieltsWords.length === ie.added && ieltsWords.every((w) => w.meaning.length > 0),
  `IELTS 语块带中文释义（${ieltsWords.length}/${ie.added}）`
);

console.log(failures === 0 ? '\n全部断言通过 ✔' : `\n${failures} 个断言失败 ✘`);
process.exit(failures === 0 ? 0 : 1);
