#!/usr/bin/env node
'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {createNewAlgorithmDb}=require('../lib/new-algorithm-db.ts');

const filename=process.argv[2];
if(!filename){console.error('Usage: node scripts/prepare-new-algorithm-v03-v04-demo.cjs /tmp/flow-v03-v04-demo.db');process.exit(2);}
const resolved=path.resolve(filename);
if(fs.existsSync(resolved)){console.error(`Refusing to overwrite existing file: ${resolved}`);process.exit(1);}
fs.mkdirSync(path.dirname(resolved),{recursive:true});
const db=createNewAlgorithmDb(resolved);

function localDate(timestamp,timeZone){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(timestamp);
  const value=(key)=>parts.find(part=>part.type===key)?.value??'';
  return `${value('year')}-${value('month')}-${value('day')}`;
}
function dueAt(date,timeZone){
  const [year,month,day]=date.split('-').map(Number);
  let low=Date.UTC(year,month-1,day)-36*60*60*1000,high=Date.UTC(year,month-1,day)+36*60*60*1000;
  while(low<high){const mid=Math.floor((low+high)/2);if(localDate(mid,timeZone)<date)low=mid+1;else high=mid;}
  return new Date(low).toISOString();
}

try{
  const now=Date.now(),timezone=Intl.DateTimeFormat().resolvedOptions().timeZone,date=localDate(now,timezone);
  const tomorrow=localDate(now+36*60*60*1000,timezone);
  db.prepare('INSERT INTO daily_capacity(local_date,timezone,capacity,completed) VALUES(?,?,30,0),(?,?,30,0)')
    .run(date,timezone,tomorrow,timezone);
  db.prepare('INSERT INTO meta(key,value) VALUES(?,\'00:00\'),(?,\'23:59\')')
    .run(`training_window_start:${timezone}`,`training_window_end:${timezone}`);
  const insertWord=db.prepare(`INSERT INTO words(id,term,meaning,target_r,target_p,score_r,score_p,introduced,
    fluency_pass_r,learning_complete_r,review_level_r,due_at_r,due_at_p,local_timezone,created_at)
    VALUES(?,?,?,?,?,?,?,1,?,?,?,?,?,?,?)`);
  insertWord.run(1,'carry','transport something from one place to another',100,80,60,35,0,0,null,dueAt(date,timezone),dueAt(date,timezone),timezone,now);
  insertWord.run(2,'describe','explain what someone or something is like',80,100,80,80,1,1,1,dueAt(tomorrow,timezone),dueAt(date,timezone),timezone,now+1);
  const reserve=db.prepare(`INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status)
    VALUES(?,?,?, ?,?,'determined',1,'active')`);
  reserve.run('v03-r-fluency',1,'r',date,timezone);
  reserve.run('v04-p-fluency',2,'p',date,timezone);
  console.log(`Prepared isolated V03/V04 database: ${resolved}`);
  console.log(`Local date/timezone: ${date} ${timezone}; capacity: 30 tasks/day.`);
  console.log('V03 word: carry (R=60, target=100); V04 word: describe (P=80, target=100).');
  console.log('Generate materials at /new-algorithm/goals, then practice at /new-algorithm.');
  console.log(`Start with: FLOW_NEW_ALGORITHM_DB=${resolved} npm run dev -- -p 3103`);
}finally{db.close();}
