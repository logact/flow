'use client';

import { useState } from 'react';
import styles from './page.module.css';

type Axis = 'R' | 'P';
type Band = {
  range: string;
  score: number;
  title: string;
  subtitle: string;
  evidence: string;
  readingPace?: number;
  writingPace?: number;
};

const bands: Band[] = [
  { range: '00—19', score: 12, title: '初次接触', subtitle: '先看清形式与意思', evidence: '观看不计分' },
  { range: '20—34', score: 27, title: '辨认形式', subtitle: '从少量选项中独立辨认', evidence: '未测速作答 · 最多 55 分' },
  { range: '35—49', score: 43, title: '语境提取', subtitle: '撤掉答案，在句中理解或写出', evidence: '独立正确 · 本次 55 分' },
  { range: '50—59', score: 55, title: '速度起点', subtitle: '首次验证连贯读写的速度', evidence: '按实测速度计分', readingPace: 150, writingPace: 25 },
  { range: '60—74', score: 68, title: '稳定提速', subtitle: '保持理解，逐步提高速度', evidence: '按实测速度计分', readingPace: 180, writingPace: 32 },
  { range: '75—89', score: 82, title: '跨语境使用', subtitle: '在更长材料中处理目标词', evidence: '逐词归属证据', readingPace: 230, writingPace: 46 },
  { range: '90—100', score: 94, title: '自然维持', subtitle: '在目标速度下处理新材料', evidence: '持续复查速度与理解', readingPace: 280, writingPace: 56 },
];

const readingPassage = [
  'The meeting had been quiet for nearly twenty minutes. Everyone understood the problem, but nobody wanted to speak first. Maya noticed the tension and told a short story about her first day on the team. Her mistake was small, but everyone laughed because they had made the same one.',
  'That little story helped break the ice. People began asking questions, sharing ideas, and disagreeing without feeling awkward. By the end of the meeting, the team had a plan that nobody could have made alone.',
];

const contextSentence = 'The room was silent until Maya told a joke to break the ice.';
const passageWordCount = readingPassage.join(' ').trim().split(/\s+/).length;

function paceAttempt(axis: Axis, wpm: number) {
  const floor = axis === 'R' ? 150 : 25;
  const ceiling = axis === 'R' ? 300 : 60;
  return Math.min(100, wpm < floor ? 60 * wpm / floor : 60 + 40 * (wpm - floor) / (ceiling - floor));
}

function formatScore(value: number) {
  return value.toString().padStart(2, '0');
}

