'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { TaskEvidence, TaskInstance, SpeedMode } from '@/lib/tasks';

type PublicTargetCheck = {
  wordId: number;
  targetWord: string;
  anchorSentence: string;
};

type PublicPayload = {
  word_id?: number;
  chunk?: string;
  scene?: string;
  example_sentence?: string;
  continuous_text?: string | null;
  target_checks?: readonly PublicTargetCheck[];
  comprehension_question?: string;
  material_fallback?: string;
  options?: readonly string[];
  passage_words?: number;
  time_budget_ms?: number;
  speed_target_wpm?: number | null;
  evidence?: { accuracy_check?: readonly string[]; speed_mode?: SpeedMode };
};

export type TaskSubmission = {
  instance_id: string;
  response: Readonly<Record<string, unknown>>;
  evidence: TaskEvidence;
};

type TaskRendererProps = {
  task: TaskInstance;
  onSubmit: (result: TaskSubmission) => void | Promise<void>;
};

const payloadOf = (task: TaskInstance) => task.payload as PublicPayload;
const wordCount = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;
const readable = (value: unknown): string => typeof value === 'string' ? value : '';

/** Render one server-issued learning task. Scoring remains entirely server-side. */
export function TaskRenderer({ task, onSubmit }: TaskRendererProps) {
  const payload = payloadOf(task);
  const definitionChecks = payload.evidence?.accuracy_check ?? [];
  const speedMode = payload.evidence?.speed_mode ?? 'none';
  const chunk = readable(payload.chunk);
  const meaning = readable((task.payload as Record<string, unknown>).meaning);
  const scene = readable(payload.scene);
  const example = readable(payload.example_sentence);
  const passage = readable(payload.continuous_text);
  const targetChecks = payload.target_checks ?? [];
  const comprehensionQuestion = readable(payload.comprehension_question);
  const materialFallback = readable(payload.material_fallback);
  const materialFallbackMessage = materialFallback === 'p_expression_gloss_missing'
    ? '缺少已确认释义，暂不能验证连续表达。可到目标页手动添加释义或请求 AI 建议。'
    : materialFallback ? '连续篇章材料暂不可用，先安排可用的词语任务。' : '';
  const options = payload.options ?? [];
  const [started, setStarted] = useState(task.type === 'ENCODE' || task.type === 'RETRIEVE');
  const [answer, setAnswer] = useState('');
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [readingPhase, setReadingPhase] = useState<'reading' | 'questions'>('reading');
  const [measuredReadingMs, setMeasuredReadingMs] = useState<number | null>(null);
  const startAt = useRef<number | null>(null);

  const continuous = task.type === 'FLUENCY' || task.type === 'INTEGRATE';
  const axisP = task.axis === 'p';
  const revealable = axisP ? chunk.length > 0 : meaning.length > 0;
  const keyedPassageQuestion = task.axis === 'r' && !!comprehensionQuestion && options.length === 3;
  const needsTargetAnswers = task.axis === 'r' && continuous;
  const targetIds = useMemo(
    () => (targetChecks.length ? targetChecks.map((check) => check.wordId) : [...task.word_ids]),
    [targetChecks, task.word_ids]
  );
  const allTargetAnswersPresent = !needsTargetAnswers || targetIds.every((id) => !!answers[id]?.trim());
  const writingWords = wordCount(answer);
  const duration = startAt.current == null
    ? null
    : Math.max(1, task.axis === 'r' && continuous
      ? measuredReadingMs ?? Date.now() - startAt.current
      : Date.now() - startAt.current);

  useEffect(() => {
    if (!started || !continuous || submitting || (task.axis === 'r' && readingPhase === 'questions')) return;
    const timer = window.setInterval(() => {
      if (startAt.current != null) setElapsedMs(Date.now() - startAt.current);
    }, 250);
    return () => window.clearInterval(timer);
  }, [continuous, readingPhase, started, submitting, task.axis]);

  const begin = () => {
    startAt.current = Date.now();
    setMeasuredReadingMs(null);
    setReadingPhase('reading');
    setStarted(true);
  };

  const finishReading = () => {
    if (startAt.current != null) setMeasuredReadingMs(Math.max(1, Date.now() - startAt.current));
    setReadingPhase('questions');
  };

  const submit = async (practiceOnly = false) => {
    if (submitting) return;
    setSubmitting(true);
    const independent = !practiceOnly && !revealed;
    const checks: Record<string, boolean> = {};
    for (const key of definitionChecks) checks[key] = false;
    const wordResults = task.word_ids.map((word_id) => ({ word_id, correct: false }));
    const response: Record<string, unknown> = {};

    if (axisP && continuous) {
      response.text = answer;
    } else if (axisP) {
      response.word_answers = [{ word_id: task.word_ids[0], answer }];
    } else if (continuous) {
      response.word_answers = task.word_ids.map((word_id) => ({
        word_id,
        answer: answers[word_id] ?? answers[targetIds[0]] ?? '',
      }));
      if (selectedOption != null) response.passage_answer_index = selectedOption;
    } else {
      response.word_answers = [{ word_id: task.word_ids[0], answer }];
    }

    const evidence: TaskEvidence = {
      independent,
      answer_revealed: revealed || practiceOnly,
      hint_used: false,
      accuracy: checks,
      speed_mode: speedMode,
      speed_value: null,
      duration_ms: continuous ? duration : null,
      word_results: wordResults,
    };
    try {
      await onSubmit({ instance_id: task.instance_id, response, evidence });
    } catch {
      // The parent keeps the card and response mounted so the user can retry.
      setSubmitting(false);
    }
  };

  const keyboardSubmit = (
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
    mode: 'enter' | 'modified-enter',
    ready: boolean
  ) => {
    if (
      event.key !== 'Enter' ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      submitting ||
      !ready
    ) return;
    const shouldSubmit = mode === 'enter'
      ? !event.shiftKey && !event.ctrlKey && !event.metaKey
      : (event.ctrlKey || event.metaKey);
    if (!shouldSubmit) return;
    event.preventDefault();
    void submit();
  };

  if (task.type === 'ENCODE') {
    return (
      <article className="card">
        <div className="badge">建立联系 · {axisP ? '产出 P' : '认读 R'} · 教学</div>
        {materialFallbackMessage && <p className="muted">{materialFallbackMessage}</p>}
        <div className="scene">{scene}</div>
        <div className="chunk">{chunk}</div>
          <p className="muted">{meaning}</p>
        {example && <div className="sentence">{example}</div>}
        <p className="muted">教学展示不产生关卡分。看完后继续安排独立考核。</p>
        <button className="primary" disabled={submitting} onClick={() => void submit(true)}>
          {submitting ? '正在提交…' : '完成教学'}
        </button>
      </article>
    );
  }

  if (task.type === 'RETRIEVE') {
    return (
      <article className="card">
        <div className="badge">准确提取 · {axisP ? '产出 P' : '认读 R'} · {task.purpose}</div>
        {materialFallbackMessage && <p className="muted">{materialFallbackMessage}</p>}
        {scene && <div className="scene">{scene}</div>}
        {axisP ? (
          <>
            <p className="muted">根据语义和语境独立写出目标表达。</p>
            <p className="muted">{meaning}</p>
            {example && <div className="sentence">{example.replace(new RegExp(chunk.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '______')}</div>}
          </>
        ) : (
          <>
            <div className="chunk">{chunk}</div>
            {example && <div className="sentence">{example}</div>}
            <p className="muted">请独立写出这个表达在此处的意思。</p>
          </>
        )}
        <label className="muted" htmlFor={`answer-${task.instance_id}`}>{axisP ? '目标表达' : '语境中的意思'}</label>
        <textarea
          id={`answer-${task.instance_id}`}
          autoFocus
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => keyboardSubmit(event, 'enter', !!answer.trim())}
          disabled={submitting || revealed}
          rows={3}
        />
        {revealed && <div className="fail">答案已显示：{answer}。本次只能作为补练，不能认证关卡。</div>}
        <button className="primary" disabled={!answer.trim() || submitting} onClick={() => void submit()}>
          {submitting ? '正在提交…' : '提交独立作答'}
        </button>
        {!revealed && revealable && (
          <button
            className="ghost"
            disabled={submitting}
            onClick={() => {
              setAnswer(axisP ? chunk : meaning);
              setRevealed(true);
            }}
          >
            显示答案并进行补练
          </button>
        )}
      </article>
    );
  }

  const missingMaterial = !passage || (task.axis === 'r' && !keyedPassageQuestion);
  if (continuous && !started) {
    return (
      <article className="card">
        <div className="badge">{task.type === 'INTEGRATE' ? '综合运用' : '流利训练'} · {axisP ? '产出 P' : '认读 R'}</div>
        {missingMaterial ? (
          <div className="fail">当前材料缺少可核验的连续内容或整段理解题，暂时不能开始这项独立考核。</div>
        ) : (
          <>
            <div className="scene">{scene}</div>
            <p className="muted">{axisP ? '计时从开始写作后启动。' : '阅读完整材料后再回答问题，阅读阶段开始计时。'}</p>
            <button className="primary" onClick={begin}>开始任务</button>
          </>
        )}
      </article>
    );
  }

  return (
    <article className="card">
      <div className="badge">{task.type === 'INTEGRATE' ? '综合运用' : '流利训练'} · {axisP ? '产出 P' : '认读 R'} · {task.purpose}</div>
      {materialFallbackMessage && <p className="muted">{materialFallbackMessage}</p>}
      {axisP ? (
        <>
          <div className="scene">{scene || '围绕目标表达完成一段连贯写作。'}</div>
          <div className="muted">目标表达：{chunk}</div>
          {task.word_ids.length === 1 && meaning && <p className="muted">{meaning}</p>}
          <div className="timer">{Math.floor(elapsedMs / 1000)}s · {writingWords} 词</div>
          <textarea
            autoFocus
            rows={8}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => keyboardSubmit(event, 'modified-enter', writingWords >= 30)}
            disabled={submitting}
            placeholder="写一段完整表达，说明语境并自然使用目标表达。"
          />
          <button
            className="primary"
            disabled={submitting || writingWords < 30}
            onClick={() => void submit()}
          >
            {submitting ? '正在提交…' : '完成写作并提交'}
          </button>
          <p className="muted">至少 30 词。服务器会检查目标词和整体表达要求。</p>
        </>
      ) : (
        <>
          {readingPhase === 'reading' ? (
            <>
              <p className="muted">完整阅读材料，读完后再回答目标词与整段理解问题。</p>
              <div className="timer">阅读 {Math.floor(elapsedMs / 1000)}s</div>
              <div className="sentence">{passage}</div>
              <button className="primary" onClick={finishReading}>我读完了，开始回答</button>
            </>
          ) : (
            <>
          <p className="muted">阅读用时 {Math.floor((measuredReadingMs ?? 0) / 1000)} 秒。独立回答目标词与整段理解问题。</p>
          {targetChecks.length > 0 ? targetChecks.map((check) => (
            <div className="sentence" key={check.wordId}>
              <div><strong>目标词：{check.targetWord}</strong></div>
              <div className="muted">{check.anchorSentence}</div>
              <label className="muted" htmlFor={`target-${task.instance_id}-${check.wordId}`}>解释它在文中的意思</label>
              <input
                id={`target-${task.instance_id}-${check.wordId}`}
                value={answers[check.wordId] ?? ''}
                onChange={(event) => setAnswers((current) => ({ ...current, [check.wordId]: event.target.value }))}
                disabled={submitting}
              />
            </div>
          )) : task.word_ids.map((wordId) => (
            <div className="sentence" key={wordId}>
              <label className="muted" htmlFor={`target-${task.instance_id}-${wordId}`}>解释目标词 {chunk} 在文中的意思</label>
              <input
                id={`target-${task.instance_id}-${wordId}`}
                value={answers[wordId] ?? ''}
                onChange={(event) => setAnswers((current) => ({ ...current, [wordId]: event.target.value }))}
                disabled={submitting}
              />
            </div>
          ))}
          {keyedPassageQuestion ? (
            <>
              <p className="muted">{comprehensionQuestion}</p>
              {options.map((option, index) => (
                <button
                  type="button"
                  key={`${index}-${option}`}
                  className={selectedOption === index ? 'primary' : 'ghost'}
                  aria-pressed={selectedOption === index}
                  disabled={submitting}
                  onClick={() => setSelectedOption(index)}
                >
                  {String.fromCharCode(65 + index)}. {option}
                </button>
              ))}
            </>
          ) : (
            <div className="fail">没有服务端可核验的整段理解选项；请返回并等待其他可用任务。</div>
          )}
          <button
            className="primary"
            disabled={submitting || !keyedPassageQuestion || selectedOption == null || !allTargetAnswersPresent}
            onClick={() => void submit()}
          >
            {submitting ? '正在提交…' : '提交阅读理解'}
          </button>
          <p className="muted">阅读时间 {Math.floor(elapsedMs / 1000)} 秒；服务器按材料词数与持续时间核验速度。</p>
            </>
          )}
        </>
      )}
    </article>
  );
}
