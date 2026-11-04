'use client';

import { useCallback, useEffect, useState } from 'react';
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

type Task =
  | { kind: 'STEP12'; word: Word; relearn?: boolean }
  | { kind: 'STEP3'; word: Word; srsReview: boolean }
  | { kind: 'STEP4'; word: Word; timeBudgetMs: number }
  | { kind: 'STEP4R'; word: Word; timeBudgetMs: number }
  | {
      kind: 'MFI';
      word: Word;
      passage: string;
      passageWords: number;
      options: string[];
      answerIndex: number;
      timeBudgetMs: number;
    }
  | { kind: 'PART_B'; words: Word[] }
  | { kind: 'EMPTY'; nextAvailableInMs: number | null };

type EventRow = {
  id: number;
  tick: number;
  ts: number;
  kind: string;
  word_id: number | null;
  result: string | null;
  detail: string | null;
};

type Snapshot = {
  task: Task;
  tick: number;
  words: Word[];
  events: EventRow[];
  vocabEstimate: number | null;
  activeGoalId: number | null;
  goalScopeStrict: boolean;
  goalFluency: number | null;
  goalFluencyR: number | null;
  goalFluencyP: number | null;
  goalAttainment: number | null;
  userLevel: { estimate: number; label: string; ielts: string } | null;
  cursorWritingWpm: number;
  cursorReadingWpm: number;
};

type GoalOption = { id: number; title: string };

export default function Home() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [goals, setGoals] = useState<GoalOption[]>([]);

  const load = useCallback(async () => {
    const res = await fetch('/api/task', { cache: 'no-store' });
    setData(await res.json());
  }, []);

  useEffect(() => {
    load();
    fetch('/api/goals', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setGoals(d.goals));
  }, [load]);

  const setActiveGoal = useCallback(
    async (goalId: number | null, strict?: boolean) => {
      await fetch('/api/goals/active', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goalId, strict }),
      });
      load();
    },
    [load]
  );

  const postResult = useCallback(async (body: ResultBody) => {
    const res = await fetch('/api/task/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    setData(await res.json());
  }, []);

  if (!data) return <div className="page">加载中…</div>;

  return (
    <div className="page">
      <header>
        <h1>Flow · 流利度驱动调度</h1>
        <span className="tick">global_tick = {data.tick}</span>
        {data.goalFluency != null && (
          <span
            className="muted"
            title="headline = 每词 min(F_R, F_P) 的词频加权均值；括号为读/写拆分（展示指标）；达成 = 双轴均达个人目标的词频加权占比"
          >
            目标流利度 F̄ = {data.goalFluency}
            {data.goalFluencyR != null &&
              data.goalFluencyP != null &&
              `（读 ${data.goalFluencyR} / 写 ${data.goalFluencyP}）`}
            {data.goalAttainment != null && ` · 达成 ${(data.goalAttainment * 100).toFixed(0)}%`}
          </span>
        )}
        <select
          value={data.activeGoalId ?? ''}
          onChange={(e) => setActiveGoal(e.target.value ? Number(e.target.value) : null)}
          style={{ width: 'auto', margin: 0 }}
        >
          <option value="">全部目标</option>
          {goals.map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </select>
        {data.activeGoalId != null && (
          <label
            className="muted"
            style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}
            title="开启后，复习任务也只出当前目标的词；其他目标的在学词将暂停复习"
          >
            <input
              type="checkbox"
              checked={data.goalScopeStrict}
              onChange={(e) => setActiveGoal(data.activeGoalId, e.target.checked)}
            />
            只学当前目标
          </label>
        )}
        <a href="/assess">测词汇量</a>
        <a href="/goals">目标管理</a>
        <a href="/demo">练习 Demo</a>
      </header>
      <div className="layout">
        <div>
          {data.task.kind === 'EMPTY' && (
            <div className="card">
              <div className="badge warn">队列清空</div>
              <p>
                没有成熟的词值得重测了。所有词要么已毕业，要么可提取度还太高——
                系统不会提前 drilling（那只是在刷短时缓存）。
              </p>
              {data.task.nextAvailableInMs != null && (
                <p className="muted">
                  最近一个词约在 {Math.ceil(data.task.nextAvailableInMs / 1000)} 秒后成熟，休息一下。
                </p>
              )}
              <button onClick={load}>刷新</button>
            </div>
          )}
          {data.task.kind === 'STEP12' && (
            <Step12 key={data.tick} word={data.task.word} relearn={data.task.relearn} onDone={postResult} />
          )}
          {data.task.kind === 'STEP3' && (
            <Step3
              key={data.tick}
              word={data.task.word}
              srsReview={data.task.srsReview}
              onDone={postResult}
            />
          )}
          {data.task.kind === 'STEP4' && (
            <Step4
              key={data.tick}
              word={data.task.word}
              timeBudgetMs={data.task.timeBudgetMs}
              onDone={postResult}
            />
          )}
          {data.task.kind === 'STEP4R' && (
            <Step4R
              key={data.tick}
              word={data.task.word}
              timeBudgetMs={data.task.timeBudgetMs}
              onDone={postResult}
            />
          )}
          {data.task.kind === 'MFI' && (
            <Mfi
              key={data.tick}
              word={data.task.word}
              passage={data.task.passage}
              passageWords={data.task.passageWords}
              options={data.task.options}
              answerIndex={data.task.answerIndex}
              timeBudgetMs={data.task.timeBudgetMs}
              onDone={postResult}
            />
          )}
          {data.task.kind === 'PART_B' && (
            <PartB key={data.tick} words={data.task.words} onDone={postResult} />
          )}
        </div>
        <DebugPanel
          words={data.words}
          events={data.events}
          vocabEstimate={data.vocabEstimate}
          userLevel={data.userLevel}
          cursorWritingWpm={data.cursorWritingWpm}
          cursorReadingWpm={data.cursorReadingWpm}
        />
      </div>
    </div>
  );
}

