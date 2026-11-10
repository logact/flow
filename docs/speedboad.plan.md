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

Implement user vocabulary measurement and initial-score estimation using the BNC/COCA Level 6 word-family bands. The target-word API accepts the original surface word as supplied by material/import, performs reference-list lookup internally, and returns an estimated probability that the learner knows its family plus initial R/P scores. Keep estimates separate from answer evidence: a probability is only an initialization prior, never a pass or mastery record.

### Proposed input/output contract

Use one new estimator and the existing task selector. Estimation is pure and returns initial R/P scores; the caller stores those scores in a new word's state and passes each score to `selectTask()`. A zero score selects ENCODE, so P3 does not add an `introduceWord()` API or a separate `encodePending` input. The existing `score()` remains responsible for its own score event when ENCODE is completed.

```ts
type EstimateBand = 'common' | 'known' | 'less_common' | 'unknown';
type WordFamilyFrequencyBand = '1k' | '2k' | /* ... */ '25k';

interface VocabularyEstimate {
  size: number;                 // estimated known word families
  source: 'BNC_COCA_L6_v2';
  uncertainty: { lower: number; upper: number; method: string };
  strata: Array<{ band: WordFamilyFrequencyBand; familyCount: number; questions: number; correct: number }>;
}
interface TargetWordInput {
  word: string;                 // original surface form; no caller-side lemma/family required
  context?: string;
  partOfSpeech?: string;
}
interface InitialScoreEstimateInput {
  vocabulary: VocabularyEstimate;
  target: TargetWordInput;
}
interface InitialScoreEstimate {
  originalWord: string;
  family: { headword: string; band: WordFamilyFrequencyBand } | null;
  lookup: 'matched' | 'not_in_list' | 'ambiguous';
  probabilityKnown: number | null;
  R: number;
  P: number;
  scoreBand: EstimateBand;
  comparable: boolean;
  reason?: 'not_in_list' | 'ambiguous_family' | 'invalid_vocabulary_estimate' | 'source_version_mismatch';
}
function estimateInitialScores(input: InitialScoreEstimateInput): InitialScoreEstimate;
```

The API receives the original word string. A pinned BNC/COCA v2 adapter resolves surface forms through its listed family members; it must not invent a family through stemming. If a form maps to multiple families, use supplied context/POS only when the resolver can disambiguate; otherwise return `ambiguous`. Missing words return `not_in_list`; neither case receives a fabricated probability or rank.

Estimate `P(known | test result, family band)` from the learner's measured vocabulary-size distribution, not only its point estimate. For each possible known-family count `v`, assume known families occupy the cumulative frequency prefix of the reference list. Within the target band spanning cumulative family positions `[L,U]`, use `g(v,L,U)=clamp((v-L+1)/(U-L+1),0,1)`. Then compute `pKnown = Σ_v g(v,L,U)·P(V=v | test result)`. If only a point estimate is available, use the same formula at `v=V` and label it a coarse prior. Document this prefix assumption and expose uncertainty; do not describe the probability as an observed fact about the learner.

Map probability to score bands via named configurable thresholds (initial defaults: `pKnown ≥ 0.8` common `(60,40)`; `0.5 ≤ pKnown < 0.8` known `(40,20)`; `0.2 ≤ pKnown < 0.5` less_common `(20,5)`; below `0.2` unknown `(0,0)`). Return the numeric probability as well as this score band. Keep thresholds isolated for calibration. The estimate function is pure and returns no evidence flags, schedule, persistence handle, or timestamp. Apply only to eligible new words; changing V does not reset in-practice scores or schedules. `selectTask(0)` returns ENCODE; other task selection remains unchanged.

The estimate event should include V and its source, rank and its source, comparability/reason, selected band, and initial R/P scores. Persist it at the caller that applies an estimate; do not make `estimateInitialScores` write to disk. ENCODE completion continues to use the score event emitted by `score()`.

### Implementation plan

1. Define typed P3 measurement results with BNC/COCA version, per-band sampling counts, point estimate, and an uncertainty distribution or documented coarse interval.
2. Implement original-surface-word lookup through the pinned family-member index, returning matched/not-found/ambiguous with provenance; do not require callers to pre-lemmatize.
3. Implement the pure band-based known-probability formula and configurable probability-to-score thresholds above. Never use corpus token frequency as rank or probability evidence.
3. Update the task-selection contract so `selectTask(0)` returns ENCODE and nonzero scores retain the existing RETRIEVE/FLUENCY thresholds. ENCODE completion uses the unified `score({ task: 'ENCODE', state: { R, P }, completed: true })` path and initializes both axes to at least 5.
4. Keep estimate application at the word-creation caller: apply the estimated scores only to a new eligible word, leave learning evidence and schedule defaults untouched, and never recalculate an in-practice word when `V` changes. Do not implement P4 capacity admission here.
5. Persist `vocabulary.estimated` with the original input word, resolved family/band or lookup failure, P3 estimate/version, probabilityKnown, thresholded score band, initial R/P scores, and selected first task. Estimates must not create FLUENCY evidence; ENCODE completion remains recorded through `score()`.

