'use client';

import { useState, type ReactNode } from 'react';
import {
  Mfi,
  PartB,
  Step12,
  Step3,
  Step4,
  Step4R,
  type ResultBody,
  type Word,
} from '@/components/task-cards';

// 练习调试索引：复用流程页的真实练习组件（components/task-cards），
// 喂 mock 数据、不发 API。提交后展示将发往 /api/task/result 的报文。

const mock = (over: Partial<Word> & Pick<Word, 'id' | 'chunk'>): Word => ({
  meaning: '',
  scene: '',
  slots: '',
  substitute: '',
  step3_sentence: '',
  step4_sentences: [],
  fluency: 0,
  fluency_r: 0,
  stability_tick: 4,
  stability_time: 3_600_000,
  stability_time_r: 3_600_000,
  last_tick: 0,
  last_ts: 0,
  last_ts_r: 0,
  integrated: 0,
  graduated: 0,
  band: 'NEW',
  r: 0,
  ...over,
});

const WORD_NEW = mock({
  id: 101,
  chunk: 'bite the bullet',
  meaning: '硬着头皮做（难事）',
  scene: '报告 deadline 就在明早，再不想写也得动手了。',
  slots: 'bite (v. 咬) + the bullet (n. 子弹)',
  substitute: 'grit your teeth and do it',
  step3_sentence: "I hate public speaking, but I'll have to ___ and present tomorrow.",
  step4_sentences: ['She bit the bullet and called the client back.'],
});

const WORD_LEARNING = mock({
  id: 102,
  chunk: 'cut corners',
  meaning: '偷工减料',
  scene: '为了赶工期，他们跳过了所有测试——后来全崩了。',
  slots: 'cut (v. 切) + corners (n. 拐角)',
  substitute: 'do something the cheap or lazy way',
  step3_sentence: 'If we ___ on testing, users will pay for it.',
  step4_sentences: ['They cut corners to ship on time.'],
  fluency: 30,
  fluency_r: 60, // P 练习的迁移托底（知识确认线 60，读速未实测）
  band: 'LEARNING',
  r: 0.6,
});

const WORD_MASTERED = mock({
  id: 103,
  chunk: 'keep an eye on',
  meaning: '留意照看',
  slots: 'keep (v. 保持) + an eye on (n. 一只眼睛)',
  substitute: 'watch something carefully',
  step3_sentence: "Could you ___ the soup while I'm out?",
  step4_sentences: ['Keep an eye on your spending.'],
  fluency: 85,
  fluency_r: 82,
  integrated: 1,
  band: 'MASTERED',
  r: 0.4,
});

const WORD_CONSOLIDATING = mock({
  id: 104,
  chunk: 'break the ice',
  meaning: '打破冷场',
  scene: '会议室里没人说话，他讲了个自嘲的笑话，气氛活了。',
  slots: 'break (v. 打破) + the ice (n. 冰)',
  substitute: 'start a conversation in an awkward situation',
  step3_sentence: 'He told a joke to ___ at the meeting.',
  step4_sentences: [
    'A quick game helped break the ice.',
    'She broke the ice with a funny story.',
    'Small talk can break the ice.',
  ],
  fluency: 60,
  fluency_r: 55,
  band: 'CONSOLIDATING',
  r: 0.5,
});

const PART_B_WORDS = [
  ['call it a day', '收工', "It's ten p.m. — let's call it a day."],
  ['get cold feet', '临阵退缩', 'He got cold feet the night before the wedding.'],
  ['give the benefit of the doubt', '姑且相信', "I'll give him the benefit of the doubt."],
  ['go the extra mile', '多付出一分', 'She always goes the extra mile for clients.'],
  ['in the nick of time', '千钧一发之际', 'The ambulance arrived in the nick of time.'],
].map(([chunk, meaning, s1], i) =>
  mock({
    id: 200 + i,
    chunk,
    meaning,
    step4_sentences: [s1],
    fluency: 78,
    fluency_r: 78,
    band: 'INTEGRABLE',
    r: 0.3,
  })
);