function TaskStage({ axis, band }: { axis: Axis; band: Band }) {
  const [phase, setPhase] = useState<'ready' | 'working' | 'check' | 'done'>('ready');
  const [answer, setAnswer] = useState('');
  const [choice, setChoice] = useState<number | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [passed, setPassed] = useState<boolean | null>(null);
  const [result, setResult] = useState<{ attempt: number; next: number; note: string } | null>(null);
  const isReading = axis === 'R';
  const pace = isReading ? band.readingPace : band.writingPace;

  const finishReading = () => {
    setElapsed(startedAt == null ? null : Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
    setPhase('check');
  };

  const record = (correct: boolean, attempt: number, note: string) => {
    const next = 0.6 * band.score + 0.4 * (correct ? attempt : 0);
    setPassed(correct);
    setResult({ attempt: correct ? attempt : 0, next, note });
    setPhase('done');
  };

  const feedback = passed === null ? null : (
    <div className={`${styles.feedback} ${passed ? styles.feedbackPass : styles.feedbackFail}`} role="status">
      <span className={styles.feedbackIcon}>{passed ? '✓' : '↗'}</span>
      <div>
        <strong>{passed ? '这次完成了独立作答' : '这次还需要巩固'}</strong>
        {result && <div className={styles.scoreOutcome}><span>{band.score.toFixed(1)}</span><span>→</span><strong>{result.next.toFixed(1)}</strong><em>{result.next >= band.score ? `+${(result.next - band.score).toFixed(1)}` : (result.next - band.score).toFixed(1)}</em></div>}
        <p>{result?.note} · 本次表现 {result?.attempt.toFixed(1)} 分</p>
      </div>
    </div>
  );

  if (band.score < 20) {
    return (
      <div className={styles.stageBody}>
        <div className={styles.promptMeta}>01 / 建立联系 · 展示阶段</div>
        <div className={styles.studyWord}>break the ice</div>
        <p className={styles.definition}>打破冷场，让一群人开始轻松交谈</p>
        <div className={styles.example}><span>语境</span> Maya told a joke to <b>break the ice</b> at the meeting.</div>
        {isReading ? (
          <p className={styles.instruction}>先把词形、含义和场景联系起来。下一屏会遮住释义，请你独立辨认。</p>
        ) : (
          <p className={styles.instruction}>先观察拼写和用法。下一屏会遮住英文，请你根据意思自己写出。</p>
        )}
        <button className={styles.primaryButton} onClick={() => setPhase('done')}>
          {phase === 'done' ? '已看过 · 下一步做独立作答' : '看清楚了，继续'} <span>→</span>
        </button>
        <div className={styles.stageFoot}>观看不作为计分尝试。真实教学完成时按核心算法初始化该轴：读轴 8 分；写轴独立完成形式检查 15 分、借助提示完成 8 分。</div>
      </div>
    );
  }

  if (band.score < 35 && isReading) {
    const options = ['让场面不再尴尬', '结束一场讨论', '故意回避问题'];
    return (
      <div className={styles.stageBody}>
        <div className={styles.promptMeta}>02 / 辨认形式 · 不展示答案</div>
        <h2 className={styles.question}>你认识这个表达吗？</h2>
        <div className={styles.focusWord}>break the ice</div>
        <div className={styles.choiceList}>
          {options.map((option, index) => (
            <button key={option} className={`${styles.choice} ${choice === index ? styles.choiceSelected : ''}`} onClick={() => setChoice(index)} disabled={phase === 'done'}>
              <span>{String.fromCharCode(65 + index)}</span>{option}
            </button>
          ))}
        </div>
        <button className={styles.primaryButton} disabled={choice === null || phase === 'done'} onClick={() => record(choice === 0, 55, choice === 0 ? '独立辨认正确；未测速' : '首次独立辨认错误')}>确认答案 <span>→</span></button>
        {feedback}
      </div>
    );
  }

  if (band.score < 35) {
    return (
      <div className={styles.stageBody}>
        <div className={styles.promptMeta}>02 / 辅助写出 · 部分形式提示</div>
        <h2 className={styles.question}>根据意思补出表达</h2>
        <p className={styles.definition}>打破冷场，让大家开始交谈</p>
        <div className={styles.letterCue}>b _ _ _ k &nbsp; t h e &nbsp; i _ e</div>
        <label className={styles.fieldLabel} htmlFor="write-guided">写出完整表达</label>
        <input id="write-guided" className={styles.textInput} value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={phase === 'done'} placeholder="输入英文表达" autoComplete="off" />
        <button className={styles.primaryButton} disabled={!answer.trim() || phase === 'done'} onClick={() => record(answer.trim().toLowerCase() === 'break the ice', 27.5, '已给部分字母提示；正确按 0.5 × 55 计')}>确认答案 <span>→</span></button>
        {feedback}
      </div>
    );
  }

  if (band.score < 50 && isReading) {
    const options = ['她用笑话缓和了气氛', '她提前结束了会议', '她让所有人保持安静'];
    return (
      <div className={styles.stageBody}>
        <div className={styles.promptMeta}>03 / 语境识别 · 独立理解</div>
        <h2 className={styles.question}>这句话里发生了什么？</h2>
        <blockquote className={styles.sentence}>“{contextSentence}”</blockquote>
        <div className={styles.choiceList}>
          {options.map((option, index) => (
            <button key={option} className={`${styles.choice} ${choice === index ? styles.choiceSelected : ''}`} onClick={() => setChoice(index)} disabled={phase === 'done'}>
              <span>{String.fromCharCode(65 + index)}</span>{option}
            </button>
          ))}
        </div>
        <button className={styles.primaryButton} disabled={choice === null || phase === 'done'} onClick={() => record(choice === 0, 55, '独立理解句中含义')}>确认理解 <span>→</span></button>
        {feedback}
      </div>
    );
  }

  if (band.score < 50) {
    return (
      <div className={styles.stageBody}>
        <div className={styles.promptMeta}>03 / 语境产出 · 独立回忆</div>
        <h2 className={styles.question}>写出能完成句子的表达</h2>
        <p className={styles.definition}>提示：她讲了个笑话，缓和了会议开始时的尴尬。</p>
        <blockquote className={styles.sentence}>Maya told a joke to ______ at the meeting.</blockquote>
        <label className={styles.fieldLabel} htmlFor="write-context">你的答案</label>
        <input id="write-context" className={styles.textInput} value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={phase === 'done'} placeholder="不显示首字母和拼写提示" autoComplete="off" />
        <button className={styles.primaryButton} disabled={!answer.trim() || phase === 'done'} onClick={() => record(answer.trim().toLowerCase() === 'break the ice', 55, '无拼写提示的语境产出')}>提交表达 <span>→</span></button>
        {feedback}
      </div>
    );
  }

  if (isReading) {
    const harder = band.score >= 75;
    const options = ['一个故事让会议中的人开始自在交流', '会议因争论而提前结束', '团队决定由 Maya 独自制定计划'];
    return (
      <div className={styles.stageBody}>
        <div className={styles.promptMeta}>04 / 连续阅读 · {harder ? '新语境迁移' : '速度与理解'}</div>
        <div className={styles.taskHeading}>
          <div><h2 className={styles.question}>读完这段，再回答两个问题</h2><p className={styles.instruction}>先理解内容；阅读结束后才出现问题。</p></div>
          <div className={styles.paceChip}><strong>{pace}</strong><span>目标 WPM</span></div>
        </div>
        {phase === 'ready' ? (
          <div className={styles.readReady}><div className={styles.readReadyIcon}>↗</div><p>点击开始后显示完整篇章并计时。请按平常的方式连续阅读。</p><button className={styles.primaryButton} onClick={() => { setStartedAt(Date.now()); setPhase('working'); }}>开始阅读 <span>→</span></button></div>
        ) : (
          <>
            <div className={styles.passage}>{readingPassage.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}</div>
            {phase === 'working' && <button className={styles.primaryButton} onClick={finishReading}>我读完了，回答问题 <span>→</span></button>}
            {(phase === 'check' || phase === 'done') && <>
              <div className={styles.questionBlock}><span>理解整段</span><p>是什么让会议中的人开始交流？</p></div>
              <div className={styles.choiceList}>{options.map((option, index) => <button key={option} className={`${styles.choice} ${choice === index ? styles.choiceSelected : ''}`} onClick={() => setChoice(index)} disabled={phase === 'done'}><span>{String.fromCharCode(65 + index)}</span>{option}</button>)}</div>
              <div className={styles.questionBlock}><span>理解目标词</span><p>文中的 “break the ice” 指什么？</p></div>
              <input className={styles.textInput} value={answer} onChange={(e) => setAnswer(e.target.value)} disabled={phase === 'done'} placeholder="用中文解释它在这一段中的意思" />
              <button className={styles.primaryButton} disabled={choice === null || !answer.trim() || phase === 'done'} onClick={() => {
                const targetCorrect = /冷场|缓和|尴尬|交谈|交流|气氛/.test(answer);
                const passageCorrect = choice === 0;
                const wpm = elapsed ? passageWordCount * 60 / elapsed : 0;
                record(targetCorrect && passageCorrect, paceAttempt('R', wpm),
                  targetCorrect ? passageCorrect ? `整段与目标词通过，阅读约 ${Math.round(wpm)} WPM` : '整段理解未通过；按本次阅读失败计分' : '目标词未正确理解');
              }}>提交理解 <span>→</span></button>
              {phase === 'done' && <p className={styles.stageFoot}>阅读用时 {elapsed ?? '—'} 秒。本原型用关键词演示目标词检查；真实计分需核验答案语义及有效阅读速度。</p>}
              {feedback}
            </>}
          </>
        )}
      </div>
    );
  }

  return (
    <div className={styles.stageBody}>
      <div className={styles.promptMeta}>04 / 连续写作 · {band.score >= 75 ? '自然表达' : '速度与用法'}</div>
      <div className={styles.taskHeading}>
        <div><h2 className={styles.question}>写一段真实的表达</h2><p className={styles.instruction}>用 “break the ice” 写出会议开始时的场景。写完后检查意思和用法。</p></div>
        <div className={styles.paceChip}><strong>{pace}</strong><span>目标 WPM</span></div>
      </div>
      <div className={styles.writingPrompt}><span>写作情景</span><p>新团队第一次开会，大家有些拘谨。描述一个让讨论自然开始的小动作，以及之后发生的变化。</p></div>
      <textarea className={styles.textarea} value={answer} onChange={(e) => { if (startedAt === null) setStartedAt(Date.now()); setAnswer(e.target.value); }} disabled={phase === 'done'} placeholder="Start writing here…" rows={8} />
      <div className={styles.wordMeta}><span>从第一次输入开始计时</span><span>{answer.trim() ? answer.trim().split(/\s+/).length : 0} words</span></div>
      <button className={styles.primaryButton} disabled={!answer.trim() || phase === 'done'} onClick={() => {
        const seconds = startedAt == null ? 0 : Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        const words = answer.trim().split(/\s+/).length;
        const wpm = seconds ? words * 60 / seconds : 0;
        setElapsed(seconds);
        record(answer.toLowerCase().includes('break the ice'), paceAttempt('P', wpm), `原型仅按是否包含目标表达及约 ${Math.round(wpm)} WPM 演示`);
      }}>完成写作 <span>→</span></button>
      {phase === 'done' && <p className={styles.stageFoot}>写作用时 {elapsed ?? '—'} 秒。本原型仅检查是否包含目标表达；真实任务还需核验语义、语法和整段质量后才能计分。</p>}
      {feedback}
    </div>
  );
}

export default function TaskPreviewPage() {
  const [axis, setAxis] = useState<Axis>('R');
  const [selectedBand, setSelectedBand] = useState(0);
  const band = bands[selectedBand];
  const pace = axis === 'R' ? band.readingPace : band.writingPace;

  return (
    <div className={styles.shell}>
      <div className={styles.topbar}><a className={styles.brand} href="/">flow<span className={styles.brandDot}>.</span></a><div className={styles.topLinks}><span>任务页面原型</span><a href="/demo">现有题型 ↗</a></div></div>
      <main className={styles.layout}>
        <aside className={styles.sidebar} aria-label="分数段">
          <div className={styles.sidebarHeading}><span>LEARNING PATH</span><h1>从看懂，<br />到自然使用。</h1><p>选择一条轴和当前分数，查看用户真正会遇到的任务页面。</p></div>
          <div className={styles.axisSwitch} role="group" aria-label="练习方向"><button className={axis === 'R' ? styles.axisActive : ''} onClick={() => setAxis('R')}>阅读 · R</button><button className={axis === 'P' ? styles.axisActive : ''} onClick={() => setAxis('P')}>写作 · P</button></div>
          <div className={styles.bandList}>{bands.map((item, index) => <button key={item.range} className={`${styles.bandButton} ${selectedBand === index ? styles.bandActive : ''}`} onClick={() => setSelectedBand(index)} aria-current={selectedBand === index ? 'step' : undefined}><span className={styles.bandRange}>{item.range}</span><span className={styles.bandTitle}>{item.title}</span><span className={styles.bandArrow}>↗</span></button>)}</div>
          <div className={styles.sidebarNote}>计分按核心算法文档：新分 = 60% 当前分 + 40% 本次表现分。当前规范按证据方式计分，未给不同题型单独规定 35 分上限。</div>
        </aside>

        <section className={styles.mainColumn}>
          <div className={styles.pageHeading}><div><div className={styles.eyebrow}>TASK EXPERIENCE / {axis === 'R' ? 'READING' : 'WRITING'}</div><h2>{band.title}</h2><p>{band.subtitle}</p></div><div className={styles.scoreBadge}><span>当前分数</span><strong>{formatScore(band.score)}</strong><small>/ 100</small></div></div>
          <div className={styles.progressTrack}><div style={{ width: `${band.score}%` }} /></div>
          <div className={styles.progressLabels}><span>看与辨认</span><span>60 分 · {axis === 'R' ? '150 WPM 阅读' : '25 WPM 写作'}</span><span>目标熟练度</span></div>
          <article className={styles.taskCard}><div className={styles.taskCardTop}><div className={styles.taskTag}><span className={styles.liveDot} />{axis === 'R' ? '阅读任务' : '写作任务'}<span className={styles.tagDivider}>/</span>{band.range} 分</div><span className={styles.taskNumber}>01 / 01</span></div><TaskStage key={`${axis}-${selectedBand}`} axis={axis} band={band} /></article>
          <div className={styles.belowCard}><span>DESIGN NOTE</span><p>{selectedBand === 0 ? '看词和看示范只负责建立联系。完成后还要独立认出或写出，才会产生分数证据。' : selectedBand < 3 ? '选择、补全和独立提取各有不同的提示量与证据上限；单题反应时间不换算成篇章 WPM。' : '速度只从连续材料中测量。阅读检查整段与目标词；写作检查用词与整体表达。'}</p></div>
        </section>

        <aside className={styles.detailPanel}><div className={styles.detailKicker}>本档任务规则</div><h3>{axis === 'R' ? '阅读轴' : '写作轴'} · {band.range}</h3><p>{band.subtitle}</p><div className={styles.detailRule}><span>任务证据</span><strong>{axis === 'P' && selectedBand === 1 ? '提示后正确 · 本次 27.5 分' : band.evidence}</strong></div><div className={styles.detailRule}><span>速度要求</span><strong>{pace ? `${pace} WPM 演示档` : '不以 WPM 计分'}</strong></div><div className={styles.detailRule}><span>完成条件</span><strong>{selectedBand === 0 ? '进入独立作答' : selectedBand < 3 ? '首次独立答案' : axis === 'R' ? '词义 + 整段理解' : '词义 + 整段表达'}</strong></div><div className={styles.ruleCallout}><span>↗</span><p>每次计分：新分 = 0.6 × 当前分 + 0.4 × 本次表现分。错误的本次表现分为 0。</p></div><div className={styles.detailFoot}>界面原型 · 使用示例词与示例内容 · 计分公式遵循核心算法文档</div></aside>
      </main>
    </div>
  );
}