### Tests and acceptance

Create `test/vocabulary.jest.test.ts` and a dedicated `npm run test:p3` command. Cover exact boundaries at `0.5V`, `V`, and `1.5V`, values immediately on either side, missing/invalid V or rank, and same-source versus incomparable rank sources. Assert the estimator is deterministic and does not mutate input.

Test that estimated scores select the intended first task: nonzero bands use the existing score thresholds and `(0,0)` selects ENCODE. Verify ENCODE completion changes both axes to at least 5 through `score()`. Verify applying a new V affects future words only and leaves an in-practice word's scores and due dates intact. Capture estimate and score events at their respective caller boundaries and confirm estimates create no FLUENCY-pass evidence. Keep capacity checks and the 3/5/7/9 daily task admission enforcement for P4.

Human verification: use fixtures at each band and inspect the persistent event log for V/source, rank/source, chosen band, initial R/P scores, and selected first task. Complete ENCODE once for a `(0,0)` word and confirm its score event updates both axes to 5. Re-estimate V after a word enters practice and confirm its score and schedule are unchanged; verify no estimate event is reported as a FLUENCY pass.


## P3.1 user vocabulary capaicity estimate

Implement `estimateVocabularyCapacity(test)` as a pure function. The input contains the pinned BNC/COCA family-list version and one or more frequency-band strata; each stratum records the band family population, sampled unique families, correct answers, and total answers. Return the estimated known-family count, per-band evidence, and an uncertainty representation consumable directly by P3's probability estimator.

Add two separate pure functions before estimation:

1. `createVocabularyCapacityTest(...)` draws a deterministic, seeded sample of unique family IDs from requested bands in the pinned list, then returns a frozen test form containing list source/version, test ID, per-band populations, item IDs, learner-facing prompts, and answer keys kept separate from the learner-facing view. Sampling must be uniform within each band and must never use `memberFrequencies` or `totalFrequency` to bias selection. The public test view must not reveal answer keys.
2. `checkVocabularyCapacityTest(...)` validates a submitted test/result against the issued form and pinned list before estimation. Check test/list identity and version, exact item membership, duplicate or missing/extra answers, valid answer values, and that every sampled family belongs to its declared band. Return a typed valid/invalid result with item-level errors; never estimate from an invalid submission. The checker must not mutate the issued form or submission.

The answer key and learner-facing test payload must have distinct types so callers cannot accidentally expose keys. Test creation is deterministic for a supplied seed, enabling reproducible fixtures while allowing a fresh seed for each real administration. Define how prompts are produced from family members (for example, select a listed member with a controlled, deterministic policy); do not assume frequency counts are ranks or treat generated definitions as validated unless a separate prompt authoring source is specified.

Reject empty tests, duplicate family items, families outside the pinned list/version, invalid answer counts, or missing source identity. Keep the estimator pure; `recordVocabularyCapacityEstimate()` writes a `vocabulary.capacity_estimated` event with strata, list identity, estimate, and uncertainty. Sampling must be representative within each band; document that band-specific results describe expected known-family proportions rather than a precise personal word inventory.

Test multiple strata, all-correct/all-incorrect results, malformed input, deterministic seeded sampling, uniform eligibility, answer-key separation, all checker rejection cases, no mutation, and compatibility with P3's input contract. Verify invalid submissions cannot reach or emit capacity estimates.

## P3.2 BNC/COCA word-family list integration

Integrate the BNC/COCA Level 6 word-family list (pin the selected release, initially v2.0.0) as the shared reference for P3 vocabulary measurement and target-word lookup. The public estimation interface accepts the original surface word. Do not treat corpus frequency counts (`Related forms` counts or `Total frequency`) as ranks. The list's `1k`–`25k` values are frequency bands; keep band identity distinct from raw BNC token counts and exact ordinal ranks.

### Reference data and lookup

