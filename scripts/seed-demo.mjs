// 演示数据：创建「Demo · 全题型演示」目标，覆盖全部六个档位，
// 让队列依次吐出所有题型：PART_B → STEP3 → STEP4 → 维护复习(STEP3 srs) → STEP12。
// 用法：node scripts/seed-demo.mjs   （幂等：重复执行会先删除旧演示目标）
// 注意：直接把词写到指定 fluency/档位，绕过打分管线——仅为演示，非真实学习记录。
import Database from 'better-sqlite3';

const db = new Database('flow.db');
db.pragma('busy_timeout = 5000');

const H = 3600_000;
const D = 24 * H;
const now = Date.now();

// band 种子：fluence 决定档位；last_ts 往前拨 2 个半衰期 → R_time = 0.25（立即成熟）
const BANDS = {
  NEW: { fluency: 0, stability_time: H, ripe: false },
  LEARNING: { fluency: 30, stability_time: 1 * H, ripe: true },
  CONSOLIDATING: { fluency: 60, stability_time: 4 * H, ripe: true },
  INTEGRABLE: { fluency: 78, stability_time: 12 * H, ripe: true },
  MASTERED: { fluency: 85, stability_time: 3 * D, ripe: true, integrated: 1 },
  GRADUATED: { fluency: 90, stability_time: 40 * D, ripe: true, integrated: 1, graduated: 1 },
};

const WORDS = [
  // —— NEW ×3（从未尝试 → STEP12 引入）
  ['bite the bullet', '硬着头皮做（难事）', '报告 deadline 就在明早，再不想写也得动手了。', 'bite (v. 咬) + the bullet (n. 子弹)', 'grit your teeth and do it', 'I hate public speaking, but I\'ll have to ___ and present tomorrow.', ['She bit the bullet and called the client back.', 'He bit the bullet and admitted the mistake.', 'Sometimes you just bite the bullet and start.'], 50],
  ['hit the ground running', '一上手就全速推进', '新工作第一天，没人带你，但你直接进入了状态。', 'hit (v. 撞击) + the ground (n. 地面) + running (adv. 奔跑着)', 'start something with immediate full energy', 'The new manager ___ on her first day.', ['We need someone who can hit the ground running.', 'The team hit the ground running after the kickoff.', 'She hit the ground running in her new role.'], 45],
  ['on the back burner', '暂时搁置', '这个功能不错，但这个季度没排上——先放着。', 'on (prep.) + the back burner (n. 后灶眼)', 'postponed for later', 'The redesign is ___ until next quarter.', ['Put that idea on the back burner for now.', 'The plan stayed on the back burner all year.', 'His side project is on the back burner.'], 40],
  // —— LEARNING ×3（F=30，再认级 → STEP3 语境提取）
  ['a blessing in disguise', '因祸得福', '被裁员那天你觉得天塌了，半年后却感谢那次离开。', 'a blessing (n. 福分) + in disguise ( prep. 伪装中)', 'something bad that turns out good', 'Losing that job turned out to be ___.', ['The delay was a blessing in disguise.', 'Missing the flight was a blessing in disguise.', 'It felt awful, but it was a blessing in disguise.'], 35],
  ['cut corners', '偷工减料', '为了赶工期，他们跳过了所有测试——后来全崩了。', 'cut (v. 切) + corners (n. 拐角)', 'do something the cheap or lazy way', 'If we ___ on testing, users will pay for it.', ['They cut corners to ship on time.', 'Never cut corners on safety.', 'He cut corners and the code broke.'], 33],
  ['the ball is in your court', '轮到你行动了', '方案、报价、时间都给了客户，现在等他们拍板。', 'the ball (n. 球) + is in your court (n. 你的半场)', 'it is your turn to act', 'I\'ve sent the proposal — now ___.', ['The ball is in your court now.', 'I made my offer; the ball is in his court.', 'She said the ball was in my court.'], 30],
  // —— CONSOLIDATING ×2（F=60 → STEP4 限时产出）
  ['break the ice', '打破冷场', '会议室里没人说话，他讲了个自嘲的笑话，气氛活了。', 'break (v. 打破) + the ice (n. 冰)', 'start a conversation in an awkward situation', 'He told a joke to ___ at the meeting.', ['A quick game helped break the ice.', 'She broke the ice with a funny story.', 'Small talk can break the ice.'], 28],
  ['by the book', '照章办事', '他什么都要按流程来，哪怕一个标点都不肯通融。', 'by (prep. 按照) + the book (n. 规章)', 'follow the rules exactly', 'The inspector does everything ___.', ['She always goes by the book.', 'We handled the audit by the book.', 'He refuses to bend the rules; he goes by the book.'], 26],
  // —— INTEGRABLE ×5（F=78 → 凑满 5 个立刻触发 PART_B 批次集成）
  ['call it a day', '收工', '改了八版方案，晚上十点，组长说：今天到此为止。', 'call (v. 宣布) + it a day (n. 一天)', 'decide to stop working', 'It\'s ten p.m. — let\'s ___.', ['We fixed the bug and called it a day.', 'After eight drafts, they called it a day.', 'I\'m exhausted; let\'s call it a day.'], 24],
  ['get cold feet', '临阵退缩', '婚礼前一天，他突然开始怀疑人生。', 'get (v. 变得) + cold feet (n. 冷脚)', 'become too nervous to do something planned', 'He ___ the night before the wedding.', ['She got cold feet before the speech.', 'Don\'t get cold feet now!', 'They got cold feet and cancelled the deal.'], 22],
  ['give the benefit of the doubt', '姑且相信', '他迟到了一小时说地铁坏了——没证据，但先信他一回。', 'give (v. 给予) + the benefit of the doubt (n. 疑点利益)', 'trust someone despite uncertainty', 'I\'ll ___ and assume the train was late.', ['She gave him the benefit of the doubt.', 'Give me the benefit of the doubt this once.', 'The jury gave her the benefit of the doubt.'], 20],
  ['go the extra mile', '多付出一分', '客服不仅退了款，还手写了道歉信寄过来。', 'go (v. 走) + the extra mile (n. 额外一英里)', 'do more than required', 'Great service means ___.', ['She always goes the extra mile for clients.', 'He went the extra mile and wrote a letter.', 'Going the extra mile builds trust.'], 18],
  ['in the nick of time', '千钧一发之际', '火车关门前一秒，他挤进了车厢。', 'in (prep.) + the nick of time (n. 关键时刻)', 'just barely in time', 'The ambulance arrived ___.', ['We caught the train in the nick of time.', 'The email arrived in the nick of time.', 'He submitted the form in the nick of time.'], 16],
  // —— MASTERED ×1（F=85 已集成 → 成熟的维护复习 STEP3 srs）
  ['keep an eye on', '留意照看', '你出门十分钟，拜托邻居看一下炉上的汤。', 'keep (v. 保持) + an eye on (n. 一只眼睛)', 'watch something carefully', 'Could you ___ the soup while I\'m out?', ['Keep an eye on your spending.', 'She keeps an eye on the market.', 'I\'ll keep an eye on the kids.'], 14],
  // —— GRADUATED ×1（永不入队，仅展示在面板里）
  ['once in a blue moon', '千载难逢', '他一年到头吃素，火锅局？百年不遇一回。', 'once (adv. 一次) + in a blue moon (n. 蓝月亮)', 'very rarely', 'He eats hotpot only ___.', ['We meet once in a blue moon.', 'She calls me once in a blue moon.', 'That happens once in a blue moon.'], 12],
];

