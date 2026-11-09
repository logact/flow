# speedboat plan
This plan is target to develop fast and verify fast, and avoid the Cumbersome automation process and overdesign,In this prototype we need agile turn and we need keep our boat light,remove  all extral thinig but the core proces.

for more detail you can read the @RPD


# phases to achieve sequently 

## P1 basic fluency

implement the baisc fluency increase and descrease function  

### how to test?
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

make the schedule work well

### how to test

I can see the due_at,review_interval change and how they change to check the behavior of the fluent. I hope these log store in the log file.

The due_at assign correctly

genraete the unit test case to cover the following cases.

1. before the word acheive the goal,the due_at assign to today
2. after the word acheive the goal,the due_at is assign to the next review day .
3. after the word achieved the goal,if user pass the review task (fluency type at the goal difficluty),it set the due_at by next review interval. IF the user failed,it set the due_at to the current day and  move back the review level：1→1、3→1、7→3、30→7 .
4. after the word pass the last review,it mark its due_at to ∞.


## P3 user vocabulary estimate and introduced-word scores

Implement the PRD's initial-score estimate and word introduction boundary. `lib/scoring.ts` currently owns task selection and result scoring; it has no vocabulary estimate, rank provenance, or introduction state. Keep estimated scores separate from score-result settlement so estimates cannot be mistaken for answer evidence.

### Proposed input/output contract

Use one new estimator and the existing task selector. Estimation is pure and returns initial R/P scores; the caller stores those scores in a new word's state and passes each score to `selectTask()`. A zero score selects ENCODE, so P3 does not add an `introduceWord()` API or a separate `encodePending` input. The existing `score()` remains responsible for its own score event when ENCODE is completed.

```ts
type EstimateBand = 'common' | 'known' | 'less_common' | 'unknown';
type RankSource = { id: string; basis: string };

interface VocabularyEstimate {
  size: number;                 // V, must be finite and > 0
  rankSource: RankSource;       // identifies how V's rank scale was produced
}
interface WordFrequencyRank {
  value: number | null;         // positive rank; null means unavailable
  source: RankSource | null;    // null means unavailable
}
interface InitialScoreEstimateInput {
  vocabulary: VocabularyEstimate;
  wordRank: WordFrequencyRank;
}
interface InitialScoreEstimate {
  R: number;
  P: number;
  band: EstimateBand;
  comparable: boolean;
  reason?: 'rank_unavailable' | 'rank_source_missing' | 'rank_source_mismatch' | 'invalid_vocabulary_size' | 'invalid_rank';
}
function estimateInitialScores(input: InitialScoreEstimateInput): InitialScoreEstimate;
```

`RankSource.id` plus `basis` must match exactly before comparing values. Invalid or non-comparable rank produces the `unknown` band and `(0,0)`; malformed numeric input is reported by `reason` rather than silently compared. The function returns no evidence flags, schedule, persistence handle, or timestamp. The caller applies its result only when creating an eligible new word, preserves any existing word's scores and schedules when V changes, then calls `selectTask()` for task choice. With the agreed rule, `selectTask(0)` returns ENCODE; nonzero scores follow the existing RETRIEVE/FLUENCY thresholds. Since ENCODE initializes both axes, its completion passes both current scores to `score({ task: 'ENCODE', state: { R, P }, completed: true })`.

The estimate event should include V and its source, rank and its source, comparability/reason, selected band, and initial R/P scores. Persist it at the caller that applies an estimate; do not make `estimateInitialScores` write to disk. ENCODE completion continues to use the score event emitted by `score()`.

### Implementation plan

