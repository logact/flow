'use client';

import { useEffect, useRef, useState } from 'react';

// 流程页与 /demo 演示页共用的练习组件——改这里，两边同时生效。

export type Word = {
  id: number;
  chunk: string;
  meaning: string;
  scene: string;
  slots: string;
  substitute: string;
  step3_sentence: string;
  step4_sentences: string[];
  fluency: number; // F_P 产出（写作）
  fluency_r: number; // F_R 接受（阅读）；headline F = min
  target_in?: number; // 阅读方向个人终点
  target_out?: number; // 产出方向个人终点
  stability_tick: number;
  stability_time: number; // H_time_P
  stability_time_r: number; // H_time_R
  last_tick: number;
  last_ts: number;
  last_ts_r: number;
  integrated: number;
  graduated: number;
  band: 'NEW' | 'LEARNING' | 'CONSOLIDATING' | 'INTEGRABLE' | 'MASTERED' | 'GRADUATED';
  r: number;
  r_r?: number;
  c?: number; // 短时缓存残留（双通道并联）
};

export type ResultBody = {
  kind: 'STEP12' | 'STEP3' | 'STEP4' | 'STEP4R' | 'MFI' | 'PART_B';
  wordIds: number[];
  pass: boolean;
  srsReview?: boolean;
  missedWordId?: number;
  latencyMs?: number;
  wordsProduced?: number;
  wordsRead?: number; // MFI 篇章词数（实测阅读 wpm）
  hint?: boolean;
};

// NFKC 归一化把全角字符（中文输入法常见）折成半角，再统一大小写与空白
const norm = (s: string) =>
  s
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?。，；：！？]+$/, '');

// 返回第一个不匹配的词（槽位）下标，全对返回 null
const firstWrongWord = (input: string, target: string): number | null => {
  const a = norm(input).split(' ');
  const b = norm(target).split(' ');
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return null;
};

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

export function Step12({
  word,
  relearn,
  onDone,
}: {
  word: Word;
  relearn?: boolean;
  onDone: (b: ResultBody) => void;
}) {
  const [phase, setPhase] = useState<'study' | 'type'>('study');
  const [input, setInput] = useState('');
  const [revealed, setRevealed] = useState(false);
  const startRef = useRef(0);
  const matched = norm(input) === norm(word.chunk);
  // 敲到目标长度后才给错位提示，避免打字途中噪音
  const wrongIdx =
    !matched && norm(input).length >= norm(word.chunk).length
      ? firstWrongWord(input, word.chunk)
      : null;

  return (
    <div className="card">
      <div className="badge">
        {relearn ? 'Step 1+2 · 重编码（逾期过久，重新引入）' : 'Step 1+2 · 新词引入（画面 + 槽位盲敲）'}
      </div>
      <div className="scene">{word.scene}</div>
      <div className="muted">{word.meaning}</div>
      {phase === 'study' ? (
        <>
          <div className="chunk">{word.chunk}</div>
          <div className="mono muted">{word.slots}</div>
          <p className="muted">看清槽位结构，然后遮住它盲敲。</p>
          <button
            className="primary"
            onClick={() => {
              startRef.current = Date.now();
              setPhase('type');
            }}
          >
            我记住了，开始盲敲
          </button>
        </>
      ) : (
        <>
          <div className="mono muted">{word.slots}</div>
          {revealed && <div className="chunk">{word.chunk}</div>}
          <input
            type="text"
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="凭记忆敲出语块…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          {wrongIdx != null && (
            <div className="fail">
              还不对——第 {wrongIdx + 1} 个槽位开始不匹配（对照上面的槽位结构检查）。
            </div>
          )}
          <button
            className="primary"
            disabled={!matched}
            onClick={() =>
              onDone({
                kind: 'STEP12',
                wordIds: [word.id],
                pass: true,
                latencyMs: Date.now() - startRef.current,
                hint: revealed || undefined,
              })
            }
          >
            完成（播种 F 与半衰期）
          </button>
          {!revealed && (
            <button className="ghost" onClick={() => setRevealed(true)}>
              卡住了？显示答案重敲
            </button>
          )}
        </>
      )}
    </div>
  );
}