const BAND_LABEL: Record<Word['band'], string> = {
  NEW: '未学',
  LEARNING: '再认',
  CONSOLIDATING: '巩固',
  INTEGRABLE: '待集成',
  MASTERED: '掌握',
  GRADUATED: '毕业',
};

function DebugPanel({
  words,
  events,
  vocabEstimate,
  userLevel,
  cursorWritingWpm,
  cursorReadingWpm,
}: {
  words: Word[];
  events: EventRow[];
  vocabEstimate: number | null;
  userLevel: Snapshot['userLevel'];
  cursorWritingWpm: number;
  cursorReadingWpm: number;
}) {
  const fmtH = (ms: number) =>
    ms >= 86_400_000 ? `${(ms / 86_400_000).toFixed(0)}d` : `${(ms / 3_600_000).toFixed(1)}h`;
  return (
    <div className="card">
      <div className="muted" style={{ marginBottom: 8 }}>
        流利度快照
        {vocabEstimate != null && ` · 词汇量 ≈ ${vocabEstimate.toLocaleString()}`}
        {userLevel && ` · 水平 ≈ ${userLevel.estimate.toLocaleString()}（${userLevel.label}）`}
        {` · 写作游标 ${cursorWritingWpm} wpm · 阅读游标 ${cursorReadingWpm} wpm`}
      </div>
      <table>
        <thead>
          <tr>
            <th>语块</th>
            <th>档位</th>
            <th>F写/读</th>
            <th>R写/读</th>
            <th>C缓存</th>
            <th>H_time写/读</th>
          </tr>
        </thead>
        <tbody>
          {words.map((w) => (
            <tr key={w.id}>
              <td>{w.chunk}</td>
              <td className="state">{BAND_LABEL[w.band]}</td>
              <td>
                {w.fluency.toFixed(0)}/{w.fluency_r.toFixed(0)}
              </td>
              <td>
                {w.band === 'NEW'
                  ? '·'
                  : `${w.r.toFixed(2)}/${(w.r_r ?? w.r).toFixed(2)}`}
              </td>
              <td>{w.band === 'NEW' ? '·' : (w.c ?? 0).toFixed(2)}</td>
              <td>
                {w.band === 'NEW' ? '·' : `${fmtH(w.stability_time)}/${fmtH(w.stability_time_r)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="events">
        {events.map((e) => (
          <div key={e.id}>
            <span className="muted">t{e.tick}</span> {e.kind}
            {e.word_id != null && ` w${e.word_id}`}{' '}
            {e.result && <span className={e.result}>{e.result}</span>}
            {e.detail && <span className="muted"> {e.detail}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
