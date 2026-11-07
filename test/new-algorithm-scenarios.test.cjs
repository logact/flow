const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { stageForScore, retrievalScore, fluencyScore } = require(path.join(process.env.FLOW_TEST_BUILD_DIR, 'lib/new-algorithm-score.js'));

const cases = [
  { id:'R01', axis:'R', before:0, action:'ENCODE 确认', after:5, next:'choice' },
  { id:'R02', axis:'R', before:5, action:'choice 正确', after:20, next:'cued' },
  { id:'R03', axis:'R', before:20, action:'cued 正确', after:40, next:'free' },
  { id:'R04', axis:'R', before:40, action:'free 正确', after:60, next:'fluency' },
  { id:'R05', axis:'R', before:80, action:'FLUENCY 双题正确 200 wpm', after:60+50/3.75, next:'fluency' },
  { id:'R06', axis:'R', before:80, action:'FLUENCY 双题正确 149 wpm', after:40, next:'free' },
  { id:'R07', axis:'R', before:80, action:'FLUENCY 目标词错误 300 wpm', after:40, next:'free' },
  { id:'R08', axis:'R', before:80, action:'FLUENCY 仅整段理解错误', after:80, next:'fluency' },
  { id:'R09', axis:'R', before:40, action:'free 错误', after:20, next:'cued' },
  { id:'R10', axis:'R', before:20, action:'cued 错误', after:5, next:'choice' },
  { id:'P01', axis:'P', before:0, action:'ENCODE 确认', after:5, next:'choice' },
  { id:'P02', axis:'P', before:5, action:'choice 正确', after:20, next:'cued' },
  { id:'P03', axis:'P', before:20, action:'cued 正确', after:40, next:'free' },
  { id:'P04', axis:'P', before:40, action:'free 正确', after:60, next:'fluency' },
  { id:'P05', axis:'P', before:80, action:'FLUENCY 双项正确 42.5 wpm', after:80, next:'fluency' },
  { id:'P06', axis:'P', before:80, action:'FLUENCY 双项正确 24.9 wpm', after:40, next:'free' },
  { id:'P07', axis:'P', before:80, action:'FLUENCY 目标表达错误 60 wpm', after:40, next:'free' },
  { id:'P08', axis:'P', before:80, action:'FLUENCY 仅整体表达错误', after:80, next:'fluency' },
  { id:'P09', axis:'P', before:80, action:'FLUENCY 计时无效', after:80, next:'fluency' },
  { id:'P10', axis:'P', before:80, action:'FLUENCY 判分不确定', after:80, next:'fluency' },
  { id:'P11', axis:'P', before:40, action:'free 错误', after:20, next:'cued' },
];

function calculate(c) {
  if (c.action.startsWith('ENCODE')) return 5;
  for (const stage of ['choice','cued','free']) if (c.action.startsWith(stage)) return retrievalScore(stage,c.action.includes('正确'));
  const axis=c.axis.toLowerCase();
  if (c.action.includes('计时无效')) return fluencyScore(axis,c.before,{kind:'invalid'}).score;
  if (c.action.includes('判分不确定')) return fluencyScore(axis,c.before,{kind:'uncertain'}).score;
  const wpm=Number(c.action.match(/[\d.]+(?= wpm)/)?.[0] ?? 300);
  return fluencyScore(axis,c.before,{kind:'valid',targetPassed:!c.action.includes('目标词错误')&&!c.action.includes('目标表达错误'),overallPassed:!c.action.includes('整段理解错误')&&!c.action.includes('整体表达错误'),wpm}).score;
}

const results=[];
for (const c of cases) test(`${c.id} ${c.action}: ${c.before} → ${c.after} → ${c.next}`,()=>{
  const current=stageForScore(c.before),actual=calculate(c),next=stageForScore(actual);
  assert.equal(current,c.before===0?'encode':c.before<20?'choice':c.before<40?'cued':c.before<60?'free':'fluency');
  assert.equal(actual,c.after);assert.equal(next,c.next);
  results.push({ ...c,current,actual,next:stageForScore(actual),status:'PASS' });
});

process.on('exit',()=>{
  if (!process.env.FLOW_SCENARIO_REPORT) return;
  const lines=[
    '# 新算法场景与分数变化报告',
    '',
    '范围：新版纯函数的“当前分数→应做档位→结算分数→下一应做档位”。下一档是算法要求，尚未证明正式调度器签发了该任务。所有数值使用未舍入值断言。',
    '',
    '| ID | 轴 | 当前分数 | 当前档位 | 场景 | 期望分数 | 实际分数 | 下一档 | 结果 |',
    '|---|---|---:|---|---|---:|---:|---|---|',
    ...results.map(r=>`| ${r.id} | ${r.axis} | ${r.before} | ${r.current} | ${r.action} | ${r.after} | ${r.actual} | ${r.next} | ${r.status} |`),
    '',
    `已执行 ${results.length}/${cases.length} 个场景。`,
    '',
    '未覆盖：词/轴调度优先级、冷却与急救、正式材料签发、API、UI。待新版调度器接入后增加“实际签发 task.type/stage/material_id”断言；本报告不将下一档投影冒充已签发任务。',
    ''
  ];
  fs.writeFileSync(process.env.FLOW_SCENARIO_REPORT,lines.join('\n'));
});
