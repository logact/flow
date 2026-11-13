'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  AttemptResponse,
  FluencyChange,
  LearningTaskView,
  TaskSubmission,
} from '@/lib/client/types';

/** 卡片公共输入：任务视图、提交回调与提交结果。 */
export interface TaskCardProps {
  task: LearningTaskView;
  index: number;
  active: boolean;
  result: AttemptResponse | null;
  submitting: boolean;
  onSubmit: (submission: TaskSubmission, elapsedMs: number) => void;
  onNext: () => void;
  notify: (message: string) => void;
}

const AXIS_LABEL: Record<string, string> = { R: '理解 R', P: '产出 P' };

const OUTCOME_TEXT: Record<string, { title: string; retry: boolean }> = {
  correct: { title: '回答正确，很流畅。', retry: false },
  partial: { title: '部分正确，继续巩固。', retry: false },
  incorrect: { title: '这次没答对，已记录复习。', retry: true },
};

export function Icon({ name, size = 22 }: { name: 'arrow' | 'check' | 'clock' | 'spark' | 'volume'; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    spark: <path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5Z" />,
    volume: <><path d="M5 10v4h3l4 4V6l-4 4Z" /><path d="M15 9a4 4 0 0 1 0 6" /><path d="M17.5 6.5a8 8 0 0 1 0 11" /></>,
  };
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {paths[name]}
    </svg>
  );
}

function CardHeader({ type, axis, index }: { type: string; axis: string; index: number }) {
  return (
    <div className="card-header">
      <div className="task-tags">
        <span className="task-number">{String(index + 1).padStart(2, '0')}</span>
        <span>{type}</span>
        <span className="tag-divider" />
        <span>{axis}</span>
      </div>
      <span className="light-tag"><Icon name="spark" size={14} /> 今日学习</span>
    </div>
  );
}

/** 记录卡片变为激活状态的时刻，用于作答计时。 */
function useShownAt(active: boolean) {
  const shownAtRef = useRef(0);
  useEffect(() => {
    if (active) shownAtRef.current = Date.now();
  }, [active]);
  return shownAtRef;
}

function fluencyChangeText(changes: FluencyChange[]): string | null {
  if (changes.length === 0) return null;
  return changes.map((change) => `${change.dimension} ${change.before.toFixed(2)} → ${change.after.toFixed(2)}`).join('　');
}

/** 提交结果反馈：评判结论 + AI 反馈 + 流利度变化。 */
function ResultFeedback({ result, axis }: { result: AttemptResponse; axis: 'R' | 'P' | null }) {
  const dimension = axis ? result.judgement?.dimensions?.[axis] : undefined;
  const outcome = dimension?.outcome;
  const text = outcome ? OUTCOME_TEXT[outcome] : null;
  const changes = fluencyChangeText(result.settlement?.fluencyChanges ?? []);
  return (
    <div className="answer-feedback visible" aria-live="polite">
      <span className={`feedback-icon ${outcome === 'incorrect' ? 'retry' : ''}`}>
        {outcome === 'incorrect' ? '↻' : <Icon name="check" size={18} />}
      </span>
      <p>
        <strong>{text?.title ?? (result.statusReason ? `作答未结算：${result.statusReason}` : '已记录')}</strong>
        {result.feedback && <span>{result.feedback}</span>}
        {changes && <span>流利度 {changes}</span>}
        {dimension?.speedWpm !== undefined && <span>速度 {Math.round(dimension.speedWpm)} 词/分钟</span>}
      </p>
    </div>
  );
}

function NextButton({ onNext, result }: { onNext: () => void; result: AttemptResponse | null }) {
  return (
    <button className="primary-button" onClick={onNext}>
      {result ? '下一张' : '跳过'} <Icon name="arrow" size={19} />
    </button>
  );
}

// ── ENCODE 新词连接 ──────────────────────────────────────────────