export function Step3({
  word,
  srsReview,
  onDone,
}: {
  word: Word;
  srsReview: boolean;
  onDone: (b: ResultBody) => void;
}) {
  const [phase, setPhase] = useState<'answer' | 'remediate'>('answer');
  const [input, setInput] = useState('');
  const [wrong, setWrong] = useState(false);
  const startRef = useRef(Date.now());
  const matched = norm(input) === norm(word.chunk);

  const submit = () => {
    if (matched) {
      onDone({
        kind: 'STEP3',
        wordIds: [word.id],
        pass: true,
        srsReview,
        latencyMs: Date.now() - startRef.current,
      });
    } else {
      setWrong(true);
      setPhase('remediate');
      setInput('');
    }
  };

  return (
    <div className="card">
      <div className="badge">
        Step 3 · 语境提取（LRL）{srsReview && '· 维护复习'}
        <span className="muted">
          {' '}
          F 读{word.fluency_r.toFixed(0)}/写{word.fluency.toFixed(0)}
        </span>
      </div>
      {phase === 'answer' ? (
        <>
          <div className="sentence">{word.step3_sentence}</div>
          {(word.substitute || word.meaning) && (
            <div className="muted">
              {word.substitute && <>替身提示：{word.substitute} </>}
              {word.substitute && word.meaning && '｜ '}
              {word.meaning && <>语义：{word.meaning}</>}
            </div>
          )}
          <input
            type="text"
            autoFocus
            placeholder="用目标语块填空…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && input && submit()}
          />
          <button className="primary" disabled={!input} onClick={submit}>
            提交
          </button>
        </>
      ) : (
        <>
          {wrong && <div className="fail">没提取出来——首次编码没焊牢，当场重做 Step 2。</div>}
          <div className="chunk">{word.chunk}</div>
          <div className="mono muted">{word.slots}</div>
          <input
            type="text"
            autoFocus
            placeholder="重敲语块完成补救…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button
            className="danger"
            disabled={!matched}
            onClick={() => onDone({ kind: 'STEP3', wordIds: [word.id], pass: false, srsReview })}
          >
            补救完成（记为失败，F 回落、H_time 减半）
          </button>
        </>
      )}
    </div>
  );
}

export function Step4({
  word,
  timeBudgetMs,
  onDone,
}: {
  word: Word;
  timeBudgetMs: number;
  onDone: (b: ResultBody) => void;
}) {
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<'write' | 'grade'>('write');
  const [msLeft, setMsLeft] = useState(timeBudgetMs);
  const latencyRef = useRef(0);
  const startRef = useRef(Date.now());

  // 倒计时：预算耗尽自动停笔进入自评
  useEffect(() => {
    if (phase !== 'write') return;
    if (msLeft <= 0) {
      latencyRef.current = timeBudgetMs;
      setPhase('grade');
      return;
    }
    const t = setTimeout(() => setMsLeft((s) => s - 500), 500);
    return () => clearTimeout(t);
  }, [phase, msLeft, timeBudgetMs]);

  const submitWrite = () => {
    latencyRef.current = Math.min(Date.now() - startRef.current, timeBudgetMs);
    setPhase('grade');
  };

  const report = (pass: boolean) =>
    onDone({
      kind: 'STEP4',
      wordIds: [word.id],
      pass,
      latencyMs: latencyRef.current,
      wordsProduced: wordCount(input),
    });

  return (
    <div className="card">
      <div className="badge">
        Step 4 · 限时产出（FD · 写作）
        <span className="muted">
          {' '}
          F 读{word.fluency_r.toFixed(0)}/写{word.fluency.toFixed(0)}
        </span>
      </div>
      {phase === 'write' ? (
        <>
          <p className="muted">
            用目标语块写 2–3 个句子，预算 {Math.ceil(timeBudgetMs / 1000)} 秒（速度游标自动加压）：
          </p>
          <div className="chunk">{word.chunk}</div>
          <div className="muted">{word.meaning}</div>
          <div className="timer">{Math.ceil(msLeft / 1000)}s</div>
          <textarea
            rows={4}
            autoFocus
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Write 2–3 sentences using the chunk…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
          />
          <button className="primary" disabled={!input.trim()} onClick={submitWrite}>
            写完，对照自评
          </button>
        </>
      ) : (
        <>
          <p className="muted">你的产出（{wordCount(input)} 词）：</p>
          <div className="sentence">{input || '（空）'}</div>
          <p className="muted">对照示范句：</p>
          {word.step4_sentences.map((s, i) => (
            <div className="sentence" key={i}>
              {s}
            </div>
          ))}
          <button className="primary" onClick={() => report(true)}>
            语块用对了（通过）
          </button>
          <button className="danger" onClick={() => report(false)}>
            没用对/没写出来（记失败）
          </button>
        </>
      )}
    </div>
  );
}

