# speedboat plan
This plan is target to develop fast and verify fast, and avoid the Cumbersome automation process and overdesign,In this prototype we need agile turn and we need keep our boat light,remove  all extral thinig but the core proces.

for more detail you can read the @RPD


# phases to achieve sequently 

## P1 basic fluency

I can see the fluent change and how they change to check the behavior of the fluent. I hope these log store in the log file.

generate the unit test to cover the following scenarios.

1. the word fluency=0 trigger the bind task, Pass the bind task and increase the score from 0 to 5 ,influence the fluency_P and fluency_R simultantely
2. the word 0< fluency <20 trigger the RETRIEVE / choice ,pass the task and increase by 20 and < 20 ,failed  decrease by 20 and keep > 0,influence the fluency_P and fluency_R respectively
3. the word 20<= fluency <40 trigger the RETRIEVE / cue ,pass the task and increase by 20 and < 60,failed  decrease by 20 and keep > 0,influence the fluency_P and fluency_R respectively
4. the word 40 <= fluency < 60 trigger the RETRIVE / free ,pass the task and increase by 20 and < 60,failed  decrease by 20 and keep >= 20,influence the fluency_P and fluency_R respectively
5. the word 60 < fluency < target trigger the  fluency work,increase or decrease according to the conditions.

here you need to create different wpm input to cover all of the following scenairo 

|目标表达| 整体复述 | 处理 |
|---|---|---|
| 通过 | 通过，且 `writing_wpm ≥ 25` | 按速度直接更新 P 分数 |
| 通过 | 通过，但 `writing_wpm < 25` | 设为 `40` |
| 通过 | 未通过 | 分数不变，记录整体表达未通过 |
| 未使用或使用错误 | 通过或未通过 | 设为 `40` |

```text
F_P_new = min(100, 60 + (writing_wpm − 25) × 40 / 35)
// 仅在两项通过、计时有效且 writing_wpm ≥ 25 时使用
```

| 目标词含义题 | 整段理解题 | 处理 |
|---|---|---|
| 正确 | 正确，且 `reading_wpm ≥ 150` | 按速度直接更新 R 分数 |
| 正确 | 正确，但 `reading_wpm < 150` | 设为 `40` |
| 正确 | 错误 | 分数不变，记录整段理解未通过 |
| 错误 | 正确或错误 | 设为 `40` |

```text
F_R_new = min(100, 60 + (reading_wpm − 150) / 3.75)
// 仅在两题都正确、计时有效且 reading_wpm ≥ 150 时使用
```
 influence the fluency_P and fluency_R respectively

## P2 schedule task right

I can see the due_at,review_interval change and how they change to check the behavior of the fluent. I hope these log store in the log file.

The due_at assign correctly

genraete the unit test case to cover the following cases.

1. before the word acheive the goal,the due_at assign to today
2. after the word acheive the goal,the due_at is assign to the next review day .
3. after the word achieved the goal,if user pass the review task (fluency type at the goal difficluty),it set the due_at by next review interval. IF the user failed,it set the due_at to the current day and  move back the review level：1→1、3→1、7→3、30→7 .
4. after the word pass the last review,it mark its due_at to ∞.


## P3 the logic of user's vacabulary capbility and the fluency score of the introduced word run rightly.


## p4 the capaicity for the next 40 days calculation 

## p5 the logic of task assignment run with prioriry rightly.

genreate the unit test to cover and verify the logic ,you need persist the log (the task queue status,the task is taken ,and why it is taken)
2. 唯一派题顺序
对可派发且已满足共享冷却的候选按以下顺序选取：

已完成该轴学习但尚未毕业的轴中，due_at_a 为今天或更早的复习；最早 due_at_a 优先。
未完成该轴学习的轴中，due_at_a 为今天或更早的任务；最早 due_at_a 优先。同一词可以同时提供一个复习轴和一个学习轴候选。
当天及 41 天容量检查通过时引入新词；新词按来源可比较的词频、目标缺口、词 ID 和同词 R 优先稳定排序。
没有可派发旧任务且不能准入新词时返回今天完成、冷却等待、材料不可用或容量不足的具体原因。
已毕业轴 due_at_a = ∞ 不参加竞争。对同一 due_at_a 使用词 ID 升序、同词 R 先于 P 的稳定顺序。到期但因冷却未就绪的高优先级轴暂不阻塞其他可派候选；冷却结束时重新比较。到期轴未完成时保持原 due_at_a，跨日自动成为逾期，不能为了引入新词顺延。只有用户显式改变目标、范围或其他已排期前提时，才按新状态重算相应排期并记录原因。


## p6 AI task generator 
you should log the input to the AI and the output let the user estimate the output
1. genrate the fluency task according to the user's level properly
2. generate the R[option/cue/free] tasks according to the user's level properly

## p7 AI estimator for the 
you should log the input to the AI and the output let the user estimate the output
   
1. let the AI estimate the output fluency task



## P8 the prototype html 
generate the basic UI to integerate the verified basic function
1. estimate the user's  vacubulary level,
2. introduce the material and init the word the fluence by user's word level
3. all kinds of type of the words let user to learn.
 