export function EncodeCard({ task, index, active, result, submitting, onSubmit, onNext, notify }: TaskCardProps) {
  if (task.content.task !== 'ENCODE') return null;
  const content = task.content.content;
  const shownAtRef = useShownAt(active);
  return (
    <article className="learning-card encode-card">
      <div className="decode-shape shape-one" /><div className="decode-shape shape-two" />
      <div className="card-body encode-body">
        <CardHeader type="新词连接" axis="R + P" index={index} />
        <div className="word-hero">
          <span className="word-kicker">MEET A NEW WORD</span>
          <h1>{content.word}<span>.</span></h1>
          <button className="pronunciation" onClick={() => notify('发音播放为原型演示')}>
            <span className="sound-button"><Icon name="volume" size={20} /></span>
            {content.pronunciation && <span>{content.pronunciation}</span>}
          </button>
        </div>
        <div className="meaning-block">
          {content.partOfSpeech && <span className="part-of-speech">{content.partOfSpeech}</span>}
          <p>{content.definition}</p>
        </div>
        {content.examples.length > 0 && (
          <div className="example-block">
            <span>IN CONTEXT</span>
            {content.examples.map((example, i) => (
              <div key={i}>
                <p>{example.sentence}</p>
                {example.translation && <p className="example-translation">{example.translation}</p>}
              </div>
            ))}
          </div>
        )}
        {result && <ResultFeedback result={result} axis={null} />}
      </div>
      <div className="card-footer">
        <span className="footer-note">{content.instruction}</span>
        {result ? <NextButton onNext={onNext} result={result} /> : (
          <button
            className="primary-button"
            disabled={submitting}
            onClick={() => onSubmit({ task: 'ENCODE' }, Date.now() - (shownAtRef.current || Date.now()))}
          >
            {submitting ? '提交中…' : '认识了，继续'} <Icon name="arrow" size={19} />
          </button>
        )}
      </div>
    </article>
  );
}

// ── RETRIEVE choice 选择式提取 ────────────────────────────────────

export function ChoiceCard({ task, index, active, result, submitting, onSubmit, onNext }: TaskCardProps) {
  if (task.content.task !== 'RETRIEVE' || task.content.content.stage !== 'choice') return null;
  const content = task.content.content;
  const shownAtRef = useShownAt(active);
  const [selected, setSelected] = useState<string | null>(null);
  const submitted = Boolean(result);

  const choose = (optionId: string) => {
    if (selected || submitted) return;
    setSelected(optionId);
    onSubmit({ task: 'RETRIEVE', stage: 'choice', selectedOptionId: optionId }, Date.now() - (shownAtRef.current || Date.now()));
  };

  return (
    <article className="learning-card choice-card">
      <div className="card-body">
        <CardHeader type="快速回忆" axis={AXIS_LABEL[content.axis]} index={index} />
        <div className="question-heading">
          <span className="question-label">{content.prompt}</span>
        </div>
        <div className="choice-grid">
          {content.options.map((option) => (
            <button
              key={option.id}
              className={`choice-option ${selected === option.id ? 'correct' : ''}`}
              onClick={() => choose(option.id)}
              disabled={submitted || Boolean(selected)}
            >
              <span className="option-letter">{option.id.toUpperCase()}</span>
              <span>{option.text}</span>
            </button>
          ))}
        </div>
        {result && <ResultFeedback result={result} axis={content.axis} />}
      </div>
      <div className="card-footer">
        <span className="footer-note">凭第一直觉作答</span>
        <NextButton onNext={onNext} result={result} />
      </div>
    </article>
  );
}

// ── RETRIEVE cued/free 提示式与自由提取 ───────────────────────────