1. Define typed inputs for a saved vocabulary estimate (`V > 0` and its rank-source identity), a word's optional frequency rank and source, and the word's current practice state. Treat rank as a rank, never as a raw frequency count.
2. Add a deterministic, side-effect-free estimator (for example `estimateInitialScores`) that returns `{ R, P, band, comparable, reason }`. Compare ranks only when the source and ranking basis are explicitly compatible. Use the PRD table: `rank ≤ 0.5V → (60,40)`, `0.5V < rank ≤ V → (40,20)`, `V < rank ≤ 1.5V → (20,5)`, and `rank > 1.5V` or unavailable/incomparable rank `→ (0,0)`.
3. Update the task-selection contract so `selectTask(0)` returns ENCODE and nonzero scores retain the existing RETRIEVE/FLUENCY thresholds. ENCODE completion uses the unified `score({ task: 'ENCODE', state: { R, P }, completed: true })` path and initializes both axes to at least 5.
4. Keep estimate application at the word-creation caller: apply the estimated scores only to a new eligible word, leave learning evidence and schedule defaults untouched, and never recalculate an in-practice word when `V` changes. Do not implement P4 capacity admission here.
5. Persist a `vocabulary.estimated` event where the estimate is applied. Include V and its source, rank and its source, comparability/reason, selected band, initial R/P scores, and selected first task. Keep the score event emitted by `score()` as the record of ENCODE settlement; estimates must not create FLUENCY evidence.

### Tests and acceptance

Create `test/vocabulary.jest.test.ts` and a dedicated `npm run test:p3` command. Cover exact boundaries at `0.5V`, `V`, and `1.5V`, values immediately on either side, missing/invalid V or rank, and same-source versus incomparable rank sources. Assert the estimator is deterministic and does not mutate input.

Test that estimated scores select the intended first task: nonzero bands use the existing score thresholds and `(0,0)` selects ENCODE. Verify ENCODE completion changes both axes to at least 5 through `score()`. Verify applying a new V affects future words only and leaves an in-practice word's scores and due dates intact. Capture estimate and score events at their respective caller boundaries and confirm estimates create no FLUENCY-pass evidence. Keep capacity checks and the 3/5/7/9 daily task admission enforcement for P4.

Human verification: use fixtures at each band and inspect the persistent event log for V/source, rank/source, chosen band, initial R/P scores, and selected first task. Complete ENCODE once for a `(0,0)` word and confirm its score event updates both axes to 5. Re-estimate V after a word enters practice and confirm its score and schedule are unchanged; verify no estimate event is reported as a FLUENCY pass.


## P3.1 user vocabulary capaicity estimate

Implement `estimateVocabularyCapacity(test)` as a pure function. The input contains the rank-list identity and one or more test strata; each stratum defines the sampled rank interval plus its correct and total answer counts. Estimate known vocabulary by adding each interval's width multiplied by its correct-answer proportion. Return `{ size, rankSource }`, exactly matching P3's `VocabularyEstimate`, so the result can be passed to `estimateInitialScores()` without conversion.

Reject empty tests, malformed rank intervals, invalid answer counts, or missing source identity. Keep the estimator pure; `recordVocabularyCapacityEstimate()` writes a `vocabulary.capacity_estimated` event with the test strata, rank-list identity, and resulting P3-compatible estimate. This proportional extrapolation assumes each stratum's questions are representative samples of its rank interval.

Test multiple strata, all-correct/all-incorrect results, malformed input, deterministic output, and compatibility with P3's input contract.

## P4 daily capacity and the next 41 days

Implement a function that answers the product question directly: **how many more new words can the user introduce today?** It uses the user's existing study plan, future study plan, candidate new words, and maximum task volume per day. Return the count and the admission simulation that justifies it. Also expose the underlying 42-day daily-capacity view so the result can be inspected. Keep planning pure and logging at the application boundary; do not duplicate P1 scoring or P2 schedule settlement. The window is the user's local date today through today + 41 days, inclusive (42 rows). Each task consumes one slot; a connection task is one task even though it initializes both axes.

### Contract

Keep confirmed work, conditional forecasts, and actual completions separately visible. Use a per-date row equivalent to:

```ts
interface DailyCapacity {
  date: string;                 // ISO local calendar date
  capacity: number;
  completed: number;             // valid tasks already completed on this date
  confirmed: number;             // unfinished axes whose current dueAt is this date
  overdue: number;               // confirmed work due before asOf, surfaced on today's row
  conditional: number;           // future reviews on the modeled success path
  remaining: number;             // capacity - completed - confirmed - overdue - conditional
  shortfall: number;             // max(0, -remaining)
}
interface CapacityPlan {
  asOf: string;
  through: string;               // asOf + 41 local days
  days: DailyCapacity[];         // exactly 42 rows
  firstOverCapacityDate: string | null;
}
interface NewWordCapacityResult {
  asOf: string;
  maxNewWordsToday: number;
  admittedWordIds: string[];     // candidates that fit in the simulated order
  blockedWordId: string | null;  // first candidate that cannot be admitted
  blockingDate: string | null;   // earliest day its addition exceeds capacity
  reason: 'capacity_reached' | 'candidate_unavailable' | 'no_candidates' | null;
  plan: CapacityPlan;            // final view after admitting the prefix
}
```