const order = ['NEW', 'NEW', 'NEW', 'LEARNING', 'LEARNING', 'LEARNING', 'CONSOLIDATING', 'CONSOLIDATING', 'INTEGRABLE', 'INTEGRABLE', 'INTEGRABLE', 'INTEGRABLE', 'INTEGRABLE', 'MASTERED', 'GRADUATED'];

// 幂等：清掉旧演示目标（连词一起）
const old = db.prepare(`SELECT id FROM goals WHERE title = 'Demo · 全题型演示'`).get();
if (old) {
  db.prepare(`DELETE FROM words WHERE goal_id = ?`).run(old.id);
  db.prepare(`DELETE FROM goals WHERE id = ?`).run(old.id);
}

const run = db.transaction(() => {
  const goalId = Number(
    db.prepare(`INSERT INTO goals (type, title, target, created_at) VALUES ('wordlist', 'Demo · 全题型演示', ?, ?)`)
      .run(JSON.stringify({ writing_wpm: 25 }), now).lastInsertRowid
  );
  // 双轴同值写入（演示词不分方向）；成熟度锚点 = 1.5 个半衰期前（L≈0.35：成熟但未跌穿 RELEARN_R）
  const insert = db.prepare(`
    INSERT INTO words (chunk, meaning, scene, slots, substitute, step3_sentence, step4_sentences,
                       fluency, fluency_r, target_in, target_out,
                       stability_tick, stability_time, stability_time_r,
                       last_tick, last_ts, last_ts_r,
                       integrated, graduated, profile, goal_id, freq, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 80, 80, 4, ?, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?, ?)`);
  WORDS.forEach(([chunk, meaning, scene, slots, substitute, s3, s4, freq], i) => {
    const b = BANDS[order[i]];
    const lastTs = b.ripe ? now - b.stability_time * 1.5 : 0;
    insert.run(chunk, meaning, scene, slots, substitute, s3, JSON.stringify(s4),
      b.fluency, b.fluency, b.stability_time, b.stability_time, lastTs, lastTs,
      b.integrated ?? 0, b.graduated ?? 0, goalId, freq, now, now);
  });
  // MASTERED 演示词的终点抬高到 90：F=85 才有缺口，维护复习才派得出来（gap=0 自然退场）
  db.prepare(`UPDATE words SET target_in = 90, target_out = 90 WHERE chunk = 'keep an eye on'`).run();
  // 演示目标设为激活目标：新词引入只看它
  db.prepare(`INSERT INTO meta (key, value) VALUES ('active_goal_id', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(String(goalId));
  return goalId;
});

const goalId = run();
console.log(`✔ 演示目标已创建（id=${goalId}），并设为激活目标`);
console.log('  NEW×3 → STEP12 · LEARNING×3 → STEP3 · CONSOLIDATING×2 → STEP4');
console.log('  INTEGRABLE×5 → PART_B · MASTERED×1 → 维护复习 · GRADUATED×1 → 出队');
console.log('预期出队顺序：PART_B(5词) → LEARNING 的 STEP3 → CONSOLIDATING 的 STEP4 → MASTERED 维护复习 → 3 个 STEP12');
console.log('打开 http://localhost:3000 逐个完成即可看到全部题型（右侧调试面板有档位/F/R）。');
