#!/usr/bin/env node
'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {createNewAlgorithmDb}=require('../lib/new-algorithm-db.ts');

const filename=process.argv[2];
if(!filename){console.error('Usage: node scripts/prepare-new-algorithm-v02-demo.cjs /tmp/flow-v02-demo.db');process.exit(2);}
const resolved=path.resolve(filename);
if(fs.existsSync(resolved)){console.error(`Refusing to overwrite existing file: ${resolved}`);process.exit(1);}
fs.mkdirSync(path.dirname(resolved),{recursive:true});
const db=createNewAlgorithmDb(resolved);
try{
  const now=Date.now();
  const timezone=Intl.DateTimeFormat().resolvedOptions().timeZone;
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
  db.prepare('INSERT INTO daily_capacity(local_date,timezone,capacity,completed) VALUES(?,?,100,0)').run(date,timezone);
  db.prepare('INSERT INTO meta(key,value) VALUES(?,\'00:00\'),(?,\'23:59\')').run(`training_window_start:${timezone}`,`training_window_end:${timezone}`);
  const addWord=db.prepare(`INSERT INTO words(id,term,meaning,target_r,target_p,score_r,score_p,introduced,fluency_pass_r,fluency_pass_p,learning_complete_r,learning_complete_p,review_level_r,due_at_r,due_at_p,graduated_r,graduated_p,local_timezone,created_at)
    VALUES(?,?,?,80,80,?,?,1,0,0,0,0,NULL,?,?,?,?,?,?)`);
  const addReservation=db.prepare(`INSERT INTO capacity_reservations(reservation_id,word_id,axis,local_date,timezone,reservation_kind,task_count,status) VALUES(?,?,?,?,?,'determined',1,'active')`);
  const addMaterial=db.prepare(`INSERT INTO materials(id,word_id,axis,stage,version,meaning_version,status,public_payload,answer_key,grading_requirements,timing_protocol,validation_json,created_at)
    VALUES(?,?,?, ?,1,1,'ready',?,?, '{}','{}','{}',?)`);
  const wordCases=[
    {id:1,term:'carry-r-choice',axis:'r',stage:'choice',score:5,other:100,graduatedOther:1},
    {id:2,term:'carry-r-cued',axis:'r',stage:'cued',score:20,other:100,graduatedOther:1},
    {id:3,term:'carry-r-free',axis:'r',stage:'free',score:40,other:100,graduatedOther:1},
    {id:4,term:'carry-p-choice',axis:'p',stage:'choice',score:5,other:100,graduatedOther:1},
    {id:5,term:'carry-p-cued',axis:'p',stage:'cued',score:20,other:100,graduatedOther:1},
    {id:6,term:'carry-p-free',axis:'p',stage:'free',score:40,other:100,graduatedOther:1},
  ];
  for(const item of wordCases){
    const scoreR=item.axis==='r'?item.score:item.other,scoreP=item.axis==='p'?item.score:item.other;
    addWord.run(item.id,item.term,'to carry; transport something from one place to another',scoreR,scoreP,new Date(now).toISOString(),new Date(now).toISOString(),item.axis==='r'?0:item.graduatedOther,item.axis==='p'?0:item.graduatedOther,timezone,now);
    addReservation.run(`v02:${item.id}`,item.id,item.axis,date,timezone);
    let payload,key;
    if(item.stage==='choice'){
      payload={question:'Which meaning best matches “carry”?',options:['transport something','forget something','close something']};key={correct_index:0};
    }else if(item.axis==='r'){
      payload={prompt:item.stage==='cued'?'Use the first-letter hint: t_______ something':'Explain the meaning of “carry” in your own words.'};key={target_meaning:'transport something from one place to another'};
    }else{
      payload={prompt:item.stage==='cued'?'Complete: She ___ the bag yesterday.':'Write the past-tense form of “carry”.'};key={target_form:'carried',allowed_inflections:['carried']};
    }
    addMaterial.run(`v02-material-${item.id}`,item.id,item.axis,item.stage,JSON.stringify(payload),JSON.stringify(key),now);
  }
  // This row lets the tester change R alone and see an immediate same-day requeue.
  addWord.run(7,'target-adjustment','R target is 80; P target should remain 80',80,60,new Date(now+86400000).toISOString(),new Date(now).toISOString(),0,0,timezone,now);
  db.prepare("UPDATE words SET fluency_pass_r=1,learning_complete_r=1,review_level_r=1 WHERE id=7").run();
  addReservation.run('v02-target-review-r',7,'r',new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now+86400000),timezone);
  const passage=Array(100).fill('targetword').join(' ');
  addMaterial.run('v02-target-fluency',7,'r','fluency',JSON.stringify({passage,questions:[{prompt:'What is the passage about?'},{prompt:'How is the target word used?'}]}),JSON.stringify({questions:[{answer:'A',evidence:'Passage evidence A'},{answer:'B',evidence:'Passage evidence B'}]}),now);
  console.log(`Prepared isolated V02 demo database: ${resolved}`);
  console.log(`Date: ${date} ${timezone}; 6 retrieval paths + 1 target-adjustment word; capacity 100.`);
  console.log('Start with: FLOW_NEW_ALGORITHM_DB='+resolved+' npm run dev -- -p 3102');
  console.log('Open: http://localhost:3102/new-algorithm and http://localhost:3102/new-algorithm/goals');
}finally{db.close();}