export function Step4R({
  word,
  timeBudgetMs,
  onDone,
}: {
  word: Word;
  timeBudgetMs: number;
  onDone: (b: ResultBody) => void;
}) {
  const [phase, setPhase] = useState<'read' | 'grade'>('read');
  const [msLeft, setMsLeft] = useState(timeBudgetMs);
  const latencyRef = useRef(0);
  const startRef = useRef(Date.now());
  const words = wordCount(word.step4_sentences.join(' '));

  // 倒计时：归零不停表——读不完就超时继续读，超时本身会拉低实测 wpm、阻止游标加压
  useEffect(() => {
    if (phase !== 'read' || msLeft <= 0) return;
    const t = setTimeout(() => setMsLeft((s) => s - 500), 500);
    return () => clearTimeout(t);
  }, [phase, msLeft]);

  const finishRead = () => {
    latencyRef.current = Date.now() - startRef.current;
    setPhase('grade');
  };

  const report = (pass: boolean) =>
    onDone({ kind: 'STEP4R', wordIds: [word.id], pass, latencyMs: latencyRef.current });

  return (
    <div className="card">
      <div className="badge">
        Step 4R · 限时速读（FD · 阅读）
        <span className="muted">
          {' '}
          F 读{word.fluency_r.toFixed(0)}/写{word.fluency.toFixed(0)}
        </span>
      </div>
      {phase === 'read' ? (
        <>
          <p className="muted">
            目标语块：<b>{word.chunk}</b>（{word.meaning}）——一口气读完下面{' '}
            {word.step4_sentences.length} 个场景，预算 {Math.ceil(timeBudgetMs / 1000)}{' '}
            秒（阅读游标自动加压）：
          </p>
          <div className={`timer${msLeft <= 0 ? ' fail' : ''}`}>
            {msLeft > 0 ? `${Math.ceil(msLeft / 1000)}s` : '超时'}
          </div>
          {word.step4_sentences.map((s, i) => (
            <div className="sentence" key={i}>
              场景{i + 1} · {s}
            </div>
          ))}
          <button className="primary" onClick={finishRead}>
            读完了
          </button>
        </>
      ) : (
        <>
          <p className="muted">
            {words} 词 / {(latencyRef.current / 1000).toFixed(1)} 秒 ≈{' '}
            {Math.round(words / (latencyRef.current / 60_000))} wpm。
            理解自评（读懂才算有效测速）：
          </p>
          <button className="primary" onClick={() => report(true)}>
            读懂了（通过）
          </button>
          <button className="danger" onClick={() => report(false)}>
            没读懂/回读多次（记失败）
          </button>
        </>
      )}
    </div>
  );
}

