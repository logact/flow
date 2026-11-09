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


## P3 user vocabulary estimate and introduced-word scores

Verify that the user's estimated vocabulary size and comparable word-frequency rank produce the correct initial R/P scores. Cover all four PRD bands (`rank ≤ 0.5V`, `0.5V < rank ≤ V`, `V < rank ≤ 1.5V`, and above `1.5V` or unavailable rank), including boundary values and incomparable frequency sources.

Confirm that estimated scores do not count as FLUENCY evidence, do not mark an axis complete or graduated, and do not trigger ENCODE when either axis has a non-zero estimate. When both axes start at zero, schedule exactly one ENCODE task; completion initializes both axes to at least 5. Check that changing the vocabulary estimate does not reset scores or schedules for words already in practice.

Log the estimate, rank and source, selected band, initial R/P scores, and any reason the rank could not be compared. Use unit tests for the band boundaries and state-transition tests for introduction and ENCODE behavior.


## P4 daily capacity and the next 41 days

Implement the rolling capacity view for today through day 41 inclusive. For each local calendar day, report capacity, completed tasks, scheduled tasks, conditional reservations, remaining capacity, and any shortfall. Keep confirmed due tasks separate from conditional future reviews.

Before introducing a word, verify both today's task budget and the 41-day plan. Use the expected minimum first-day task count for its estimated-score band (3/5/7/9), account for shared cooldown and available practice time, and reserve each axis's expected reviews on days 1, 4, 11, and 41 after that axis is expected to reach its goal. Test different R/P completion dates and targets.

After each valid result, recompute only affected conditional reservations and capacity totals. Preserve the other axis's confirmed due date. Never move an overdue confirmed task to make room for a new word. Record the inputs, before/after capacity view, reservation changes, and the reason introduction was allowed or rejected. Add unit tests for boundaries, over-capacity days, failures, and rolling-window movement.

## p5 the logic of task assignment run with prioriry rightly.

genreate the unit test to cover and verify the logic ,you need persist the log (the task queue status,the task is taken ,and why it is taken)
2. 唯一派题顺序
对可派发且已满足共享冷却的候选按以下顺序选取：

已完成该轴学习但尚未毕业的轴中，due_at_a 为今天或更早的复习；最早 due_at_a 优先。
未完成该轴学习的轴中，due_at_a 为今天或更早的任务；最早 due_at_a 优先。同一词可以同时提供一个复习轴和一个学习轴候选。
当天及 41 天容量检查通过时引入新词；新词按来源可比较的词频、目标缺口、词 ID 和同词 R 优先稳定排序。
没有可派发旧任务且不能准入新词时返回今天完成、冷却等待、材料不可用或容量不足的具体原因。
已毕业轴 due_at_a = ∞ 不参加竞争。对同一 due_at_a 使用词 ID 升序、同词 R 先于 P 的稳定顺序。到期但因冷却未就绪的高优先级轴暂不阻塞其他可派候选；冷却结束时重新比较。到期轴未完成时保持原 due_at_a，跨日自动成为逾期，不能为了引入新词顺延。只有用户显式改变目标、范围或其他已排期前提时，才按新状态重算相应排期并记录原因。


## P6 AI task generation

Generate tasks that match the user's level, selected word sense, axis, score band, and task type. Use the PRD task ladder: ENCODE only when both initial scores are zero; R/P RETRIEVE choice, cued, or free for scores below 60; and axis-specific FLUENCY at 60 or above. Do not silently lower a task's difficulty when suitable material is unavailable.

Cover the following with representative fixtures and validation:

1. Generate R and P choice, cued, and free tasks with the required prompts and support for each level.
2. Generate R FLUENCY material with exactly 100 English words, at least five natural occurrences of the target word, two answerable comprehension questions, and fixed answers/evidence.
3. Generate P FLUENCY Chinese scenarios that elicit the target expression without revealing its English form, plus grading requirements for target use and overall expression.
4. Reject malformed, ambiguous, level-inappropriate, or target-sense-mismatched output; retry within a finite budget, then report material unavailable.
5. Cache validated material with its version and preserve the prompt inputs and raw AI output for inspection.

Log the model/provider, prompt inputs, generated output, validation results, retries, and failure reason so the user can assess generation quality. Test through the task-generation boundary with deterministic AI fixtures; do not treat generated material as valid until it passes checks.

## P7 AI grading for FLUENCY tasks

Use AI to grade submitted FLUENCY answers against requirements frozen when the task was issued. For P, return separate outcomes for correct target-word use and successful overall retelling, with evidence for each. For R, return separate outcomes for the target-word meaning question and passage-comprehension question. Preserve the answer and grading requirements used for every decision.

Apply the P1 score rules only after validity checks: invalid timing, interruption, bad material, or an AI/service error must not change scores or schedules. A grading result must not be recalculated from an edited answer; retry a service failure against the saved original answer. Test pass/fail combinations, target-word omission or misuse, semantically valid paraphrases, ambiguous answers, and service failures.

Log the model/provider, full grading inputs, submitted answer, structured output, evidence, validity checks, and score/schedule changes. Keep AI generation logs distinct from grading logs so the user can inspect both.



## P8 prototype UI

Build a basic HTML prototype that connects the verified vocabulary, material, task, grading, score, schedule, and capacity functions. Keep the flow small and usable; show the user what task is being done and why it was selected.

The prototype should support:

1. Estimate and save the user's vocabulary size, with a clear indication when frequency-rank data is unavailable or not comparable.
2. Select or introduce material, resolve/confirm target-word meaning, and initialize each word's R/P scores from the user's vocabulary estimate and word rank.
3. Practice ENCODE, all R/P RETRIEVE levels, and both FLUENCY task types with the appropriate prompt, answer input, timing, feedback, and score update.
4. Show current R/P scores, targets, next due dates, review levels, graduation state, today's queue/capacity, and why a task was selected or is unavailable.
5. Provide a task/event history that exposes AI generation and grading inputs/outputs and explains score and schedule changes.

Use the real verified core functions rather than duplicate UI-only rules. Keep the UI states for loading, empty queue, cooldown, capacity shortfall, unavailable material, invalid attempt, and grading failure explicit. Demonstrate the complete happy path and representative failure/recovery paths in the prototype.
 