Plan inputs must include the local `asOf` date, daily capacity policy, words in the active scope, their independent R/P `AxisSchedule`s, and valid completed-task counts by date. Inject dates/counts rather than reading the clock or logs inside the planner. Treat `dueAt: 'infinity'` and graduated axes as no work. A finite `dueAt` before `asOf` remains unchanged in the word state, but is surfaced in today's `overdue` count and consumes today's projected capacity; expose shortfall rather than silently rewriting its due date. A due date equal to `asOf` is `confirmed`, not `overdue`. Dates beyond day 41 do not create rows, and the plan must say its horizon ends at day 41.

The plan should expose conditional reservations with provenance (word ID, axis, calculated attainment date, review date, and modeled path), so each conditional count can be explained. Calculate attainment dates inside the planner from each axis's current score/target, due_at, task ladder, and remaining daily task slots; callers must not supply attainment dates. Assume the shortest all-success task path, including a shared ENCODE task when both initial scores are zero. After an axis first reaches its target through valid FLUENCY, reserve that axis's next successful reviews at +1, +4, +11, and +41 local days from its own calculated attainment date. R and P use their own targets and attainment dates. Only include reservations inside the rolling window. These are forecasts, never due tasks or logged user outcomes.

Provide two pure functions: `planCapacity(input): CapacityPlan` and `estimateNewWordCapacity(input): NewWordCapacityResult`. The latter takes the existing current/future study plan, `maxTasksPerDay` (or a per-day maximum policy), completed-task counts, and an ordered pool of eligible unintroduced candidates with their P3 estimates, task paths, and required materials. It simulates introducing candidates in that stable order, overlaying each candidate's expected first-day task demand (P3 band mapping 3/5/7/9) plus R/P future review reservations. `maxNewWordsToday` is the number of consecutive candidates that can be admitted today without any date in the 42-day window exceeding the user's maximum daily task volume. Return the admitted IDs, first blocked candidate, first blocking date, and final plan so the number is explainable. A no-candidate pool returns zero with `no_candidates`; distinguish this from capacity being exhausted.

Candidate forecasts must provide P3's estimate band and the R/P targets; derive initial scores from that band and calculate the shortest successful task path internally. Admission only succeeds when that complete first-day path fits today's remaining capacity and material/cooldown/time checks pass, so an admitted candidate's forecast attainment date is today. Stop at the first ineligible candidate in stable order and return its reason. Keep a lower-level `checkWordAdmission({ plan, candidate, ... })` if useful, with a stable reason, blocking date, and proposed reservations; rejection must not mutate inputs. The 3/5/7/9 first-day task demand is explicitly tested against the P3 score bands and target defaults.

### Recompute and persistence

On each valid task result, first use the existing scoring/scheduling flow to settle the affected axis. Rebuild that word's conditional success-path reservations from its actual new state and actual first-attainment date, then recompute daily totals. Keep the other axis's schedule and confirmed due date byte-for-byte unchanged. A failed but valid result replaces only the affected axis's now-invalid success-path forecast with reservations derived from its actual state; do not keep claiming the original shortest path. Invalid, interrupted, or unavailable-material attempts consume no completed-task slot and cause no score/schedule change (per P1/P2); they may be logged as attempt events outside capacity completion counts.

Log at the application boundary, not inside the pure planner. Capacity/admission events should include the as-of date, capacity policy, relevant current confirmed schedules, completion counts, candidate and its P3 band/task demand, before/after 42-day summaries, added/removed conditional reservations, decision, first over-capacity date, and reason. Keep event payloads bounded and structured; do not write all unrelated word state if a stable summary plus affected word IDs/reservations is sufficient to reproduce the decision. P3 estimate events remain separate.

### Implementation sequence

