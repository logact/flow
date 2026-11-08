'use client';
import { useEffect, useRef, useState } from 'react';
import { meaningfulWordCount } from '../lib/new-algorithm-p-fluency';

export function PFluencyRenderer({scene, instructions, onSubmit, onStart, onInterrupt, onError}:{scene:string;instructions:string;onSubmit:(body:Record<string,unknown>)=>void;onStart:()=>Promise<void>;onInterrupt:()=>Promise<void>;onError?:(message:string)=>void}) {
  const [phase,setPhase]=useState<'ready'|'starting'|'writing'|'short'|'done'|'interrupted'>('ready');
  const [text,setText]=useState('');
  const started=useRef(false);
  useEffect(()=>{const visibility=()=>{if(document.visibilityState==='hidden'&&started.current){started.current=false;setPhase('interrupted');void onInterrupt().catch(error=>onError?.(error instanceof Error?error.message:'中断计时失败'));}};document.addEventListener('visibilitychange',visibility);return()=>document.removeEventListener('visibilitychange',visibility);},[onInterrupt,onError]);
  async function start(){setPhase('starting');try{await onStart();if(document.visibilityState==='hidden'){await onInterrupt();setPhase('interrupted');return;}started.current=true;setPhase('writing');}catch(error){setPhase('ready');onError?.(error instanceof Error?error.message:'无法开始计时');}}
  function submit(){if(!started.current)return;const words=meaningfulWordCount(text);if(words<30){setPhase('short');return;}onSubmit({text});started.current=false;setPhase('done');}
  return <section aria-label="P 流利写作">
    {(phase==='ready'||phase==='starting')&&<button type="button" disabled={phase==='starting'} onClick={()=>void start()}>{phase==='starting'?'正在开始…':'开始写作'}</button>}
    {phase==='interrupted'&&<><p role="alert">练习已中断，请重新开始计时。</p><button type="button" onClick={start}>重新开始</button></>}
    {(phase==='writing'||phase==='short')&&<><p>{scene}</p><p>{instructions}</p><textarea aria-label="写作回答" value={text} onChange={e=>setText(e.target.value)}/>{phase==='short'&&<p role="alert">至少写出 30 个有效词；草稿已保留。</p>}<button type="button" onClick={submit}>提交</button></>}
    {phase==='done'&&<p role="status">已提交</p>}
  </section>;
}
