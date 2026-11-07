'use client';

import { useState } from 'react';

type RetrievalPayload = { axis: 'r'|'p'; stage: 'choice'|'cued'|'free'; prompt: string; options?: string[] };

export function RetrievalRenderer({ payload, busy = false, onSubmit }: { payload: RetrievalPayload; busy?: boolean; onSubmit: (response: Record<string, unknown>) => void }) {
  const [choice, setChoice] = useState<number|null>(null);
  const [text, setText] = useState('');
  if (payload.stage === 'choice') return <section>
    <p>{payload.prompt}</p><div role="group" aria-label="选择答案">{(payload.options ?? []).map((option, i) => <button key={i} type="button" aria-pressed={choice===i} disabled={busy} onClick={()=>setChoice(i)}>{option}</button>)}</div>
    <button type="button" disabled={busy || choice===null} onClick={()=>choice!==null&&onSubmit({selected_index:choice})}>提交答案</button>
  </section>;
  return <section>
    <p>{payload.prompt}</p>
    <label>{payload.stage==='cued'?'根据提示回忆答案':'写出你的答案'}<textarea value={text} disabled={busy} onChange={e=>setText(e.target.value)} /></label>
    <button type="button" disabled={busy || !text.trim()} onClick={()=>onSubmit({answer:text})}>提交答案</button>
  </section>;
}