export function Mfi({
  word,
  passage,
  passageWords,
  options,
  answerIndex,
  timeBudgetMs,
  onDone,
}: {
  word: Word;
  passage: string;
  passageWords: number;
  options: string[];
  answerIndex: number;
  timeBudgetMs: number;
  onDone: (b: ResultBody) => void;
}) {
  const [phase, setPhase] = useState<'read' | 'quiz'>('read');
  const [msLeft, setMsLeft] = useState(timeBudgetMs);
  const latencyRef = useRef(0);
  const startRef = useRef(Date.now());

  // 倒计时：归零不停表——读不完就超时继续读，超时本身会拉低实测 wpm、阻止游标加压
  useEffect(() => {
    if (phase !== 'read' || msLeft <= 0) return;
    const t = setTimeout(() => setMsLeft((s) => s - 500), 500);
    return () => clearTimeout(t);
  }, [phase, msLeft]);

  const finishRead = () => {
    latencyRef.current = Date.now() - startRef.current;
    setPhase('quiz');
  };

  const answer = (idx: number) =>
    onDone({
      kind: 'MFI',
      wordIds: [word.id],
      pass: idx === answerIndex,
      latencyMs: latencyRef.current,
      wordsRead: passageWords,
    });

  return (
    <div className="card">
      <div className="badge">
        MFI · 可理解输入（主旨理解）
        <span className="muted">
          {' '}
          F 读{word.fluency_r.toFixed(0)}/写{word.fluency.toFixed(0)}
        </span>
      </div>
      {phase === 'read' ? (
        <>
          <p className="muted">
            一口气读完这段原文（{passageWords} 词），预算 {Math.ceil(timeBudgetMs / 1000)}{' '}
            秒（阅读游标自动加压）：
          </p>
          <div className={`timer${msLeft <= 0 ? ' fail' : ''}`}>
            {msLeft > 0 ? `${Math.ceil(msLeft / 1000)}s` : '超时'}
          </div>
          <div className="sentence">{passage}</div>
          <button className="primary" onClick={finishRead}>
            读完了，做主旨题
          </button>
        </>
      ) : (
        <>
          <p className="muted">
            {passageWords} 词 / {(latencyRef.current / 1000).toFixed(1)} 秒 ≈{' '}
            {Math.round(passageWords / (latencyRef.current / 60_000))} wpm。
            哪一句最贴合这段的主旨？
          </p>
          {options.map((opt, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <button className="ghost" style={{ textAlign: 'left' }} onClick={() => answer(i)}>
                {String.fromCharCode(65 + i)}. {opt}
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

export function PartB({ words, onDone }: { words: Word[]; onDone: (b: ResultBody) => void }) {
  const [missed, setMissed] = useState<number>(words[0].id);
  const ids = words.map((w) => w.id);

  return (
    <div className="card">
      <div className="badge">Part B · 批次集成（MFO · 整合复述）</div>
      <p className="muted">
        {words.length} 个语块已到 INTEGRABLE 档，现在串成一篇微文，一口气读完后看着骨架复述：
      </p>
      {words.map((w, i) => (
        <div className="sentence" key={w.id}>
          {i + 1}. {w.step4_sentences[0]}
        </div>
      ))}
      <div className="scene">
        复述骨架：{words.map((w) => w.meaning || w.chunk).join(' → ')}
      </div>
      <button
        className="primary"
        onClick={() => onDone({ kind: 'PART_B', wordIds: ids, pass: true })}
      >
        全部复述出来（集成认证：F 保底 80，转入维护复习）
      </button>
      <div style={{ marginTop: 12 }}>
        <select value={missed} onChange={(e) => setMissed(Number(e.target.value))}>
          {words.map((w) => (
            <option key={w.id} value={w.id}>
              {w.chunk}
            </option>
          ))}
        </select>
        <button
          className="danger"
          onClick={() => onDone({ kind: 'PART_B', wordIds: ids, pass: false, missedWordId: missed })}
        >
          这个词卡壳了（仅它 F 回落重学）
        </button>
      </div>
    </div>
  );
}