1. Add a reproducible import script and a normalized, versioned local data artifact sourced from the downloadable list. Preserve attribution and the source license with the artifact; verify redistribution terms before committing the full source data. Record source URL, release/version, retrieval date, and checksum in metadata.
2. Normalize each family as `{ headword, band, members, memberFrequencies? }`. Index headwords and related forms to their family. Preserve homographs/part-of-speech alternatives as multiple candidates; do not silently select a family when context is required. Normalize casing and whitespace only; retain source spelling and frequency values.
3. Provide a pure lookup API that accepts a lemma (plus optional POS/context when available) and returns `matched`, `not_in_list`, or `ambiguous`, with family headword, band, source/version, and matched form when resolved. No heuristic stemming or guessed derivational-family expansion. A surface-form lemmatizer may be an upstream step but must not be represented as the family mapping itself.
4. Keep out-of-list words explicit (`not_in_list`) and make probability unavailable. Do not treat them as the least frequent band or invent a rank. Record lookup status and provenance with the estimate event.

### Connect the vocabulary measurement interface

Adapt P3.1 test strata to the BNC/COCA band-based population: sample unique families within each band and store family ID, band, prompt/answer key, and result. Estimate total vocabulary as the sum of `band family count × correct / questions`; retain per-band counts, sample sizes, correct counts, uncertainty, and limitations. Test items must belong to the pinned list. P3 probability uses band cumulative family boundaries plus the V estimate distribution; it must not invent precise within-band ranks. Keep the list adapter separate from estimator policy so the data source can be replaced without rewriting raw data.

### Acceptance

- Import is deterministic and reports malformed/duplicate entries; original surface-word lookup returns expected families for listed forms and not-found/ambiguous states correctly.
- Tests cover source version identity, unknown words, homographs, case normalization, duplicate membership, malformed data, and no mutation.
- P3 measurement accepts only test items from the same pinned list, computes a family-count estimate and uncertainty from band strata, and returns provenance consumable by the probability estimator.
- For known V distributions, probability is 1 below the band, 0 above it, and smoothly interpolated within it under the prefix assumption; tests verify boundary and monotonic behavior.
- The original input word is preserved in results/events. A word absent or unresolved in the list receives no fabricated family, band, probability, or initial score band.
- Include a small checked-in fixture for tests; keep full source data separate until license and repository-size decisions are confirmed.

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

### 目标

实现一个确定性的派题入口：给定当前日期、用户词汇及 R/P 轴状态、共享冷却、材料可用性、今日已完成任务和 P4 容量计划，返回下一项任务，或返回“现在为什么没有任务”。相同输入必须得到相同结果；派题本身不修改词汇分数、排期或容量状态。

### 输入与输出

1. 输入提供固定的 `asOf` 日期、每个词的 ID 和 R/P 轴状态、共享冷却结束时间、候选任务所需材料的可用状态、今日任务/时间使用情况，以及 P4 返回的今日和未来 41 天容量结果与可准入新词列表。
2. 输出包含队列状态、选中的任务（若有）、选择原因、被考虑的候选及每个候选未被选中的原因。无任务时给出明确状态，例如今天已完成、都在冷却中、材料不可用或容量不足，并附相关日期/容量信息。
3. 选择逻辑保持纯函数；由调用边界将每次队列决策持久化到现有日志。日志至少记录 `asOf`、队列状态、候选及其到期/冷却/材料/容量判断、最终任务、选择原因。日志不得只写“派出了某任务”，还要能看出为什么它排在其他候选前面。

### 派题顺序

只在当前可派发的候选中比较。冷却未结束或所需材料不可用的候选先标记原因并跳过，不阻塞其他可派任务，也不擅自把该候选改成较低难度的任务。

1. 先选已完成该轴学习、尚未毕业且 `dueAt` 为今天或更早的复习任务；逾期最久（`dueAt` 最早）的优先。
2. 没有可派复习时，再选尚未完成该轴学习且 `dueAt` 为今天或更早的学习任务；同样由最早 `dueAt` 优先。一个词的 R/P 轴可以分别成为候选。
3. 没有可派的到期旧任务时，才考虑 P4 判定可准入的新词。必须同时通过今日及未来 41 天容量检查。
4. 同一类别且 `dueAt` 相同时，按词 ID 升序；同一词 R 轴排在 P 轴前。新词只在相同 rank source 内比较 rank 数值，不把不同来源的 rank 当作可比数值；无法比较的候选按固定来源标识分组，再以目标缺口较大者优先、词 ID 升序稳定排序。新词的 R/P 同分时 R 先。
5. 已毕业轴或 `dueAt = 'infinity'` 的轴不进入队列。共享冷却未结束时所有任务都不可派；冷却结束后这些候选在下一次调用时重新参与比较。单个候选材料不可用时只跳过该候选，不影响其他候选。
6. 到期但尚未完成的轴保留原 `dueAt`；跨日后自然作为逾期任务参与比较。不能为了引入新词而顺延它。只有用户显式更改目标、范围或其他已排期前提时，才按新状态重算排期并记录原因。

