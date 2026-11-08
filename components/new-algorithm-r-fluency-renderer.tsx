'use client';
import { useEffect, useRef, useState } from 'react';
import { RReadingClock } from '../lib/new-algorithm-r-timing';

export function RFluencyRenderer({ passage, questions, onSubmit, now = () => Date.now() }: { passage: string; questions: [string,string]; onSubmit: (body: Record<string,unknown>) => void; now?: () => number }) {
  const clock = useRef<RReadingClock | null>(null); if (!clock.current) clock.current = new RReadingClock(now);
  const [phase,setPhase] = useState<'ready'|'read'|'answer'|'review'|'done'>('ready'); const [answers,setAnswers] = useState(['','']); const [q,setQ] = useState(0);
  useEffect(()=>{ const onVisibility=()=>{ if(document.visibilityState==='hidden'){ clock.current?.interrupt(); setPhase('done'); } }; document.addEventListener('visibilitychange',onVisibility); return ()=>document.removeEventListener('visibilitychange',onVisibility); },[]);
  function begin(){ clock.current?.startRead(); setPhase('read'); }
  function finish(){ clock.current?.endRead(); setPhase('answer'); }
  function review(){ clock.current?.review(); clock.current?.startRead(); setPhase('review'); }
  function endReview(){ clock.current?.endRead(); setPhase('answer'); }
  function submit(){ const timing=clock.current?.submit(100); onSubmit({answers,timing_protocol:timing?.events,timing_valid:timing?.valid,reading_seconds:timing?.readingSeconds,wpm:timing?.wpm}); setPhase('done'); }
  return <section aria-label="R 流利阅读">
    {phase==='ready'&&<button onClick={begin}>开始阅读</button>}
    {(phase==='read'||phase==='review') && <><article>{passage}</article><button onClick={phase==='read'?finish:endReview}>{phase==='read'?'读完，回答问题':'完成回看'}</button></>}
    {phase==='answer' && <><p>{questions[q]}</p><textarea aria-label={`回答第 ${q+1} 题`} value={answers[q]} onChange={e=>setAnswers(a=>a.map((v,i)=>i===q?e.target.value:v))}/><button onClick={review}>回看原文</button><button onClick={()=>q===0?setQ(1):submit()}>{q===0?'下一题':'提交'}</button></>}
    {phase==='done'&&<p role="status">已提交</p>}
  </section>;
}