// 单个演示位：包住真实组件，捕获提交报文，支持重置重来
function Exercise({
  title,
  note,
  render,
}: {
  title: string;
  note: string;
  render: (onDone: (b: ResultBody) => void) => ReactNode;
}) {
  const [payload, setPayload] = useState<ResultBody | null>(null);
  const [nonce, setNonce] = useState(0);

  return (
    <section style={{ marginBottom: 32 }}>
      <h2 style={{ fontSize: 16, margin: '0 0 4px' }}>{title}</h2>
      <p className="muted" style={{ margin: '0 0 8px' }}>
        {note}
      </p>
      <div key={nonce}>{render(setPayload)}</div>
      {payload && (
        <div className="card" style={{ marginTop: 8 }}>
          <div className="badge">onDone 报文（POST /api/task/result 的 body）</div>
          <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>
            {JSON.stringify(payload, null, 2)}
          </pre>
          <button
            className="ghost"
            onClick={() => {
              setPayload(null);
              setNonce((n) => n + 1);
            }}
          >
            重置此练习
          </button>
        </div>
      )}
    </section>
  );
}

export default function DemoPage() {
  return (
    <div className="page">
      <header>
        <h1>练习 Demo · 全题型索引</h1>
        <a href="/">← 返回练习</a>
        <a href="/task-preview">查看分数任务页面 →</a>
      </header>
      <p className="muted">
        本页复用流程中的真实练习组件（@/components/task-cards），喂 mock 数据、不碰真实队列。
        完成任意练习即可看到它将提交的报文；改组件代码，流程页和本页同时生效。
      </p>

      <Exercise
        title="STEP12 · 新词引入（NEW → LEARNING）"
        note="画面 + 槽位盲敲。可测：错位槽位提示、显示答案（hint 标记）、完成后的 latency 上报。"
        render={(onDone) => <Step12 word={WORD_NEW} onDone={onDone} />}
      />

      <Exercise
        title="STEP3 · 语境提取（LEARNING，F=30）"
        note="挖空句回填。可测：答对提交（带 latency）、答错进入当场补救（记 fail）。"
        render={(onDone) => <Step3 word={WORD_LEARNING} srsReview={false} onDone={onDone} />}
      />

      <Exercise
        title="STEP3 · 维护复习（MASTERED，F=85）"
        note="同 STEP3，但 srsReview=true，badge 显示「维护复习」——毕业判定就发生在这种任务上。"
        render={(onDone) => <Step3 word={WORD_MASTERED} srsReview={true} onDone={onDone} />}
      />

      <Exercise
        title="STEP4 · 限时产出（CONSOLIDATING，F=60）"
        note="倒计时写作 + 对照自评。可测：预算耗尽自动停笔、wordsProduced/latencyMs 上报、通过/失败分支。"
        render={(onDone) => (
          <Step4 word={WORD_CONSOLIDATING} timeBudgetMs={45_000} onDone={onDone} />
        )}
      />

      <Exercise
        title="STEP4R · 限时速读（CONSOLIDATING，F=60）"
        note="三个场景限时读 + 理解自评。可测：倒计时超时不停表、wpm 实测展示、读懂/没读懂分支。"
        render={(onDone) => (
          <Step4R word={WORD_CONSOLIDATING} timeBudgetMs={10_000} onDone={onDone} />
        )}
      />

      <Exercise
        title="MFI · 可理解输入（书源篇章 + 主旨三选一）"
        note="150–300 词连续篇章限时通读 + 主旨题。可测：超时不停表、wpm 实测、答对/答错分支（pass = 选对主旨）。"
        render={(onDone) => (
          <Mfi
            word={WORD_CONSOLIDATING}
            passage="The conference room fell silent as everyone stared at their laptops. Nobody wanted to be the first to speak. Then Marcus leaned back in his chair and told a self-deprecating joke about his own presentation disaster last year. The tension cracked. People laughed, shoulders relaxed, and within minutes the team was tossing ideas around like old friends. Later, the manager pulled Marcus aside and thanked him. She said that one small moment of humor had done more for the meeting than an hour of careful facilitation ever could. He shrugged and said someone had to do it."
            passageWords={96}
            options={[
              'A well-timed joke from Marcus broke the tension and got the team talking.',
              'The manager criticized Marcus for telling jokes during a serious meeting.',
              'The team spent an hour carefully planning how to facilitate the meeting.',
            ]}
            answerIndex={0}
            timeBudgetMs={38_000}
            onDone={onDone}
          />
        )}
      />

      <Exercise
        title="PART_B · 批次集成（INTEGRABLE ×5）"
        note="5 词微文复述。可测：全部通过（集成认证）、指定卡壳词（missedWordId）。"
        render={(onDone) => <PartB words={PART_B_WORDS} onDone={onDone} />}
      />
    </div>
  );
}
