'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

type IconName =
  | 'arrow'
  | 'bookmark'
  | 'book'
  | 'check'
  | 'clock'
  | 'comment'
  | 'heart'
  | 'play'
  | 'plus'
  | 'search'
  | 'share'
  | 'spark'
  | 'volume';

const slides = [
  { id: 'encode', short: '新词' },
  { id: 'choice', short: '理解' },
  { id: 'recall', short: '产出' },
  { id: 'reading', short: '阅读' },
  { id: 'writing', short: '表达' },
];

const choiceOptions = ['随处可见的', '转瞬即逝的', '模棱两可的', '鲜为人知的'];

function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    bookmark: <path d="M6 4.8A1.8 1.8 0 0 1 7.8 3h8.4A1.8 1.8 0 0 1 18 4.8V21l-6-3.8L6 21Z" />,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v16H6.5A2.5 2.5 0 0 0 4 21.5Z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v16h4.5a2.5 2.5 0 0 1 2.5 2.5Z" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    comment: <path d="M21 11.5a8.4 8.4 0 0 1-9 8.5 9.7 9.7 0 0 1-4-.9L3 21l1.8-4.4A8.3 8.3 0 0 1 3 11.5a8.5 8.5 0 0 1 9-8.5 8.5 8.5 0 0 1 9 8.5Z" />,
    heart: <path d="M20.8 5.8a5.1 5.1 0 0 0-7.2 0L12 7.4l-1.6-1.6a5.1 5.1 0 0 0-7.2 7.2L12 21l8.8-8a5.1 5.1 0 0 0 0-7.2Z" />,
    play: <path d="m9 6 9 6-9 6Z" />,
    plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
    share: <><path d="m13 4 8 8-8 8v-5C6 15 3 18 3 18s0-9 10-9Z" /></>,
    spark: <><path d="m12 3 1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5Z" /><path d="m19 16 .7 2.3L22 19l-2.3.7L19 22l-.7-2.3L16 19l2.3-.7Z" /></>,
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