1. Confirm the 3/5/7/9 first-day-demand mapping against P3 bands and capture it as a named pure function/table.
2. Define capacity inputs, daily rows, conditional-reservation and result types; validate finite non-negative maximums/counts, ISO local dates, and unique word/axis entries.
3. Implement the pure 42-day current-plan view, including overdue accounting and completed counts.
4. Calculate each unfinished current axis's fastest successful task path and attainment date from its score, target, due_at, and daily capacity. Add per-axis conditional review forecasts from those calculated dates; completed axes forecast from their next due_at/reviewLevel. Ignore dates beyond the horizon.
5. Implement single-candidate admission simulation; check today's tasks/time/cooldown and every day in the 42-day horizon, returning the earliest limiting date and reason.
6. Implement `estimateNewWordCapacity` by repeatedly simulating the ordered eligible candidate pool against the updated provisional plan; report the admitted count and first candidate/date that cannot fit.
7. Wire valid task settlement to recompute only the changed axis forecast, preserve the other axis schedule, and emit persistent before/after capacity/admission logs.
8. Add a dedicated `npm run test:p4` command and keep P4 tests in TypeScript, separate from the general suite.

### Tests and acceptance

Cover: exactly 42 rows and inclusive day-41 boundary; local-date arithmetic across month/year/leap-day boundaries; uniform and per-day maximums; completed, confirmed, overdue, conditional, remaining, and shortfall arithmetic; `infinity`/graduated axes; overdue due dates retained in state and charged to today's view; both axes due on one date counting as one shared ENCODE task or two independent tasks as applicable; asymmetric R/P targets and internally calculated attainment dates from score/task paths; reservations on days 1/4/11/41; reservations that fall outside the horizon; 3/5/7/9 demand mapping; candidate pool empty; one/many candidates admitted; heterogeneous candidate bands and stable ordering; exactly-at-capacity and one-over cases; future bottleneck and earliest blocking date; material/cooldown/time ineligibility; valid failure replacing only affected forecasts; invalid attempts leaving counts, scores, schedules, and forecasts unchanged; rolling the as-of date by one day; deterministic output and no input mutation; persistent event fields and reason codes. Assert `maxNewWordsToday === admittedWordIds.length` and that simulating one additional candidate demonstrates the returned blocking reason/date.

Human verification: with a fixed date and small maximum task volume, inspect the returned `maxNewWordsToday` and admitted IDs alongside all 42 rows. Add one candidate at a time until the first candidate is blocked; verify the reported blocking date is the earliest over-capacity date. Repeat after an R result, a P result on a different date, a valid failure, and moving the window forward one day. Reconcile row totals against event records; confirm a failure changes only its own axis forecast and overdue confirmed tasks keep their original `dueAt`.

## p5 the logic of task assignment run with prioriry rightly.

genreate the unit test to cover and verify the logic ,you need persist the log (the task queue status,the task is taken ,and why it is taken)
2. 唯一派题顺序
对可派发且已满足共享冷却的候选按以下顺序选取：

已完成该轴学习但尚未毕业的轴中，due_at_a 为今天或更早的复习；最早 due_at_a 优先。
未完成该轴学习的轴中，due_at_a 为今天或更早的任务；最早 due_at_a 优先。同一词可以同时提供一个复习轴和一个学习轴候选。
当天及 41 天容量检查通过时引入新词；新词按来源可比较的词频、目标缺口、词 ID 和同词 R 优先稳定排序。
没有可派发旧任务且不能准入新词时返回今天完成、冷却等待、材料不可用或容量不足的具体原因。
已毕业轴 due_at_a = ∞ 不参加竞争。对同一 due_at_a 使用词 ID 升序、同词 R 先于 P 的稳定顺序。到期但因冷却未就绪的高优先级轴暂不阻塞其他可派候选；冷却结束时重新比较。到期轴未完成时保持原 due_at_a，跨日自动成为逾期，不能为了引入新词顺延。只有用户显式改变目标、范围或其他已排期前提时，才按新状态重算相应排期并记录原因。

人工观察与核验：使用固定时钟和可控词/轴数据，逐个触发“到期复习优先、到期学习其次、新词最后、毕业轴跳过、同到期时间按词 ID 且 R 优先”的队列场景。查看任务队列日志中的候选、冷却状态、材料状态、容量判断、最终选中任务及原因，并与上述顺序逐项核对。另验证高优先级候选在冷却中时其他可派任务仍能出现；跨日后到期时间保持不变且显示逾期。每个场景写成调度单元测试，并保存一份可供人工查看的队列日志。