export function RecallCard({ task, index, active, result, submitting, onSubmit, onNext }: TaskCardProps) {
  if (task.content.task !== 'RETRIEVE' || task.content.content.stage === 'choice') return null;
  const content = task.content.content;
  const shownAtRef = useShownAt(active);
  const [answer, setAnswer] = useState('');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!answer.trim() || submitting) return;
    onSubmit({ task: 'RETRIEVE', stage: content.stage, answer: answer.trim() }, Date.now() - (shownAtRef.current || Date.now()));
  };

  return (
    <article className="learning-card recall-card">
      <div className="card-body">
        <CardHeader type={content.stage === 'cued' ? '提示提取' : '自由回忆'} axis={AXIS_LABEL[content.axis]} index={index} />
        <div className="recall-intro">
          <span className="question-label">{content.prompt}</span>
          {content.stage === 'cued' && (
            <p className="memory-clue"><Icon name="spark" size={17} /> {content.cue}</p>
          )}
        </div>
        {!result ? (
          <form className="recall-form" onSubmit={submit}>
            <label htmlFor={`recall-${task.id}`}>你的答案</label>
            <div className="answer-input-wrap">
              <input
                id={`recall-${task.id}`}
                value={answer}
                onChange={(event) => setAnswer(event.target.value)}
                placeholder="输入英文"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <button className="primary-button recall-submit" type="submit" disabled={!answer.trim() || submitting}>
              {submitting ? '评判中…' : '确认答案'} <Icon name="arrow" size={19} />
            </button>
          </form>
        ) : (
          <div className="recall-form"><ResultFeedback result={result} axis={content.axis} /></div>
        )}
      </div>
      <div className="card-footer">
        <span className="footer-note">主动提取，比重复观看记得更牢</span>
        <NextButton onNext={onNext} result={result} />
      </div>
    </article>
  );
}

// ── FLUENCY R 流利阅读 ────────────────────────────────────────────

export function ReadingCard({ task, index, active, result, submitting, onSubmit, onNext }: TaskCardProps) {
  if (task.content.task !== 'FLUENCY' || task.content.content.axis !== 'R') return null;
  const content = task.content.content;
  const shownAtRef = useShownAt(active);
  const [phase, setPhase] = useState<'reading' | 'questions'>(result ? 'questions' : 'reading');
  const [readMs, setReadMs] = useState(0);
  const [choiceAnswers, setChoiceAnswers] = useState<Record<string, string>>({});
  const [freeAnswers, setFreeAnswers] = useState<Record<string, string>>({});

  const finishReading = () => {
    setReadMs(Date.now() - (shownAtRef.current || Date.now()));
    setPhase('questions');
  };

  const allAnswered = content.questions.every((question) =>
    question.kind === 'choice' ? Boolean(choiceAnswers[question.id]) : Boolean(freeAnswers[question.id]?.trim()),
  );

  const submit = () => {
    if (!allAnswered || submitting) return;
    onSubmit({
      task: 'FLUENCY',
      axis: 'R',
      readingElapsedMs: Math.max(1, readMs),
      answers: content.questions.map((question) => question.kind === 'choice'
        ? { questionId: question.id, kind: 'choice', selectedOptionId: choiceAnswers[question.id] }
        : { questionId: question.id, kind: 'free', answer: freeAnswers[question.id].trim() }),
    }, Date.now() - (shownAtRef.current || Date.now()));
  };

  return (
    <article className="learning-card reading-card">
      <div className="card-body">
        <CardHeader type="流利阅读" axis="理解 R" index={index} />
        {phase === 'reading' ? (
          <div className="reading-view">
            <div className="reading-meta"><span><Icon name="clock" size={16} /> 阅读原文</span></div>
            <div className="article-copy">
              {content.passage.split(/\n+/).map((paragraph, i) => <p key={i}>{paragraph}</p>)}
            </div>
          </div>
        ) : (
          <div className="comprehension-view">
            {phase === 'questions' && !result && (
              <button className="back-to-reading" onClick={() => setPhase('reading')}>← 返回原文</button>
            )}
            <span className="question-label">阅读理解 · {content.questions.length} 题</span>
            {content.questions.map((question, qi) => (
              <div key={question.id} className="reading-question">
                <h1>{qi + 1}. {question.prompt}</h1>
                {question.kind === 'choice' ? (
                  <div className="reading-options">
                    {question.options.map((option) => (
                      <button
                        key={option.id}
                        className={`choice-option ${choiceAnswers[question.id] === option.id ? 'correct' : ''}`}
                        disabled={Boolean(result)}
                        onClick={() => setChoiceAnswers((value) => ({ ...value, [question.id]: option.id }))}
                      >
                        <span className="option-letter">{option.id.toUpperCase()}</span>{option.text}
                      </button>
                    ))}
                  </div>
                ) : (
                  <textarea
                    className="reading-free-input"
                    value={freeAnswers[question.id] ?? ''}
                    onChange={(event) => setFreeAnswers((value) => ({ ...value, [question.id]: event.target.value }))}
                    placeholder="用英文简要回答"
                    disabled={Boolean(result)}
                  />
                )}
              </div>
            ))}
            {result && <ResultFeedback result={result} axis="R" />}
          </div>
        )}
      </div>
      <div className="card-footer">
        <span className="footer-note">{phase === 'reading' ? '目标词已自然融入短文' : '答题时间不计入阅读速度'}</span>
        {phase === 'reading' ? (
          <button className="primary-button" onClick={finishReading}>我读完了 <Icon name="arrow" size={19} /></button>
        ) : result ? (
          <NextButton onNext={onNext} result={result} />
        ) : (
          <button className="primary-button" disabled={!allAnswered || submitting} onClick={submit}>
            {submitting ? '评判中…' : '提交答案'} <Icon name="arrow" size={19} />
          </button>
        )}
      </div>
    </article>
  );
}