### 实施步骤

1. 定义队列输入、候选、选中任务和无任务状态的 TypeScript 类型，明确日期和排序规则。
2. 实现纯函数 `selectNextTask`：生成 R/P 候选、标记不符合条件的原因、按优先级挑选一项，或汇总无任务原因；不修改输入。
3. 接入 P4 容量结果和现有共享冷却/材料状态；容量不通过时记录 P4 给出的首个阻塞日期和原因，不自行复制容量计算。
4. 在派题调用边界持久化队列决策日志，包括被考虑的候选、淘汰原因和选中原因。
5. 增加独立的 `npm run test:p5` 命令，P5 测试使用 TypeScript 并与通用测试命令分开运行。

### 测试用例（大白话）

每个测试都用固定日期和固定输入，不依赖真实时间；用断言检查“选了谁、为什么、其他候选为什么没选”。

1. **复习要排在学习前面**：准备一个到期复习和一个到期学习，二者都没有冷却、材料也齐全。调用派题后应先拿到复习；日志说明复习类别优先。
2. **复习内部看谁逾期更久**：准备两个到期复习，一个到期更早。应选更早到期的那个；交换它们的词 ID 也不应改变这个结果。
3. **学习内部看谁逾期更久**：没有可派复习，准备两个到期学习。应选 `dueAt` 更早的；如果到期日相同，词 ID 较小者先。
4. **同一个词的 R/P 平手时 R 先**：准备一个词的 R、P 两轴都在同一天到期且都可派。应选 R；结果不应取决于输入数组的排列顺序。
5. **同一个词可以提供不同类别的候选**：让这个词的 R 轴是到期复习、P 轴是到期学习。应选 R 复习，并在候选明细中保留 P 学习候选。
6. **毕业轴和无限期轴不派题**：准备一个已毕业轴和一个 `dueAt = 'infinity'` 的轴，再放一个正常到期轴。应跳过前两个并选正常到期轴；如果没有正常候选，则不应误派它们。
7. **共享冷却会挡住所有任务**：准备一个到期复习和一个到期学习，再把共享冷却设为明天结束。今天不应派任何任务，两个候选都说明受到冷却限制；把冷却清除后再次调用，应按复习优先规则派题。另测单个候选材料缺失时，其他候选仍可派。
8. **材料缺失时不能偷偷降难度**：准备一个到期任务，但它所需材料不可用；再准备一个材料齐全的其他候选。应跳过缺材料的候选并派其他候选。如果没有其他候选，则返回“材料不可用”，而不是生成更简单的替代任务。
9. **有旧任务时不插新词**：准备一个可派的到期旧任务和一个 P4 容量允许的新词。应先派旧任务；新词不能抢在到期任务前面。
10. **旧任务都没有时才引入新词**：不放任何可派旧任务，P4 今日和未来容量都允许新词。应选排序最高的新词，并能从日志看出排序依据。
11. **词频来源相同才比较 rank 数值**：准备两个相同来源的 rank，较常见词（数值较小）应排前；再准备来源不同但数值很接近的 rank，不能直接拿两个数值比较，结果应按固定来源分组和后续稳定规则决定。
12. **新词平手时按目标缺口和 ID 稳定排序**：准备 rank 相同的多个候选，让一个目标缺口较大；应先选缺口较大的。缺口也相同时，应选词 ID 较小者；输入顺序打乱后结果仍相同。
13. **未来容量会卡住新词**：今日还有空位，但 P4 指出未来 41 天某一天会超量。该新词不能准入；无其他任务时返回容量不足，并带上 P4 给出的最早阻塞日期。
14. **区分没有任务的原因**：分别准备“还有训练容量无新词可派”，“已达训练容量上限”两组输入。每组都应返回对应状态，不能都笼统地说“队列为空”。
15. **跨日后显示逾期，但不改 dueAt**：准备一个昨天到期、尚未完成的轴，分别用今天和明天作为 `asOf` 调用。它两次都应作为逾期候选参与派题，原词状态里的 `dueAt` 保持不变。
16. **派题不修改词状态**：保存输入副本，调用派题后逐项比较。分数、`dueAt`、毕业状态和容量输入都应原样保留。
17. **日志能解释整个决定**：通过实际派题调用边界运行一次“复习胜过学习”的场景，然后读取持久化日志。应能看到队列状态、两类候选、学习候选为何落后、最终选中的复习及选择原因；只记录最终任务名称不算通过。

### 验收方式