## P6 AI task generation

Generate tasks that match the user's level, selected word sense, axis, score band, and task type. Use the PRD task ladder: ENCODE only when both initial scores are zero; R/P RETRIEVE choice, cued, or free for scores below 60; and axis-specific FLUENCY at 60 or above. Do not silently lower a task's difficulty when suitable material is unavailable.

Cover the following with representative fixtures and validation:

1. Generate R and P choice, cued, and free tasks with the required prompts and support for each level.
2. Generate R FLUENCY material with exactly 100 English words, at least five natural occurrences of the target word, two answerable comprehension questions, and fixed answers/evidence.
3. Generate P FLUENCY Chinese scenarios that elicit the target expression without revealing its English form, plus grading requirements for target use and overall expression.
4. Reject malformed, ambiguous, level-inappropriate, or target-sense-mismatched output; retry within a finite budget, then report material unavailable.
5. Cache validated material with its version and preserve the prompt inputs and raw AI output for inspection.

Log the model/provider, prompt inputs, generated output, validation results, retries, and failure reason so the user can assess generation quality. Test through the task-generation boundary with deterministic AI fixtures; do not treat generated material as valid until it passes checks.

Human verification: run one example for each task type and open its generation record. Check the prompt includes the intended level, word sense and axis; count the R passage words and target occurrences; confirm P material does not expose the English target; inspect validation status and the material actually presented. Feed one invalid fixture and confirm its rejection/retry reason is visible and it is never presented as a valid task.

## P7 AI grading for FLUENCY tasks

Use AI to grade submitted FLUENCY answers against requirements frozen when the task was issued. For P, return separate outcomes for correct target-word use and successful overall retelling, with evidence for each. For R, return separate outcomes for the target-word meaning question and passage-comprehension question. Preserve the answer and grading requirements used for every decision.

Apply the P1 score rules only after validity checks: invalid timing, interruption, bad material, or an AI/service error must not change scores or schedules. A grading result must not be recalculated from an edited answer; retry a service failure against the saved original answer. Test pass/fail combinations, target-word omission or misuse, semantically valid paraphrases, ambiguous answers, and service failures.

Log the model/provider, full grading inputs, submitted answer, structured output, evidence, validity checks, and score/schedule changes. Keep AI generation logs distinct from grading logs so the user can inspect both.

Human verification: submit prepared passing and failing answers for R and P, then compare the saved answer, frozen rubric, AI outcomes/evidence, and score decision with the P1 tables. Submit an invalid-timing answer and simulate a grader error; confirm both records show no score or schedule change. Retry the grader error and verify it uses the original saved answer.



## P8 prototype UI

Build a basic HTML prototype that connects the verified vocabulary, material, task, grading, score, schedule, and capacity functions. Keep the flow small and usable; show the user what task is being done and why it was selected.

The prototype should support:

1. Estimate and save the user's vocabulary size, with a clear indication when frequency-rank data is unavailable or not comparable.
2. Select or introduce material, resolve/confirm target-word meaning, and initialize each word's R/P scores from the user's vocabulary estimate and word rank.
3. Practice ENCODE, all R/P RETRIEVE levels, and both FLUENCY task types with the appropriate prompt, answer input, timing, feedback, and score update.
4. Show current R/P scores, targets, next due dates, review levels, graduation state, today's queue/capacity, and why a task was selected or is unavailable.
5. Provide a task/event history that exposes AI generation and grading inputs/outputs and explains score and schedule changes.

Use the real verified core functions rather than duplicate UI-only rules. Keep the UI states for loading, empty queue, cooldown, capacity shortfall, unavailable material, invalid attempt, and grading failure explicit. Demonstrate the complete happy path and representative failure/recovery paths in the prototype.

How to verify: provide a short manual walkthrough using seeded data: set vocabulary estimate, introduce a word, complete one RETRIEVE and one FLUENCY task, then inspect score and due-date changes. Repeat with a failed answer and unavailable material. At each step, compare the visible task reason and history detail with the corresponding event records; confirm the capacity panel and queue agree with the scheduler. Capture screenshots of the initial setup, active task, result/history, and one blocked/error state so a reviewer can verify the prototype without reading implementation code.
 