// ── FLUENCY P 场景表达 ────────────────────────────────────────────

export function WritingCard({ task, index, active, result, submitting, onSubmit, onNext }: TaskCardProps) {
  if (task.content.task !== 'FLUENCY' || task.content.content.axis !== 'P') return null;
  const content = task.content.content;
  const shownAtRef = useShownAt(active);
  const [response, setResponse] = useState('');
  const wordCount = response.trim() ? response.trim().split(/\s+/).length : 0;

  const submit = () => {
    if (!response.trim() || submitting) return;
    onSubmit({ task: 'FLUENCY', axis: 'P', response: response.trim() }, Date.now() - (shownAtRef.current || Date.now()));
  };

  return (
    <article className="learning-card writing-card">
      <div className="card-body">
        <CardHeader type="场景表达" axis="产出 P" index={index} />
        <div className="writing-prompt">
          <span className="question-label">用英文表达这个场景</span>
          <h1>{content.scenario}</h1>
          <p>{content.responseInstruction}</p>
        </div>
        {!result ? (
          <div className="writing-area">
            <div className="writing-label"><label htmlFor={`writing-${task.id}`}>YOUR RESPONSE</label><span>{wordCount} words</span></div>
            <textarea
              id={`writing-${task.id}`}
              value={response}
              onChange={(event) => setResponse(event.target.value)}
              placeholder="Start writing in English…"
            />
            <div className="writing-tools"><span><Icon name="clock" size={16} /> 构思与输入都会计入用时</span></div>
          </div>
        ) : (
          <div className="writing-feedback-block"><ResultFeedback result={result} axis="P" /></div>
        )}
      </div>
      <div className="card-footer">
        {!result && <button className="text-button" onClick={() => setResponse('')}>清空</button>}
        {result ? <NextButton onNext={onNext} result={result} /> : (
          <button className="primary-button" disabled={!response.trim() || submitting} onClick={submit}>
            {submitting ? '评判中…' : '完成表达'} <Icon name="arrow" size={19} />
          </button>
        )}
      </div>
    </article>
  );
}

/** 按任务类型分派到对应卡片组件。 */
export function TaskCard(props: TaskCardProps) {
  const content = props.task.content;
  if (content.task === 'ENCODE') return <EncodeCard {...props} />;
  if (content.task === 'RETRIEVE' && content.content.stage === 'choice') return <ChoiceCard {...props} />;
  if (content.task === 'RETRIEVE') return <RecallCard {...props} />;
  if (content.content.axis === 'R') return <ReadingCard {...props} />;
  return <WritingCard {...props} />;
}
