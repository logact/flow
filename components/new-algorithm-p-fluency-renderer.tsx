'use client';
import { useEffect, useRef, useState } from 'react';
import { meaningfulWordCount } from '../lib/new-algorithm-p-fluency';

export function PFluencyRenderer({scene, instructions, onSubmit, now=()=>Date.now()}:{scene:string;instructions:string;onSubmit:(body:Record<string,unknown>)=>void;now?:()=>number}) {
  const [phase,setPhase]=useState<'ready'|'writing'|'short'|'done'|'interrupted'>('ready');
  const [text,setText]=useState('');
  const started=useRef<number|null>(null);
  useEffect(()=>{const visibility=()=>{if(document.visibilityState==='hidden'&&started.current!==null){started.current=null;setPhase('interrupted');}};document.addEventListener('visibilitychange',visibility);return()=>document.removeEventListener('visibilitychange',visibility);},[]);
  function start(){started.current=now();setPhase('writing');}
  function submit(){if(started.current===null)return;const words=meaningfulWordCount(text);if(words<30){setPhase('short');return;}const elapsedSeconds=Math.max(0,(now()-started.current)/1000);onSubmit({text,elapsed_seconds:elapsedSeconds});started.current=null;setPhase('done');}
  return <section aria-label="P 流利写作">
    {phase==='ready'&&<button type="button" onClick={start}>开始写作</button>}
    {phase==='interrupted'&&<><p role="alert">练习已中断，请重新开始计时。</p><button type="button" onClick={start}>重新开始</button></>}
    {(phase==='writing'||phase==='short')&&<><p>{scene}</p><p>{instructions}</p><textarea aria-label="写作回答" value={text} onChange={e=>setText(e.target.value)}/>{phase==='short'&&<p role="alert">至少写出 30 个有效词；草稿已保留。</p>}<button type="button" onClick={submit}>提交</button></>}
    {phase==='done'&&<p role="status">已提交</p>}
  </section>;
}
