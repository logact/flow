'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';

type Word={id:number;term:string;meaning:string;score_r:number;score_p:number;target_r:number;target_p:number;introduced:number;due_at_r:string|null;due_at_p:string|null};
type Draft={targetR:number;targetP:number};

export default function NewAlgorithmGoalsPage(){
  const [words,setWords]=useState<Word[]>([]);const [drafts,setDrafts]=useState<Record<number,Draft>>({});
  const [error,setError]=useState('');const [message,setMessage]=useState('');const [busy,setBusy]=useState<number|null>(null);const [materialBusy,setMaterialBusy]=useState<string|null>(null);
  const timezone=typeof window==='undefined'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone;
  const load=useCallback(async()=>{
    setError('');
    try{const response=await fetch(`/api/new-algorithm/goals?timezone=${encodeURIComponent(timezone)}`,{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'无法读取新版目标');
      const rows=data.words as Word[];setWords(rows);setDrafts(Object.fromEntries(rows.map(word=>[word.id,{targetR:word.target_r,targetP:word.target_p}])));
    }catch(e){setError((e as Error).message);}
  },[timezone]);
  useEffect(()=>{void load();},[load]);
  async function save(word:Word){const draft=drafts[word.id];if(!draft)return;setBusy(word.id);setError('');setMessage('');
    try{const response=await fetch('/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'target',wordId:word.id,...draft})});const data=await response.json();if(!response.ok)throw new Error(data.error||'目标保存失败');
      const axes=[...(data.requeuedAxes??[]).map((axis:string)=>`${axis.toUpperCase()} 已回到今日学习`),...(data.capacityBlockedAxes??[]).map((axis:string)=>`${axis.toUpperCase()} 因容量不足暂未重排`)];
      setMessage(`${word.term}：目标已保存。${axes.join('；')}`);await load();
    }catch(e){setError((e as Error).message);}finally{setBusy(null);}
  }
  async function generateFluency(word:Word,axis:'r'|'p'){const key=`${word.id}:${axis}`;setMaterialBusy(key);setError('');setMessage('');
    try{const response=await fetch('/api/new-algorithm/materials',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wordId:word.id,axis})});const data=await response.json();if(!response.ok)throw new Error(data.error||'材料生成未通过校验');
      setMessage(`${word.term}：${axis.toUpperCase()} 流利材料已生成并通过校验（${data.attempts} 次尝试）。`);
    }catch(e){setError((e as Error).message);}finally{setMaterialBusy(null);}}
  return <main style={{maxWidth:900,margin:'32px auto',padding:24,fontFamily:'system-ui,sans-serif',color:'#18212f'}}>
    <header><Link href="/new-algorithm">← 返回练习</Link><h1>新算法目标设置</h1><p>R 阅读和 P 写作目标分别设置；目标变化会重新检查该轴的学习资格和容量。</p></header>
    {error&&<p role="alert" style={{color:'#a32020'}}>{error}</p>}{message&&<p role="status">{message}</p>}
    {words.length===0&&!error?<p>新版隔离库中还没有词条。</p>:<div style={{display:'grid',gap:16}}>{words.map(word=>{const draft=drafts[word.id]??{targetR:word.target_r,targetP:word.target_p};return <section key={word.id} style={{border:'1px solid #d8dee8',borderRadius:12,padding:16}}>
      <h2 style={{marginTop:0}}>{word.term}</h2><p>{word.meaning}</p><p>当前分数：R {word.score_r} · P {word.score_p}</p>
      <div style={{display:'flex',gap:20,flexWrap:'wrap'}}>
        <label>R 阅读目标（60–100）<input aria-label={`${word.term} R 阅读目标`} type="number" min={60} max={100} step={1} value={draft.targetR} onChange={e=>setDrafts(value=>({...value,[word.id]:{...draft,targetR:Number(e.target.value)}}))}/></label>
        <label>P 写作目标（60–100）<input aria-label={`${word.term} P 写作目标`} type="number" min={60} max={100} step={1} value={draft.targetP} onChange={e=>setDrafts(value=>({...value,[word.id]:{...draft,targetP:Number(e.target.value)}}))}/></label>
      </div>
      <button type="button" disabled={busy===word.id} onClick={()=>void save(word)}>{busy===word.id?'保存中…':'保存目标'}</button>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:12}}>
        <button type="button" disabled={materialBusy===`${word.id}:r`} onClick={()=>void generateFluency(word,'r')}>{materialBusy===`${word.id}:r`?'正在生成 R 阅读材料…':'生成 R 阅读流利材料'}</button>
        <button type="button" disabled={materialBusy===`${word.id}:p`} onClick={()=>void generateFluency(word,'p')}>{materialBusy===`${word.id}:p`?'正在生成 P 写作场景…':'生成 P 写作流利材料'}</button>
      </div>
    </section>;})}</div>}
    <button type="button" onClick={()=>void load()}>刷新目标</button>
  </main>;
}
