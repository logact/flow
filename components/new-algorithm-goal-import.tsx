'use client';
import { useState } from 'react';

export function NewAlgorithmGoalImport() {
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [v,setV]=useState('4000'),[capacity,setCapacity]=useState('30'),[start,setStart]=useState('08:00'),[end,setEnd]=useState('22:00'),[rows,setRows]=useState('resilient|有韧性的|1000\noutcome|结果|3000'),[message,setMessage]=useState('');
  async function submit(){
    try {
      const cfg=await fetch('/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'configure',timezone,capacity:Number(capacity),windowStart:start,windowEnd:end})});
      if(!cfg.ok) throw new Error((await cfg.json()).error);
      const words=rows.split('\n').map(line=>line.trim()).filter(Boolean).map(line=>{const [term,meaning,rank]=line.split('|');return {term,confirmedMeaning:meaning||'',vocabularySize:Number(v),rank:Number(rank),timezone};});
      const res=await fetch('/api/new-algorithm/goals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'import',timezone,words})});
      const data=await res.json();if(!res.ok) throw new Error(data.error);setMessage(`已导入 ${data.ids.length} 个词`);
    }catch(e){setMessage(`未导入：${(e as Error).message}`);}
  }
  return <section className="card"><h2>新算法原型导入</h2><p>每日容量与本地训练窗口由你设置；词条格式：词 | 已确认释义 | 词频排名。</p><div style={{display:'flex',gap:8}}><input aria-label="词汇量" value={v} onChange={e=>setV(e.target.value)} /><input aria-label="每日容量" value={capacity} onChange={e=>setCapacity(e.target.value)} /><input type="time" value={start} onChange={e=>setStart(e.target.value)} /><input type="time" value={end} onChange={e=>setEnd(e.target.value)} /></div><textarea rows={4} value={rows} onChange={e=>setRows(e.target.value)} /><button className="primary" onClick={submit}>配置容量并导入</button><p role="status">{message}</p></section>;
}
