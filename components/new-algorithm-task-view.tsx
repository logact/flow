'use client';

import { useCallback, useEffect, useState } from 'react';
import { RetrievalRenderer } from './new-algorithm-retrieval-renderer';
import { RFluencyRenderer } from './new-algorithm-r-fluency-renderer';
import { PFluencyRenderer } from './new-algorithm-p-fluency-renderer';
import Link from 'next/link';

type Task = {instanceId:string;wordId:number;axis:'r'|'p'|'both';type:'ENCODE'|'RETRIEVE'|'FLUENCY';stage:'encode'|'choice'|'cued'|'free'|'fluency';purpose:string;scoreBefore:number;issuedAt:number;payload:Record<string,unknown>};
type Result = {settlement:{scoreBefore:number;scoreAfter:number;tick:number;replay:boolean};replay:boolean;axis:string;type:string};

export default function NewAlgorithmTaskView(){
  const [task,setTask]=useState<Task|null>(null); const [empty,setEmpty]=useState<string|null>(null);
  const [error,setError]=useState(''); const [busy,setBusy]=useState(false); const [result,setResult]=useState<Result|null>(null);
  const [selected,setSelected]=useState<number|null>(null);
  const load=useCallback(async()=>{setError('');setResult(null);setSelected(null);try{const pendingKey=Object.keys(sessionStorage).find(key=>key.startsWith('new-algorithm-answer:'));
    if(pendingKey){const instanceId=pendingKey.slice('new-algorithm-answer:'.length);const pendingTaskResponse=await fetch(`/api/new-algorithm/task?instanceId=${encodeURIComponent(instanceId)}`,{cache:'no-store'});const pendingTask=await pendingTaskResponse.json();if(!pendingTaskResponse.ok)throw new Error(pendingTask.error||'无法恢复已提交答案');const saved=JSON.parse(sessionStorage.getItem(pendingKey)!) as Record<string,unknown>;setTask(pendingTask);setEmpty(null);const replay=await fetch('/api/new-algorithm/task',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({instanceId,response:saved})});const replayData=await replay.json();if(replay.ok&&replayData.action!=='retry'){sessionStorage.removeItem(pendingKey);setResult({...replayData,axis:pendingTask.axis,type:pendingTask.type});setTask(null);}else setError(replayData.error||'答案已保留，点击重试继续结算。');return;}
    const response=await fetch('/api/new-algorithm/task',{cache:'no-store'});const data=await response.json();if(!response.ok)throw new Error(data.error||'无法读取任务');if(data.type==='EMPTY'){setTask(null);setEmpty(data.reason);return;}setEmpty(null);setTask(data);
  }catch(e){setError((e as Error).message);}},[]);
  useEffect(()=>{void load();},[load]);
  async function submit(responseBody:Record<string,unknown>){if(!task||busy)return;const completedTask=task;setBusy(true);setError('');sessionStorage.setItem(`new-algorithm-answer:${completedTask.instanceId}`,JSON.stringify(responseBody));try{const response=await fetch('/api/new-algorithm/task',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({instanceId:completedTask.instanceId,response:responseBody})});const data=await response.json();if(!response.ok)throw new Error(data.error||'提交失败');if(data.action==='retry')throw new Error('判分暂时无法确认');sessionStorage.removeItem(`new-algorithm-answer:${completedTask.instanceId}`);setResult({...data,axis:completedTask.axis,type:completedTask.type});setTask(null);}catch(e){setError(`${(e as Error).message}；答案已保留，可重试结算。`);}finally{setBusy(false);}}
  async function end(action:'skip'|'exit'){if(!task||busy)return;setBusy(true);setError('');try{const response=await fetch('/api/new-algorithm/task',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({instanceId:task.instanceId,action})});const data=await response.json();if(!response.ok)throw new Error(data.error||'操作失败');sessionStorage.removeItem(`new-algorithm-answer:${task.instanceId}`);setTask(null);await load();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  const frozenAnswer=task&&typeof window!=='undefined'?sessionStorage.getItem(`new-algorithm-answer:${task.instanceId}`):null;
  const options=Array.isArray(task?.payload.options)?task.payload.options.filter((x):x is string=>typeof x==='string'):[];
  return <main style={{maxWidth:720,margin:'40px auto',padding:'24px',fontFamily:'system-ui,sans-serif',color:'#18212f'}}>
    <header><h1>新算法练习</h1><p>隔离的新算法任务流 · <Link href="/new-algorithm/goals">调整 R/P 目标</Link></p></header>
    {error&&<p role="alert" style={{color:'#a32020'}}>{error}</p>}
    {result&&<section aria-live="polite"><h2>结算完成{result.replay?'（重复请求，已返回原结果）':''}</h2><p>{result.axis.toUpperCase()} {result.type}：{result.settlement.scoreBefore} → {result.settlement.scoreAfter} 分；tick {result.settlement.tick}</p><button onClick={()=>void load()}>下一题</button></section>}
    {!task&&!result&&<section><p>{empty?`当前没有可派任务：${empty}`:'正在读取任务…'}</p><button onClick={()=>void load()}>重新检查</button></section>}
    {task&&<section aria-labelledby="task-title"><p>词条 #{task.wordId} · {task.axis.toUpperCase()} · {task.stage}</p><h2 id="task-title">{task.type==='ENCODE'?'确认建立词义连接':String(task.payload.question??task.payload.prompt??task.payload.text??'提取练习')}</h2>
      {error&&frozenAnswer&&<button disabled={busy} onClick={()=>void submit(JSON.parse(frozenAnswer) as Record<string,unknown>)}>用已保存答案重试</button>}
      {task.type==='ENCODE'?<><p>{String(task.payload.text??'确认这个词及其词义。')}</p><button disabled={busy} onClick={()=>void submit({confirmed:true})}>确认并继续</button></>:task.type==='FLUENCY'&&task.axis==='r'?<RFluencyRenderer passage={String(task.payload.passage??'')} questions={(Array.isArray(task.payload.questions)?task.payload.questions.map(q=>String((q as {prompt?:unknown}).prompt??'')):['','']) as [string,string]} onSubmit={body=>void submit(body)}/>:task.type==='FLUENCY'?<PFluencyRenderer scene={String(task.payload.scene_zh??'')} instructions={String(task.payload.instructions_zh??'')} onSubmit={body=>void submit(body)}/>:<RetrievalRenderer payload={{axis:task.axis==='p'?'p':'r',stage:task.stage as 'choice'|'cued'|'free',prompt:String(task.payload.prompt??task.payload.question??''),options}} busy={busy} onSubmit={body=>void submit(body)} />}
      <footer>{!frozenAnswer&&<button disabled={busy} onClick={()=>void end('skip')}>跳过此题</button>}<button disabled={busy} onClick={()=>void end('exit')}>退出本次练习</button></footer>
    </section>}
  </main>;
}