export default function LearningFeed() {
  const feedRef = useRef<HTMLElement>(null);
  const [activeSlide, setActiveSlide] = useState(0);
  const [liked, setLiked] = useState<Record<number, boolean>>({});
  const [saved, setSaved] = useState<Record<number, boolean>>({});
  const [choice, setChoice] = useState('');
  const [recallAnswer, setRecallAnswer] = useState('');
  const [recallChecked, setRecallChecked] = useState(false);
  const [readingDone, setReadingDone] = useState(false);
  const [readingAnswer, setReadingAnswer] = useState('');
  const [writing, setWriting] = useState('');
  const [writingSubmitted, setWritingSubmitted] = useState(false);
  const [toast, setToast] = useState('');

  const goToSlide = (index: number) => {
    const feed = feedRef.current;
    if (!feed) return;
    const next = Math.max(0, Math.min(slides.length - 1, index));
    feed.scrollTo({ top: next * feed.clientHeight, behavior: 'smooth' });
  };

  const notify = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 2200);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      if (event.key === 'ArrowDown' || event.key === 'PageDown') {
        event.preventDefault();
        goToSlide(activeSlide + 1);
      }
      if (event.key === 'ArrowUp' || event.key === 'PageUp') {
        event.preventDefault();
        goToSlide(activeSlide - 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeSlide]);

  const checkRecall = (event: FormEvent) => {
    event.preventDefault();
    if (recallAnswer.trim()) setRecallChecked(true);
  };

  const writingWords = writing.trim() ? writing.trim().split(/\s+/).length : 0;

  const actionRail = (index: number) => (
    <aside className="action-rail" aria-label="学习卡操作">
      <button className="creator-avatar" onClick={() => notify('Flow 每日英语 · 学习创作者主页')} aria-label="查看创作者主页">
        <span>F</span><i><Icon name="plus" size={12} /></i>
      </button>
      <button className={`rail-action ${liked[index] ? 'is-liked' : ''}`} onClick={() => setLiked((value) => ({ ...value, [index]: !value[index] }))} aria-label={liked[index] ? '取消喜欢' : '喜欢'}>
        <span className="rail-icon"><Icon name="heart" size={34} /></span>
        <span>{liked[index] ? '2.9w' : '2.8w'}</span>
      </button>
      <button className="rail-action" onClick={() => notify('学习笔记与讨论为原型占位')} aria-label="查看学习笔记">
        <span className="rail-icon"><Icon name="comment" size={32} /></span>
        <span>326</span>
      </button>
      <button className={`rail-action ${saved[index] ? 'is-saved' : ''}`} onClick={() => setSaved((value) => ({ ...value, [index]: !value[index] }))} aria-label={saved[index] ? '取消收藏' : '收藏'}>
        <span className="rail-icon"><Icon name="bookmark" size={31} /></span>
        <span>{saved[index] ? '已收藏' : '收藏'}</span>
      </button>
      <button className="rail-action" onClick={() => notify('分享学习卡为原型占位')} aria-label="分享学习卡">
        <span className="rail-icon"><Icon name="share" size={32} /></span>
        <span>分享</span>
      </button>
    </aside>
  );

  const creatorMeta = (caption: string) => (
    <div className="creator-meta">
      <strong>@Flow每日英语</strong>
      <p>{caption} <span>#每天背单词 #英语学习</span></p>
      <div><Icon name="volume" size={14} /><span>原声 - Flow 学习电台</span></div>
    </div>
  );

  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => goToSlide(0)} aria-label="回到第一张学习卡">flow<span>.</span></button>
        <div className="top-tabs" aria-label="学习模式">
          <button onClick={() => notify('关注页面为原型占位')}>关注</button>
          <button className="active">学习</button>
          <button onClick={() => notify('今日还有 12 个复习任务')}>复习<span className="review-badge">12</span></button>
        </div>
        <button className="search-button" onClick={() => notify('搜索单词为原型占位')} aria-label="搜索"><Icon name="search" size={25} /></button>
      </header>

      <main
        className="learning-feed"
        ref={feedRef}
        onScroll={(event) => {
          const feed = event.currentTarget;
          setActiveSlide(Math.max(0, Math.min(slides.length - 1, Math.round(feed.scrollTop / feed.clientHeight))));
        }}
      >
        <section className="feed-slide" aria-label="新词学习：resilient">
          <div className="slide-inner">
            <article className="learning-card encode-card">
              <div className="decode-shape shape-one" /><div className="decode-shape shape-two" />
              <div className="card-body encode-body">
                <CardHeader type="新词连接" axis="理解 + 产出" index={0} />
                <div className="word-hero">
                  <span className="word-kicker">MEET A NEW WORD</span>
                  <h1>resilient<span>.</span></h1>
                  <button className="pronunciation" onClick={() => notify('发音播放为原型演示')}>
                    <span className="sound-button"><Icon name="volume" size={20} /></span>
                    <span>/rɪˈzɪliənt/</span><span className="accent-label">英</span>
                  </button>
                </div>
                <div className="meaning-block">
                  <span className="part-of-speech">adj.</span>
                  <p>有韧性的；能复原的<br /><span>适应力强的</span></p>
                </div>
                <div className="example-block">
                  <span>IN CONTEXT</span>
                  <p>She remained <mark>resilient</mark>, adapting to every challenge with quiet confidence.</p>
                  <p className="example-translation">她始终坚韧不拔，从容而自信地适应每一次挑战。</p>
                </div>
              </div>
              <div className="card-footer">
                <span className="footer-note">建立词形与词义的第一层连接</span>
                <button className="primary-button" onClick={() => goToSlide(1)}>认识了，继续 <Icon name="arrow" size={19} /></button>
              </div>
              {creatorMeta('今天认识一个很有力量的单词：resilient')}
            </article>
            {actionRail(0)}
          </div>
        </section>

        <section className="feed-slide" aria-label="理解选择练习：ubiquitous">
          <div className="slide-inner">
            <article className="learning-card choice-card">
              <div className="card-body">
                <CardHeader type="快速回忆" axis="理解 R" index={1} />
                <div className="question-heading">
                  <span className="question-label">选出最贴切的释义</span>
                  <h1>ubiquitous</h1>
                  <p>/juːˈbɪkwɪtəs/ <span>adj.</span></p>
                </div>
                <div className="choice-grid">
                  {choiceOptions.map((option, index) => {
                    const isSelected = choice === option;
                    const isCorrect = index === 0;
                    const className = choice ? `choice-option ${isCorrect ? 'correct' : ''} ${isSelected && !isCorrect ? 'wrong' : ''}` : 'choice-option';
                    return (
                      <button key={option} className={className} onClick={() => setChoice(option)} disabled={Boolean(choice)}>
                        <span className="option-letter">{String.fromCharCode(65 + index)}</span>
                        <span>{option}</span>
                        {choice && isCorrect && <Icon name="check" size={20} />}
                      </button>
                    );
                  })}
                </div>
                <div className={`answer-feedback ${choice ? 'visible' : ''}`} aria-live="polite">
                  {choice === choiceOptions[0] ? <><span className="feedback-icon"><Icon name="check" size={18} /></span><p><strong>答对了，很流畅。</strong><span>Smartphones have become ubiquitous in modern life.</span></p></> : <><span className="feedback-icon retry">↻</span><p><strong>再记一次：无处不在的。</strong><span>强调某事物似乎存在于每一个地方。</span></p></>}
                </div>
              </div>
              <div className="card-footer">
                <span className="footer-note">凭第一直觉作答</span>
                <button className="primary-button" onClick={() => goToSlide(2)}>下一张 <Icon name="arrow" size={19} /></button>
              </div>
              {creatorMeta('别急着看答案，凭第一直觉选一次')}
            </article>
            {actionRail(1)}
          </div>
        </section>

        <section className="feed-slide" aria-label="产出提取练习：deliberate">
          <div className="slide-inner">
            <article className="learning-card recall-card">
              <div className="card-body">
                <CardHeader type="提示提取" axis="产出 P" index={2} />
                <div className="recall-intro">
                  <span className="question-label">根据词义，写出英文单词</span>
                  <div className="meaning-display"><span>adj.</span><h1>深思熟虑的；<br />故意的，蓄意的</h1></div>
                  <p className="memory-clue"><Icon name="spark" size={17} /> 联想：经过仔细权衡后做出的选择</p>
                </div>
                <form className="recall-form" onSubmit={checkRecall}>
                  <label htmlFor="recall-answer">你的答案</label>
                  <div className={`answer-input-wrap ${recallChecked ? (recallAnswer.trim().toLowerCase() === 'deliberate' ? 'input-correct' : 'input-wrong') : ''}`}>
                    <input id="recall-answer" value={recallAnswer} onChange={(event) => { setRecallAnswer(event.target.value); setRecallChecked(false); }} placeholder="输入英文单词" autoComplete="off" spellCheck={false} />
                    {recallChecked && <span className="input-state">{recallAnswer.trim().toLowerCase() === 'deliberate' ? <Icon name="check" /> : '再试试'}</span>}
                  </div>
                  <div className="letter-hint"><span>字母提示</span><strong>d e _ _ _ _ _ _ _ _</strong><small>10 letters</small></div>
                  {recallChecked && recallAnswer.trim().toLowerCase() !== 'deliberate' && <button type="button" className="show-answer" onClick={() => { setRecallAnswer('deliberate'); setRecallChecked(true); }}>查看正确答案</button>}
                  <button className="primary-button recall-submit" type="submit" disabled={!recallAnswer.trim()}>确认答案 <Icon name="arrow" size={19} /></button>
                </form>
              </div>
              <div className="card-footer">
                <span className="footer-note">主动提取，比重复观看记得更牢</span>
                <button className="text-button" onClick={() => goToSlide(3)}>暂时跳过</button>
              </div>
              {creatorMeta('能看懂不算掌握，试着主动写出来')}
            </article>
            {actionRail(2)}
          </div>
        </section>

        <section className="feed-slide" aria-label="流利阅读练习：contemporary">
          <div className="slide-inner">
            <article className="learning-card reading-card">
              <div className="card-body">
                <CardHeader type="流利阅读" axis="理解 R" index={3} />
                {!readingDone ? (
                  <div className="reading-view">
                    <div className="reading-meta"><span><Icon name="book" size={17} /> CITY & LIFE</span><span><Icon name="clock" size={16} /> 约 1 分钟</span></div>
                    <h1>A City That Lives in the Present</h1>
                    <div className="article-copy">
                      <p>A <mark>contemporary</mark> city is never finished. Its streets absorb new habits as quickly as old ones disappear. In a <mark>contemporary</mark> neighborhood, a century-old bakery might stand beside a studio where designers shape virtual worlds.</p>
                      <p>This contrast is not a conflict but a conversation. <mark>Contemporary</mark> life borrows from memory while responding to immediate needs. People work remotely, yet still seek shared tables and public gardens. They value speed, but also protect slow rituals.</p>
                      <p>To understand a <mark>contemporary</mark> place, we should notice how people actually live, not only how buildings look. The most <mark>contemporary</mark> idea may be an old one renewed: a city belongs to everyone.</p>
                    </div>
                  </div>
                ) : (
                  <div className="comprehension-view">
                    <button className="back-to-reading" onClick={() => { setReadingDone(false); setReadingAnswer(''); }}>← 返回原文</button>
                    <span className="question-label">阅读理解 · 1 / 2</span>
                    <h1>文中 “contemporary”<br />最接近下面哪项含义？</h1>
                    <div className="reading-options">
                      {['当代的；现代的', '临时的；短暂的', '传统的；古典的'].map((option, index) => (
                        <button key={option} className={readingAnswer ? `choice-option ${index === 0 ? 'correct' : ''} ${readingAnswer === option && index !== 0 ? 'wrong' : ''}` : 'choice-option'} disabled={Boolean(readingAnswer)} onClick={() => setReadingAnswer(option)}>
                          <span className="option-letter">{String.fromCharCode(65 + index)}</span>{option}{readingAnswer && index === 0 && <Icon name="check" size={20} />}
                        </button>
                      ))}
                    </div>
                    {readingAnswer && <p className="reading-feedback" aria-live="polite">{readingAnswer === '当代的；现代的' ? '理解正确。文中通过现代生活与传统记忆的并置来说明词义。' : '再联系上下文：文中讨论的是当下城市的生活方式。'}</p>}
                  </div>
                )}
              </div>
              <div className="card-footer">
                <span className="footer-note">{readingDone ? '答题时间不计入阅读速度' : '目标词已自然融入短文'}</span>
                {!readingDone ? <button className="primary-button" onClick={() => setReadingDone(true)}>我读完了 <Icon name="arrow" size={19} /></button> : <button className="primary-button" disabled={!readingAnswer} onClick={() => goToSlide(4)}>继续 <Icon name="arrow" size={19} /></button>}
              </div>
              {creatorMeta('把单词放回真实语境，读懂一座当代城市')}
            </article>
            {actionRail(3)}
          </div>
        </section>

        <section className="feed-slide" aria-label="场景表达练习">
          <div className="slide-inner">
            <article className="learning-card writing-card">
              <div className="card-body">
                <CardHeader type="场景表达" axis="产出 P" index={4} />
                <div className="writing-prompt">
                  <span className="question-label">用英文复述这个场景</span>
                  <h1>描述你的一次灵活应变</h1>
                  <p>你和朋友计划了一次户外旅行，但出发前突然下起大雨。请描述你们如何调整计划，并说明最后的结果。</p>
                  <div className="writing-requirements"><span>至少 30 词</span><span>自然使用目标词</span><span>表达连贯</span></div>
                </div>
                <div className="writing-area">
                  <div className="writing-label"><label htmlFor="writing-answer">YOUR RESPONSE</label><span>{writingWords} words</span></div>
                  <textarea id="writing-answer" value={writing} onChange={(event) => { setWriting(event.target.value); setWritingSubmitted(false); }} placeholder="Start writing in English…" />
                  <div className="writing-tools"><span><Icon name="clock" size={16} /> 构思与输入都会计入用时</span><button onClick={() => notify('语音输入为原型占位')} aria-label="语音输入"><Icon name="play" size={17} /></button></div>
                </div>
                {writingSubmitted && <div className="writing-feedback" aria-live="polite"><Icon name="check" size={18} /> 表达已记录。原型暂不进行 AI 评分。</div>}
              </div>
              <div className="card-footer">
                <button className="text-button" onClick={() => setWriting('')}>清空</button>
                <button className="primary-button" disabled={!writing.trim()} onClick={() => setWritingSubmitted(true)}>完成表达 <Icon name="arrow" size={19} /></button>
              </div>
              {creatorMeta('把今天的词，用进你自己的故事里')}
            </article>
            {actionRail(4)}
          </div>
        </section>
      </main>

      <div className="video-progress" aria-hidden="true"><i style={{ width: `${((activeSlide + 1) / slides.length) * 100}%` }} /></div>

      <nav className="bottom-nav" aria-label="主导航">
        <button className="nav-item active">首页</button>
        <button className="nav-item" onClick={() => notify('词库为原型占位')}>词库</button>
        <button className="create-button" onClick={() => notify('创建学习内容为原型占位')} aria-label="创建学习内容"><span><Icon name="plus" size={24} /></span></button>
        <button className="nav-item" onClick={() => notify('消息为原型占位')}>消息</button>
        <button className="nav-item" onClick={() => notify('个人中心为原型占位')}>我</button>
      </nav>

      <div className={`toast ${toast ? 'visible' : ''}`} role="status">{toast}</div>
    </div>
  );
}