自动测试覆盖以上场景，并额外验证排序不受输入数组顺序影响、同一输入重复调用结果一致、P4 的容量结论和阻塞日期原样传递、每次队列调用都产生可检查的持久化日志。人工核验时，用固定日期和少量可控词逐一构造上述场景，对照候选明细和日志确认“为什么选它、为什么没选另一个”。


## P6 AI task generation

Generate task material that matches the selected word and sense, learner level, axis, score, and task type. Follow the P1/P5 task ladder: ENCODE is shared by R/P and is selected only when both initial scores are zero; RETRIEVE uses choice, cued, or free below 60; FLUENCY is axis-specific from 60 onward. Never silently replace unavailable material with an easier task.

### Two implementation stages

1. **Run without an API key.** Implement a deterministic fixture generator behind the same interface as the real provider. Fixtures must exercise successful generation, malformed output, target-sense mismatch, validation rejection, retry, and retry exhaustion. Run prompt construction, parsing, validation, retry, result selection, and logging through the real task-generation service boundary.
2. **Allow API-key developer debugging.** Implement real adapters for OpenAI-compatible providers (including OpenAI, DeepSeek, and Kimi), selected/configured on the server. Read `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` only from server environment configuration; never include the API key in input types or logs. The base URL may point to any compatible provider, and model names remain configurable. Record each attempt as structured application log data so a developer can inspect provider/model, prompt inputs, raw output, validation, retry count, and failure reason. Debug records are logs only; do not add a debug-record database or query API. Only validated material may be returned for presentation.

### Generation boundary

The task-generation input carries the word and chosen sense directly; the generator does not look them up by ID. The ID remains for correlation and logs. Fixture and real-provider adapters implement the same raw-output boundary. Parsing and validation happen after the adapter returns, so provider output is always treated as untrusted.

```ts
type Axis = 'R' | 'P';
type RetrieveStage = 'choice' | 'cued' | 'free';
type TaskType = 'ENCODE' | 'RETRIEVE' | 'FLUENCY';

interface TaskGenerationInput {
  word: {
    id: string;
    text: string;
    sense: {
      id: string;
      definition: string;
      partOfSpeech?: string;
      examples?: string[];
    };
  };
  axis: Axis | 'both'; // both is used only by shared ENCODE
  task: TaskType;
  stage?: RetrieveStage; // required only for RETRIEVE
  learner: {
    level: string;
    score: number | { R: number; P: number };
    language: string;
  };
  promptVersion: string;
}

interface RawGenerationResult {
  provider: string; // e.g. fixture or configured provider
  model: string;
  rawOutput: string; // unparsed, untrusted provider/fixture output
  requestId?: string;
}

interface TaskMaterialGenerator {
  generate(input: TaskGenerationInput): Promise<RawGenerationResult>;
}

type TaskGenerationOutcome =
  | { status: 'ready'; material: GeneratedTask; generationId: string }
  | { status: 'unavailable'; reason: string; generationId: string };

interface TaskGenerationService {
  generateTask(input: TaskGenerationInput): Promise<TaskGenerationOutcome>;
}
```

The service parses and validates each attempt, retries invalid output only within a finite configured budget, logs every attempt, and returns `ready` only for validated material. On exhaustion it returns `unavailable` with a reason. The task assignment function remains pure; the application boundary calls generation after P5 selects a task and handles unavailable material without lowering its difficulty. Cache only validated material and associate it with the prompt/schema version; debug inspection itself is provided by logs, not a separate persistence API.

### Per-task material schemas

All task material uses a versioned envelope. `wordId` correlates the generated task with the input; answer keys and grading requirements are server-side and must be removed from learner-facing payloads.

```ts
interface TaskEnvelope<TTask extends string, TContent> {
  schemaVersion: '1';
  task: TTask;
  wordId: string;
  content: TContent;
}

type EncodeTask = TaskEnvelope<'ENCODE', {
  word: string;
  pronunciation?: string;
  partOfSpeech?: string;
  definition: string;
  examples: Array<{ sentence: string; translation?: string }>;
  instruction: string;
}>;

type RetrieveChoiceTask = TaskEnvelope<'RETRIEVE', {
  axis: Axis;
  stage: 'choice';
  prompt: string;
  options: Array<{ id: string; text: string }>;
  answerOptionId: string;
  explanation: string;
}>;

type RetrieveCuedTask = TaskEnvelope<'RETRIEVE', {
  axis: Axis;
  stage: 'cued';
  prompt: string;
  cue: string;
  answerKey: { acceptedAnswers: string[]; explanation: string };
}>;

type RetrieveFreeTask = TaskEnvelope<'RETRIEVE', {
  axis: Axis;
  stage: 'free';
  prompt: string;
  answerKey: { acceptedAnswers: string[]; explanation: string };
}>;

type ReadingFluencyTask = TaskEnvelope<'FLUENCY', {
  axis: 'R';
  passage: string; // 90-120 English words, inclusive
  questions: Array<{ prompt: string; answer: string; evidence: string }>;
  targetOccurrences: number;
}>;

type ProductionFluencyTask = TaskEnvelope<'FLUENCY', {
  axis: 'P';
  scenario: string;
  responseInstruction: string;
  gradingRequirements: {
    targetExpression: string;
    targetUseCriteria: string[];
    overallExpressionCriteria: string[];
  };
}>;

type GeneratedTask =
  | EncodeTask
  | RetrieveChoiceTask
  | RetrieveCuedTask
  | RetrieveFreeTask
  | ReadingFluencyTask
  | ProductionFluencyTask;
```

