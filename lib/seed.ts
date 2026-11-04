import type Database from 'better-sqlite3';

const WORDS = [
  {
    chunk: 'deplete mental energy',
    meaning: '耗尽心理能量',
    scene: '晚上十点，你盯着屏幕一个字也看不进去——不是懒，是一天的琐碎决定把电量耗光了。',
    slots: 'deplete (v. 耗尽) + mental (adj. 心理的) + energy (n. 能量)',
    substitute: 'use up energy',
    step3_sentence: 'After ten hours of back-to-back meetings, I had completely ___ by dinner.',
    step4_sentences: [
      'Context switching depletes mental energy faster than deep work does.',
      'By 3 p.m., the meetings had depleted her mental energy.',
      'Every notification depletes your mental energy a little.',
    ],
  },
  {
    chunk: 'remove friction',
    meaning: '消除阻力',
    scene: '想晨跑？前一晚把跑鞋放门口。你什么都没坚持，只是少了一步犹豫。',
    slots: 'remove (v. 移除) + friction (n. 阻力/摩擦)',
    substitute: 'make something easier to start',
    step3_sentence: 'I lay out my gym clothes the night before to ___.',
    step4_sentences: [
      'He laid out his running shoes at night to remove friction.',
      'Good templates remove friction from starting.',
      'Autopay removes friction from saving money.',
    ],
  },
  {
    chunk: 'pay a hidden tax',
    meaning: '付出隐性代价',
    scene: '免费软件不要钱，但它每天用广告和推送向你收税——你付的是注意力。',
    slots: 'pay (v. 支付) + a hidden (adj. 隐性的) + tax (n. 税)',
    substitute: 'pay a cost you cannot see',
    step3_sentence: 'This free app is great, but you ___ with your attention every day.',
    step4_sentences: [
      'Every free app makes you pay a hidden tax with your attention.',
      'Multitasking forces your brain to pay a hidden tax.',
      'Clutter makes you pay a hidden tax every time you search.',
    ],
  },
  {
    chunk: 'offload decisions',
    meaning: '把决策外包出去',
    scene: '天天穿同款黑毛衣不是品味问题，是把"今天穿什么"外包给默认值。',
    slots: 'offload (v. 卸载/外包) + decisions (n. 决策)',
    substitute: 'let something else decide for you',
    step3_sentence: 'I eat the same breakfast every day to ___.',
    step4_sentences: [
      'She wears the same outfit to offload decisions.',
      'Meal prep on Sunday lets you offload decisions all week.',
      'Checklists offload decisions to your past self.',
    ],
  },
  {
    chunk: 'reclaim your attention',
    meaning: '夺回你的注意力',
    scene: '卸载那个刷了三年短视频的 App，第一天你觉得手里空落落的——那是被还回来的时间。',
    slots: 'reclaim (v. 夺回) + your attention (n. 你的注意力)',
    substitute: 'take back your focus',
    step3_sentence: 'I turned off all notifications to ___.',
    step4_sentences: [
      'Turning off badges helped him reclaim his attention.',
      'She deleted the app to reclaim her attention.',
      'A phone-free bedroom helps you reclaim your attention.',
    ],
  },
  {
    chunk: 'build momentum',
    meaning: '积累势头',
    scene: '第一个俯卧撑最难，第五个是顺带的——动作一旦开始，惯性会替你干活。',
    slots: 'build (v. 积累) + momentum (n. 势头/动量)',
    substitute: 'get moving and keep going',
    step3_sentence: 'Starting with a two-minute task helps you ___.',
    step4_sentences: [
      'One push-up is enough to build momentum.',
      'Ship something tiny today to build momentum.',
      'Early wins build momentum for harder tasks.',
    ],
  },
  {
    chunk: 'lower the bar',
    meaning: '降低门槛',
    scene: '把"读一小时书"改成"读一页"——不是目标变小了，是门变矮了，你才肯进。',
    slots: 'lower (v. 降低) + the bar (n. 门槛)',
    substitute: 'make the entry easier',
    step3_sentence: "If you can't start, ___ until it feels trivial.",
    step4_sentences: [
      'He lowered the bar to one page a day.',
      'Lower the bar until starting feels trivial.',
      'She lowered the bar and finally began to write.',
    ],
  },
  {
    chunk: 'guard your mornings',
    meaning: '守住你的早晨',
    scene: '上午九点前的两小时是全天唯一没被世界污染的时间，谁进来谁就是贼。',
    slots: 'guard (v. 守卫) + your mornings (n. 你的早晨)',
    substitute: 'protect your early hours',
    step3_sentence: 'No meetings before 10 a.m. — I ___ for deep work.',
    step4_sentences: [
      'He guards his mornings by banning meetings before ten.',
      'Guard your mornings; the world can wait.',
      'She guards her mornings for writing, not email.',
    ],
  },
];

export function seed(db: Database.Database) {
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO words (chunk, meaning, scene, slots, substitute, step3_sentence, step4_sentences, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAll = db.transaction(() => {
    for (const w of WORDS) {
      stmt.run(
        w.chunk,
        w.meaning,
        w.scene,
        w.slots,
        w.substitute,
        w.step3_sentence,
        JSON.stringify(w.step4_sentences),
        now,
        now
      );
    }
  });
  insertAll();
}