### Validation rules

1. Validate the discriminant and required fields for the selected task/axis/stage; reject extra or missing task-specific structure and malformed/ambiguous content. Prompt every variant to keep learner-facing English vocabulary and grammar at or below the supplied learner level, with only the target word as an intended exception.
2. ENCODE is shared (`axis: 'both'` at input); its material must match the supplied word and sense and include at least one example.
3. RETRIEVE choice has at least two options, exactly one keyed answer, and a valid `answerOptionId`. R prompts test recognition of the intended English word/sense; P prompts elicit English production from a suitable non-English cue. Cued/free prompts must not disclose the answer in their cue or prompt.
4. R FLUENCY has an English passage of 90-120 words inclusive, at least five natural occurrences of the target word, and exactly two answerable comprehension questions with fixed answers and evidence found in the passage. `targetOccurrences` must match the validated count.
5. P FLUENCY has a Chinese scenario and response instruction that elicit the target expression without exposing its English form. Grading requirements separately cover correct target use and overall expression.
6. Reject target-sense mismatch, level-inappropriate material, invalid language, or any failed structural/content rule. Retry within the finite budget; after exhaustion report material unavailable and never present rejected output as a valid task.

### Deferred: detecting out-of-level vocabulary

Automatic detection of vocabulary above the learner's level is paused. The project has not chosen a CEFR vocabulary list, grading source, or detection method, and the current prompt instruction is not a guarantee. Resume this work after choosing a vocabulary reference and deciding how fixed input definitions should be handled when they contain words above the learner's level. Until then, level fit requires human review.

### Logging, cache, and verification

Write one structured generation-attempt log containing `generationId`, attempt number, provider/model, prompt version and input, system/user prompts as readable fields, the exact outbound request URL/body, raw HTTP response, extracted model output, parsed output when available, validation status/errors, and retry/failure reason. Redact the Authorization header and never log API keys. Logs are the developer inspection surface; do not create a separate generation-record database/API. Cache only successfully validated material and include schema/prompt version in its cache identity so stale material cannot bypass updated validation. Provide an explicit live-debug command that makes one real request for each task variant at A1, B1, and C1 levels by default (or each level for one selected variant), prints only validated learner-facing material, and points to `logs/app.log` for provider output and validation details.

Add deterministic fixture tests through the task-generation service boundary, with a dedicated `npm run test:p6` command and TypeScript test files. Cover every schema/task variant, validation and retry paths, unavailable output, no input mutation, no presentation of invalid output, and the same service behavior with fixture and provider adapters. Human verification: generate one example of each task variant, inspect its attempt logs and presented material, verify R passage word/target counts, verify P material does not reveal the English target, and feed invalid output to confirm the rejection and retry reason are logged.

## P7 AI grading for FLUENCY tasks

### Goal and boundaries

Grade submitted FLUENCY responses against the task material and rubric frozen when that task was issued. P7 covers R/P FLUENCY only; ENCODE and RETRIEVE grading remain outside this phase. Keep the same two-stage developer workflow as P6: the complete service path works deterministically with fixtures and no API key, and a configured real provider can be exercised for developer debugging using `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL`.

The grader must not fetch or regenerate task material. Its input contains the exact issued task, its hidden answer/rubric fields, the learner's original submitted answer, and the task-attempt validity metadata. Persist/freeze these at submission so editing a later copy cannot change a grading decision. A retry after provider/service failure reuses the stored original submission and exact same issued material/rubric.

### Input and output contract

Use discriminated TypeScript types so reading and production answers cannot be confused. The input should carry a stable `attemptId`, the exact validated `GeneratedTask` for the issued FLUENCY task (including answer keys or grading requirements), the learner's submitted answer, learner level/language, and validity facts such as timing validity, interruption, and material validity. R submissions contain answers to the two issued questions; P submissions contain the learner's spoken/written response and any captured timing/speed evidence. Do not accept a caller-provided pass/fail judgment.

Return a structured decision with `status: 'graded' | 'invalid' | 'unavailable'`. A graded P result has separate `targetPassed` and `overallPassed` outcomes plus evidence for each. A graded R result has separate target-word-meaning and passage-comprehension outcomes plus evidence tied to each question. Invalid attempts and unavailable grader results carry stable reason codes and no pass/fail score decision. Validate the provider response schema before accepting it; reject ambiguous/missing outcomes and evidence rather than guessing.

R material must identify the role of each question as `target_meaning` or `passage_comprehension`, exactly one of each, before P7 can grade the two outcomes correctly. Update the P6 material type, prompt, validation, fixtures, and live cases as part of P7's prerequisite work, preserving compatibility for existing generated records by treating records without these roles as invalid for AI grading (never infer a role from question wording).

### Score and schedule integration

1. Check task/answer association, frozen material validity, interruption, and timing before using any AI outcome. Invalid timing, interrupted attempts, invalid material, malformed grader output, and provider/service errors must leave score and schedule unchanged.
2. Map only a valid structured grade into the existing pure `score()` interface: P FLUENCY maps target-use and overall-expression outcomes to `targetPassed` and `overallPassed`; R FLUENCY maps the target-meaning and passage-comprehension outcomes the same way. Pass the already captured speed and timing-validity facts through unchanged.
3. Call the existing schedule settlement function only after a valid score result. Keep grading, score, and schedule events separately identifiable and correlate them with the same `attemptId`; do not duplicate or modify P1 score formulas in the AI grader.
4. Make the orchestration boundary explicit: pure validation/mapping functions return decisions, while the attempt-submission boundary persists the original answer and writes grading/score/schedule events. Retrying a grader service error must not write a second answer or settle score/schedule until a valid grade is obtained.

### Provider, fixtures, and logs

Define a grader adapter boundary analogous to P6's raw-output generator. Fixture adapters should provide deterministic pass, fail, ambiguous, malformed, and provider-error outputs; the common grading service owns parsing, schema validation, retries, and result selection. The configured provider adapter uses the existing three `LLM_*` environment variables and must redact credentials. Only schema-valid grades may flow into scoring.

Write a distinct `task_grading.attempt` structured log for every attempt, separate from `task_generation.attempt`. Include attempt/generation correlation IDs, provider/model, prompt version and prompts, frozen task/rubric, original answer, validity checks, raw request/response, parsed structured grade, evidence, validation errors, retry/failure reason, and whether score/schedule settlement occurred. Never log API keys. Add a P7 log inspection command that shows the full grading record for an optional `attemptId`, following the P6 prompt-viewer pattern. Persist the original answer and frozen task/rubric in the existing application persistence layer; logs are audit/debug records, not the answer store.

### Implementation steps

1. Add explicit R question roles in P6's R FLUENCY schema and update its prompt, validator, fixtures, and live cases; require exactly one target-meaning question and one passage-comprehension question.
2. Define P7 submission, attempt-validity, provider-result, grade-decision, and grading-event types. Verify that the exact task material and original answer survive persistence/reload without being reconstructed from mutable word or task data.
3. Implement deterministic answer/material/timing validity checks and pure provider-output parsing/schema validation. Keep model-produced pass/fail and evidence separate by grading criterion.
4. Implement fixture and OpenAI-compatible provider adapters; route both through one retrying grading service. Retry service/schema failures against the same frozen input, and return unavailable after the finite retry budget.
5. Add the submission orchestration boundary: persist answer and frozen task once; on a valid grade, call `score()` and then the existing schedule settlement; on invalid/unavailable grade, leave both unchanged. Correlate all events using `attemptId`.
6. Persist distinct grading-attempt logs and add `npm run logs:p7` (optionally accepting an attempt ID). Add dedicated `npm run test:p7` and `npm run test:p7:live` commands; keep TypeScript tests separate from the default suite where appropriate.

### Tests (大白话：测什么、怎么测)

All automated cases use a fixed issued task, fixed answer, and controlled fixture output; they do not depend on wall-clock time or a live API. Assert the returned decision, the call to `score()`/schedule settlement, and the persisted log record together.

1. **P 轴两个标准分别判**：用一个目标词用对、整体表达也达标的回答，确认两项都通过；再分别构造目标词没用/用错但整体表达不错，以及目标词用对但整体没说清楚，确认两项结果能独立不同，并按 P1 规则更新分数。
2. **R 轴两道题分别判**：提交目标词义题正确、文章理解题错误的答案，再反过来测试；确认日志和结果分别指出是哪一题通过，不把两个结果合并成一个笼统分数。
3. **接受意思正确的改写**：答案不用 rubric 中的原句，但意思和目标用法正确；fixture 返回有效语义判定及证据，确认服务接受它而不是只做字符串完全匹配。
4. **目标词遗漏或误用**：P 回答漏掉目标表达或把词义用错；确认 `targetPassed=false`，整体表达结果仍单独保留，并按既有 P1 规则结算。
5. **含糊回答不猜**：准备无法确认意思或证据不足的回答，让 fixture 返回缺失/含糊结果；确认被拒绝或标为不可判定，不调用 `score()`，分数和排期不动。
6. **计时无效或中断不扣分**：使用正确答案但标记计时无效或任务中断；确认不接受 AI 的通过结果，不调用 `score()`/排期函数，日志写明无效原因。
7. **材料有问题不能结算**：把任务标记为未通过 P6 校验或 R 问题角色缺失/重复；确认不会请求 AI 评分或不会接受其结果，分数和排期保持原样。
8. **坏 JSON、错误 schema 和证据不合格会重试**：fixture 先给无法解析的 JSON 或缺字段结果，再给正确结构；确认每次尝试各有日志，最后只使用有效结果结算一次。
9. **重试耗尽不改状态**：连续给坏结果或模拟服务错误；确认最终返回 unavailable，原答案仍可重试，分数和 dueAt 不变。
10. **重试使用原始提交**：先保存一次答案，再模拟 provider 错误；修改外部展示副本后重试，确认 grader 收到的仍是原始答案和当时冻结的任务/rubric。
11. **P1 速度规则照常生效**：分别测试有效计时且速度低于门槛、达到门槛、目标词失败、整体失败；确认分数和分支符合现有 `score()` 测试，不复制公式实现。
12. **有效评分只结算一次**：从持久化答案跑完 grade→score→schedule，确认评分通过后才更新分数和 dueAt，事件按 `attemptId` 关联，重复读取/展示结果不会二次结算。
13. **日志可复盘且不泄密**：读取持久化 `task_grading.attempt` 记录，确认能看到模型/provider、冻结任务和 rubric、原始答案、输入有效性、原始响应、结构化结果、证据、重试原因及是否结算；确认日志中没有 API key，且不混入 P6 generation 事件。
14. **无密钥路径跑完整流程**：使用 fixture 完成 P/R 的通过、失败、无效和重试场景；不设置 LLM 环境变量也能运行 `npm run test:p7`。

Live developer command defaults to both R and P FLUENCY with representative pass/fail/ambiguous submissions. It prints only validated grade decisions and points to `logs/app.log` for raw provider details. Live calls are diagnostic evidence, not a deterministic CI test.

### 人工核验

准备 R/P 的通过、失败和含糊回答。检查保存的原答案、冻结的题目/rubric、AI 返回的分项结论与证据，再逐项对照 P1 评分表。对无效计时和 grader 错误各跑一次，确认分数及 `dueAt` 均未变化；随后重试服务错误，确认仍用原答案且只结算一次。最后运行 `npm run logs:p7 -- <attemptId>`，核对完整评分轨迹，并确认日志里没有密钥。

### 当前进度记录

P7 流程验证已完成：自动化测试和真实 provider 调试均确认 R/P 提交能走到评分服务，必要的学习者水平、冻结题目与评分标准、原始答案都传入了 prompt，结构化结果也能进入现有评分和排期流程。真实 provider 的六个样例中，标准答案得到通过、错误答案得到不通过；含糊答案也被模型判为不通过并完成结算。这个结果只证明流程畅通，不代表判分准确；特别是含糊答案是否应拒绝评分、具体判分是否符合教学标准，需要后续用人工标注样本评估和调整。

## p7.1 the goal set and update logic

we have functions that create goals and update the goals ,
you should model the goals,and create function to manage or update them.

## P7.2 the material analyze function

give a PDF/text(md,txt..) materail and output the anlalyz the words analyze reslut inlcuding
each word's frequency and rank in the material and the word's frequency and rank in the test vocabulary base (same with estimating our level).




## P8-pre  all logic function integration test
We need to verify the behavior from the user estimate vocabulary -> set the goal and analyze the material -> introduce the words -> assign task to the user -> the user finish the task -> the word's next review time and fluency change->next task loop->...->util finish all vocabulary achieve the goal.

you should first ensure the all the moudle is comptiable and logic is right to get right behvaior

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
 



