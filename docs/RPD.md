# Overview
This app is a practice of Paul Nation's 4 strands learning theory.

## Basic user work flow

### scenairo1 (main)
1. User set a target, the target may be reading a book,pass a english exam...
2. The system will introduce the materails and decompose it into knowledge points we need study, the system will set the fluency degree for each points we need to achive as our goals and traced as the progress.
3. The user just need to slid the scree like tiktok to learn each task the system assign.

### Core algorithm for the task generation and assignment.

#### The target we aim to achieve 

1. Space memerioze to flush the short memory cache.
2. Balanaced design task for MFI(listening,reading),MFO(speak,write),LRL(pronounciation,grammer,word),FD(Develop the fluency)
3. The adpative task design for the specifc goal.
4. Use the score to measure the user's level.

#### Domain Model

**1. Knowledge Point (KP)** — the atomic unit of learning. Today a KP is always a lexical *chunk* (word/phrase); the model is shaped so grammar points and pronunciation items can be added later as new KP kinds.

| Field | Meaning |
|---|---|
| `chunk` | the target language item itself |
| `meaning` / `scene` / `slots` / `substitute` | learning payload: gloss, scene sentence, collocable slots, near-synonym substitute |
| `step3_sentence` / `step4_sentences` | per-KP task material generated at goal creation |
| `freq` | corpus frequency in the source material — importance weight in queue priority and score aggregation |
| `fluency` (F_P) / `fluency_r` (F_R) | 0–100 fluency **per direction** — F_P productive (writing), F_R receptive (reading): recognition never implies production, so each direction keeps its own score. The headline F = **min(F_R, F_P)** |
| `target_in` / `target_out` | **per-KP personal fluency targets** (reading / production direction), derived from the goal profile and materialized at intake (see *Target-anchored fluency*); the baseline for graduation and gap computation |
| `stability_tick` | shared half-life on the tick clock (H_tick) — the short-term cache is form-level, refreshed by practice in either direction |
| `stability_time` / `stability_time_r` | per-direction half-lives on the time clock (H_time_P / H_time_R) — recognition and production are separate memory traces and forget independently |
| `last_tick` / `last_ts` / `last_ts_r` | anchors for elapsed Δ — tick anchor shared across directions, timestamps per direction |

> No `state`, no `ready_at_*` gates, no `due_at`. The old pipeline state machine is replaced by one continuous score per KP.

**Derived bands (computed, display-only, never dispatch).** Bands are read off the headline F = min(F_R, F_P) on demand for progress bars and dashboards; **task types are no longer looked up from bands** — they are decided directly by the task library's eligibility predicates (see §5):

| Band | Condition | Meaning |
|---|---|---|
| NEW | never attempted | unseen |
| LEARNING | F < 50 | recognition-only |
| CONSOLIDATING | 50 ≤ F < 75 | effortful-but-reliable |
| INTEGRABLE | F ≥ 75, not yet integrated | batch-eligible |
| MASTERED | F ≥ 80, integrated | automatic in both directions |
| GRADUATED | both axes at personal target & H_time ≥ 30d both ways | done — survives long-term forgetting |

**2. Tick time (`global_tick`)** — a logical clock, **monotonically increasing forever** (never reset), counting completed tasks. Elapsed ticks since a KP's last attempt measure how thoroughly intervening distractors have flushed the short-term cache — the cache's **interference channel**.

**3. Interval time (`last_ts` / `last_ts_r`)** — physical wall-clock elapsed since the last attempt. It feeds two channels at once: the cache's **time channel** (H_cache ≈ 20 min — working-memory traces fade on their own) and the long-term forgetting channel (H_time, hours → days → weeks). Sleep performs both decays for free.

> The cache's two channels are **parallel**: intervening tasks can flush it, and so can plain elapsed time — come back three hours after practice and the hot cache is gone even if zero tasks intervened. The old model had only the interference channel and needed a "same-session vs cross-session" special case as a patch; with dual channels the special case disappears — overnight is just the ordinary case where Δt is large.
>
> **The system has no "session" concept.** The scheduler has exactly two clocks (tick, wall-clock) and never reads any practice-bout boundary: the tick is permanently monotonic, cache cooling runs on interference ∥ time, long-term forgetting runs on Δt. "Sitting down to practice for a while" is a behavioral pattern, not something the system needs to know; if analytics ever wants practice-bout statistics, bouts can be segmented post hoc from event timestamp gaps (gap beyond a threshold = new bout) — no dedicated event type is kept.

**4. Fluency score** — per-KP 0–100 estimate of automaticity (speed + accuracy of retrieval), held **per direction**: F_R (receptive/reading) and F_P (productive/writing), updated only by tasks of that direction. The headline score driving aggregation is min(F_R, F_P) — a KP is only as fluent as its weaker direction. Why split R/P and not the four skills: the product targets literacy (reading & writing) only, and R/P is the split that changes scheduling decisions; measured per-modality wpm stays a display metric, not a score.

**5. Score-driven queue** — one **(KP, direction, task-to-dispatch)** triple per candidate, its priority recomputed on every request; the queue is simply all candidates sorted by it. Why triples and not pairs: the task is looked up live from the eligibility predicates (the same axis draws different task types at different F), so **decide the task first, then compute P** — one scan yields "which word, which direction, which task type" at once.

Retrievability (how much of the KP is still accessible):

```
C     = min( 2^(−Δtick / H_tick),  2^(−Δt / H_cache) )      ← short-term cache residue (dual parallel channels, shared)
L_a   = 2^(−Δt_a / H_time_a)                                 ← long-term trace (per direction)
R_a   = C × L_a                       a ∈ {R, P}             ← service-readiness: cache flushed × trace alive
```

The two quantities have distinct jobs: **R_a only answers "is it worth serving now"** (the ripeness gate) — after 4–5 distractor tasks (or ≈20 minutes) of cache flushing, R drops and the word floats back, so reviews and introductions interleave naturally. But **"is it dead" (RELEARN routing), "how overdue" (urgency), and "how much survived the interval" (scoring's R_served) must all look at L_a** — a cold cache (C→0) is successful flushing, not forgetting; judging death by R_a would route the entire vocabulary into re-encoding after a single night.

Priority:

```
gap     = max(0, target_a − F_a) / target_a        need: normalized distance to the personal target;
                                                     an axis at target with H_time < 30d takes MAINT_GAP
                                                     (0.05) — maintenance reviews until retention is proven
urgency = ((RIPE_R − L_a) / RIPE_R)²               overdue degree of the long-term trace, squared
P       = w_freq × gap × (1 + URGENCY_GAIN × urgency)

w_freq   = 1 + log(1 + freq)    importance: high-freq KPs matter more
```

Why urgency is a squared overdue term and not (1−L): forgetting has an **optimal service window** (Bjork's desirable difficulty: after forgetting has begun, before it is complete). A freshly ripe KP is not urgent; the longer past the window, the higher the cost — failed retrieval drags F down and halves H. The cost accelerates, hence the square. A KP whose L has fallen through `RELEARN_R` (0.2) is not "more in need" — it has already defaulted: it no longer earns a retrieval/speed task and is routed straight back to re-encoding (Step 1+2 style). Routing judges the **P axis's L** — re-encoding resets both axes, which is only warranted when the production trace is also dead; an R axis that dies alone (the F_R floor never refreshes `last_ts_r`, so L_R decays to zero) is simply re-tested via STEP4R/MFI in normal competition, without dragging F_P down with it. Literature anchors at the end.

**No strand-quota coefficient.** Balance across the four strands (MFI/MFO/LRL/FD) is not enforced by the scheduler — it emerges from demand: neglect a strand and the corresponding direction's F stalls, its gap widens, and that strand's tasks naturally win the competition; a quota system would force tasks where no real demand exists. The strands' job is to guide the **coverage of the task library** — every strand must have a real, dispatchable task (first achieved once MFI lands).

Task library (replaces the old band→task lookup):

| Task | Feeds axis | Strand | Eligibility predicate |
|---|---|---|---|
| Step 1+2 (STEP12) | seeds both axes | LRL | never attempted (last_ts = 0) |
| Step 3 contextual retrieval | P mainly; floors F_R via P⊃R transfer | LRL | already seeded |
| Step 4 timed writing | P | FD | F_P ≥ 50 (ACCURACY_FLOOR) |
| Step 4R timed speed reading | R | FD | F_R ≥ 50 and material ≥ READ_MIN_WORDS |
| MFI comprehensible input | R | MFI | F_R ≥ 50 and book-source corpus available |
| Part B batch integration | P | MFO | gated (see scheduling loop); never competes on P |

Eligibility predicates guarantee "accuracy before speed" without bands: below F = 50 no speed task is dispatchable, so candidates naturally fall back to retrieval tasks. KPs whose material is too short (wordlist imports carry only the chunk itself) have no measurable reading construct: no R-direction task is dispatchable and F_R mirrors F_P. Candidates on the same axis share gap and urgency, so their P is necessarily equal — ties are broken by a **task rank** preferring the richer construct: STEP4 > STEP3 on the P axis, MFI > STEP4R on the R axis.

The scheduling loop:

1. **Part B first**: ≥ 5 not-yet-integrated KPs with both axes ≥ 75 (INTEGRATE_FLOOR) → immediate batch task.
2. **Ripe candidates next**: triples passing the dual gate — `R_a ≤ 0.9` (RIPE_R, forgetting ripeness) and `C ≤ 0.5` (CACHE_COLD, cache cooled: ≈4–5 distractor tasks of flushing, or ≈20+ minutes of natural cooling) — serve the one with max P.
3. **Introduction (slotted in)**: when either a) the review candidate pool is empty, or b) the top P falls below NEW_WORD_BYPASS (no urgent reviews — slip an introduction in), draw the next NEW KP from the active goal in `freq` order. Introductions double as the distractor tasks that flush everyone else's cache.
4. **Nothing at all → EMPTY**: report the soonest ripening time (min over all words, all axes) instead of drilling early.

Why reviews strictly precede new words: reviews are **time-critical assets** — missing the service window costs relearning; a new KP has last_ts = 0, nothing is decaying, waiting is free.

Introduction carries **no quota and no inventory cap**: every introduced word ripens into a review candidate about an hour later (the H_time seed) and immediately competes on P, tightening the bypass threshold as it does — introduction itself manufactures future review pressure, so the system is a negative-feedback loop that throttles itself and needs no external accounting-style cap. **Calibration watch item**: low-frequency new words (freq = NULL → w_freq = 1) sit at P ≈ 0.8 right after seeding, which may fall below BYPASS and fail to block further introductions; if events show a cold-start binge (many consecutive introductions followed by a next-day pass-rate crash), revisit this point and add a constraint.

GRADUATED KPs never enter the queue — practice stops once the target is verifiably reached (see *Target-anchored fluency & graduation*).

Why this replaces the state machine:

- **Spacing emerges, it is not enforced.** A just-practiced KP has C ≈ 1 → R ≈ 1 → the gates are shut. Intervening tasks and elapsed time decay C and L, so it floats back up exactly when it needs re-testing.
- **Failure is self-correcting.** A failed attempt has `attempt = 0`, which drags F down and shortens H; the KP automatically starts drawing easier tasks — no demotion rules. Severely overdue KPs (L < RELEARN_R) are explicitly routed to re-encoding — admit it's dead, don't test it.
- **No boundary to handle.** The cache's time channel cools everything overnight for free, `R_time` keeps decaying, and any priority scan naturally surfaces what is due — no gate conversion, no tick reset, no need to know when the user starts or leaves.
- **One knob per KP per direction.** All adaptivity (goal-specific difficulty, review timing, speed pressure) is expressed through F, H, and target — split by direction where learning science says the traces are independent (R/P), shared where it says they are not (tick cache) — tuning the system means tuning one scoring pipeline.

Scoping rules:

- **New KPs** are drawn only from the *active goal* (`active_goal_id`) — introduction effort stays focused on the chosen target.
- **Reviews are goal-blind** (default): ripe KPs from any goal compete purely on P — forgetting waits for no one. The user may enable "active goal only" (`goal_scope_strict`): reviews and Part B batches are then limited to the active goal, at the cost of pausing review for in-progress KPs from other goals.
- **Known words are not re-taught.** The assessment's per-word answers land in the `known_words` table; on goal import, hits skip the NEW stage — seeded high (F_P=15, F_R=60 knowledge-confirmed line) straight into the review queue, where one extraction verification sends them climbing fast (self-reported knowledge is verified once, not blindly trusted). Beyond the sparse sample (~40 words per test), "presumed known" generalizes via the frequency-ranked word list (`data/word-rank.txt`, line number = BNC/COCA rank) cut at `vocab_estimate` — the same list backs MFI's known-coverage and gap-based material selection.

Every attempt is appended to the `events` log (`tick`, `ts`, `kind`, `word_id`, `result`, latency in `detail`) — both the audit trail and the calibration dataset.

#### Learn task type

Strand labels follow Nation's four strands: **MFI** (meaning-focused input), **MFO** (meaning-focused output), **LRL** (language-focused learning), **FD** (fluency development).

##### Step 1+2 — Introduction task (current: `STEP12`)
**description** User meets a new KP: reads chunk + meaning + scene sentence, then blind-types the chunk from its meaning cue.
**type** LRL · reading → writing
**scored** no (form check only; mistype = retype on the spot)
**effect** initializes the KP: both axes seeded (F_P = 15, F_R = 8 — the form was seen but recognition is unverified), H_tick ≈ 4 tasks, H_time_P = H_time_R ≈ 1h

##### Step 3 — Contextual retrieval task
**description** After spacing, the KP's scene sentence reappears with the chunk blanked out; user recalls and produces it.
**type** LRL · reading → writing
**direction** P (produce form from meaning) — mainly updates F_P; a pass also floors F_R at A×60 via P⊃R transfer (this is the ramp that carries F_R from the seed value 8 up to 50)
**scored** pass/fail → fluency update
**effect** pass pushes F_P toward 50 (once the floored F_R also clears 50, R-direction speed tasks unlock); fail drags F_P down and halves H_time_P; mistype = redo Step 2 on the spot

##### Step 4 — Speed production task
**description** Timed production: user writes 2–3 sentences using the chunk under a time budget set by the adaptive speed cursor (4/3/2-style pressure, automated). Measures response latency and derived wpm.
**type** FD · writing
**direction** P — updates F_P only; a pass also floors F_R at A×60 via P⊃R transfer
**scored** accuracy + latency → main input to the fluency score
**speed scale** typing modality: 25 wpm (L2 fluent-typing floor) → 60 wpm (native average ceiling); the cursor caps at the goal profile's writing_wpm

##### Step 4R — Timed speed-reading task
**description** The reading half of FD: the KP's three scenario sentences (`step4_sentences`) serve as the speed-reading passage; the user reads it in one go under a time budget set by the reading cursor, then self-grades comprehension (self-reported understanding is what makes the speed measurement valid — no skimming for points). Reading wpm = passage words / time, scored against the goal profile's `reading_wpm`. The countdown hitting zero does not lock the form: the user may finish reading overtime, and the overtime itself drags measured wpm down and blocks cursor ratcheting.
**type** FD · reading
**direction** R — updates F_R only; no transfer back to F_P
**scored** comprehension self-grade + measured wpm → F_R update; read within budget → reading cursor +5% (capped at `reading_wpm`), not understood → −10% (floored at `v_floor_reading`)
**speed scale** 150 wpm (the minimum speed at which most meaning is captured; below it the brain is still decoding word by word) → 300 wpm (native ceiling, top of 250–300)

##### MFI — Comprehensible input task
**description** Slice a 150–300-word continuous passage from the book-source text, requiring the target KP to appear and ≥ 95% known-word coverage in the passage (known = stopwords + short words + the top vocab_estimate words of the frequency-ranked list ∪ assessment-confirmed words ∪ attempted tokens); the user reads it under the reading cursor's time budget, then takes a gist-comprehension self-check (three options, generated from neighbouring passage sentences). Fills the long-vacant MFI strand.
**type** MFI · reading
**direction** R — updates F_R; the reading cursor ratchets up/down by the same rules
**eligibility** F_R ≥ 50 and book-source corpus available; wordlist/IELTS goals without book text are ineligible and the candidate falls back to Step 4R
**scored** comprehension correct + reading wpm → F_R update

##### Part B — Integrated retelling task
**description** Batch gate: once 5 not-yet-integrated KPs have both axes ≥ 75, the user chains their model sentences into a micro-text and retells it from a skeleton.
**type** MFO · writing
**direction** P
**scored** all-or-nothing per KP → fluency update
**effect** pass → KP certified integrated, F_P floored at 80, H_time_P jumps to the 1d rung; a missed KP's F_P drops and it falls back to lower-band tasks on its own

##### (Parked — outside literacy scope) Shadowing task
**description** User repeats audio of the scene sentence in real time, graded on completion time vs audio length. Parked: spoken-form aspects of Nation's profile are out of scope for now.
**type** FD · listening → speaking

#### fluency score algorithm

Per scored attempt (Step 3, Step 4, Step 4R, MFI, Part B):

```
A = accuracy:  1.0 clean pass · 0.5 pass with hint/self-correction · 0 fail
v = measured speed (wpm)
S = clamp( (v − v_floor) / (v_ceil − v_floor),  0, 1 )
attempt = A × (60 + 40 × S)
// fail → 0 · below v_floor → accuracy-only 60 (not fluency, still LRL) · at v_ceil → 100
```

`v_floor` / `v_ceil` are the per-modality speed scale endpoints (reading 150 → 300 wpm, writing-typing 25 → 60 wpm; see *Target-anchored fluency*); for untimed typing tasks v derives from latency (`T_target`: Step 2/3 typing = 350ms × chunk length). Latency and derived v are recorded in `events.detail` (JSON) on every scored attempt.

Per-KP update — exponential moving average over a decayed prior, **updating only the practiced direction**:

```
R_served = max(L_a, 0.8)        // SCORE_R_FLOOR: scoring asks "how much of the long-term trace
                                // survived the interval" — L, not C×L (a cold cache is the designed
                                // service point, not late scheduling); L < 0.8 counts as 0.8 —
                                // queueing delay is not the learner's fault
F_a ← (1 − α) · F_a · R_served  +  α · attempt,   α = 0.4
```

One decay model serves both queue and score: scheduling asks "is R low enough to bother?", scoring asks "how much of F survived the gap?".

**P⊃R transfer (one-way, knowledge-only).** A scored P pass (Step 3 / Step 4) demonstrates the harder direction, so receptive knowledge is confirmed for the same aspect and sense:

```
F_R ← max(F_R,  A × 60)        // clean pass floors at 60, hint pass at 30
```

60 is exactly the accuracy-only line in the attempt formula: *knowledge confirmed, reading speed uncertified*. The floor never lowers F_R, never touches H_time_R or `last_ts_r`, and since 60 < 75 a KP can never reach the integration pool on transfer alone — reading speed must be earned by real Step 4R / MFI passes. No reverse transfer (recognition never implies production), and P fails transfer nothing (can't produce ≠ can't recognize). KPs without readable material skip the distinction entirely: F_R mirrors F_P on every P update.

Stability updates are per direction: success lengthens that direction's H_time (×2 — seeded at 1h, growing through 1d → 3d → 7d …), failure shortens it (÷2, floor 1h). H_tick stays short (~4–5 tasks) and shared — its only job is the cache's interference channel.

Aggregation:

```
goal fluency  = Σ(wᵢ · min(F_R,F_P)ᵢ) / Σwᵢ,   wᵢ = 1 + log(1 + freqᵢ)   // headline; the dashboard
                additionally reports the R/P split (ΣwᵢF_R / ΣwᵢF_P) as display metrics
goal progress = freq-weighted share of KPs at personal target on both axes
                (F_R ≥ target_in and F_P ≥ target_out)
user level    = vocab_estimate (breadth, from the placement test)
                × mean min-fluency of active KPs (depth)
                → normalized to 0–100 → CEFR/IELTS band via levelOf()
```

Score semantics: **F ≥ target** = personal target reached (both axes reached + sufficient retention → graduation), **50–80** = effortful-but-reliable, **< 50** = recognition-only.

Schema notes: `words` holds `fluency` (F_P), `fluency_r` (F_R), `target_in`, `target_out`, `stability_tick`, `stability_time` (H_time_P), `stability_time_r` (H_time_R), `last_tick`, `last_ts` (P anchor), `last_ts_r` (R anchor), `integrated`, `graduated`, `profile` (Nation aspect-checklist bitmask); `goals.target TEXT` stores the JSON target profile; per-user per-modality speed cursors live in `meta` (`v_cursor_reading`, `v_cursor_writing`); latency + accuracy grade are recorded in `events.detail`.

#### Target-anchored fluency & graduation

F is not an abstract score — it is anchored to a measurable performance target declared by each goal.

**1. Goal target profile.** Every goal declares its end-state in measurable terms:

```
IELTS 7.0 goal:   { vocab_size: 7200, reading_wpm: 200, writing_wpm: 30 }
Book goal:        { reading_wpm: 200, writing_wpm: 25 }
```

Decomposition: `vocab_size` decides which KPs enter the queue; the wpm targets decide each word's **personal fluency target** (below) and every timed task's `T_budget` (`T_budget = material_length / v_cursor`, the cursor ratchets toward the goal speed).

**2. Per-KP personal targets (target_in / target_out).** The goal speed is translated into per-word fluency targets — the goal speed's position on the scale maps into the 80–95 range, then frequency modulates it upward:

```
reading position = clamp((goal reading_wpm − 150) / (300 − 150), 0, 1)   // 150 = minimum speed that captures most meaning
writing position = clamp((goal writing_wpm − 25) / (60 − 25), 0, 1)      // typing scale; handwriting scale 15 → 30 reserved as a modality switch

base_in  = 80 + 15 × reading position    // 150 wpm (fluency floor) → 80; 300 wpm (native ceiling) → 95
base_out = 80 + 15 × writing position    // 25 wpm (L2 fluent floor) → 80; 60 wpm (native average ceiling) → 95

target_in  = min(100, base_in  × freqFactor)    // freqFactor = 1 + 0.1 × min(1, ln(1+freq)/ln 101)
target_out = min(100, base_out × freqFactor)    // ∈ [1.0, 1.1], upward-only — the fluency floor is never
                                                // diluted; capped at freq ≥ 100; no freq info → 1.0
```

Materialized into `words.target_in` / `target_out` at intake; recomputed in bulk for all of a goal's words when its speed target changes. Intuition: under a 300-wpm reading goal, high-frequency words must be near-automatic (target ≈ 95+), while even rare words sit at the fluency line (80) — high-frequency words occur densely in reading and drag speed the most, so frequency only pushes targets up.

**3. F means "fraction of the personal target".** gap = (target − F)⁺ / target makes "distance to done" comparable across words: a word with target 90 at F 45 has gap 0.5, and so does a word with target 80 at F 40. An axis that has reached its target moves into maintenance: gap takes MAINT_GAP (0.05), staying in the queue at low priority until H_time reaches 30 days and retention is proven — graduation semantics live inside the priority formula (if gap zeroed out at target, H would freeze at a low value and GRADUATED could never be reached).

**4. Adaptive speed cursor — the pressure tracks the target.** One cursor per modality per user, ratcheting toward the goal speed:

```
T_budget = material_length / v_cursor             // pressure applied in the task
v_cursor ← min(goal speed, v_cursor × 1.05)       on a clean pass at cursor speed
v_cursor ← max(v_floor,  v_cursor × 0.90)         on an accuracy fail
seed: v_floor
```

Two speeds, two jobs: the **cursor sets the pressure** (shrinking time budget), the **measured v is scored on the absolute scale** (v_floor → v_ceil) via S. Cursor = training wheels; the scale = the ruler. The 4/3/2 technique is the manual ancestor of this — same material, shrinking budget — the cursor just automates it.

**5. Graduation — stop assigning practice.** A KP leaves the queue permanently (P = 0) when:

```
GRADUATED ⟺ F_P ≥ target_out  AND  F_R ≥ target_in      (both axes at personal target)
          ∧ H_time_P ≥ 30 days  ∧  H_time_R ≥ 30 days    (both traces survived long-term forgetting)
```

Versus the old three-axis graduation (blanket F ≥ 80 + last pass at full speed + H ≥ 30d): the endpoint moves from a fixed 80 to the personal target, and the "full-speed pass" condition is subsumed by the target — F is fed by attempts that include the speed term, so F ≥ target already implies speed is on par.

**6. Empirical speed checks.** Timed MFI/FD tasks double as ground truth: reading wpm = passage words / time (valid only when comprehension self-check passes), writing wpm = words produced / writing time. Plotting measured wpm against predicted F per KP calibrates α, the speed scales, and the `60 + 40·S` formula against reality.

**7. Mastery profile — what "completely learned" means.** Per Nation's knowledge-profile framework, knowing a word is not one test but a profile of aspects, each verified **receptively (R) and productively (P) independently** — recognition never implies production. Scoped to literacy (spoken-form aspects dropped):

| Nation aspect | R check | P check | Covered by |
|---|---|---|---|
| Form · written | recognize in print | spell correctly | reading exposure / Step 1+2 blind typing |
| Form · word parts | recognize stem & affixes | produce correct inflection | gap → word-formation task (planned) |
| Meaning · form↔meaning | recall meaning from form | produce form from meaning | MFI comprehension task / Step 3 |
| Meaning · concept & referents | know range of senses | use for correct referent | scene / substitute (partial) |
| Meaning · associations | know related words | produce associates | substitute (partial) |
| Use · grammar | accept correct pattern | use in correct pattern | Step 4 sentences |
| Use · collocations | know co-occurrences | produce with collocations | slots / Step 4 / Part B |
| Use · register constraints | know when appropriate | use appropriately | gap → `freq` is a weak prior (planned) |

> **P ⇒ R inference rule.** A P pass on an aspect marks that aspect's R check as passed (same aspect, same sense — production presupposes recognition at that granularity). R passes never imply P. The same asymmetry shows up at the score level as the one-way F_R floor in the fluency algorithm: certification is binary, estimation is graded, both are one-directional.



#### Space memorize

With a score-driven queue, spacing is no longer a set of gates — it is the shape of the priority function.

**1. Micro-spacing (cache flush), emergent.** Right after practice, C ≈ 1 → R ≈ 1 → the gates are shut and the KP sinks to the bottom. The cache then cools through two parallel channels: each intervening task advances the tick (interference channel, H_tick ≈ 4–5 tasks), and plain elapsed time flushes too (time channel, H_cache ≈ 20 minutes) — min takes whichever flushes harder. Practice a word, go eat for three hours, do zero tasks in between — the cache is still cold when you return. Every retrieval comes from long-term memory — not because a gate forced it, but because fresh KPs are simply not worth serving.

**2. Macro-spacing (SRS), same curve.** `R_time` decays with half-life H_time **per direction**, which lengthens with every success in that direction (1h → 1d → 3d → 7d, ×2 per pass) and shortens on failure (÷2, floor 1h). A KP ripens exactly when its own decay curve says so — no separate ladder table, no per-level due dates.

**3. Time boundaries, nonexistent.** The old design needed gate conversion and tick special-casing whenever a practice bout ended; the dual-channel cache model needs nothing — overnight is just the ordinary case with a large Δt, the cache's time channel and long-term forgetting both decay for free, and the next priority scan naturally floats up everything that ripened. The system neither records nor needs to know the user's practice rhythm.

**4. Scheduler = one priority scan** (see Domain Model §5):

```
Part B batch (both axes ≥ 75, un-integrated, ≥ 5)  >  max-P ripe triple (dual gate: R_a ≤ 0.9 and C ≤ 0.5)  >  slot in a new word (active goal, freq order)  >  EMPTY
```

**5. Routing the severely overdue.** A KP whose L has fallen through RELEARN_R (0.2) is outside the optimal service window — retrieval will most likely fail, and testing it only harvests a "fail" record. Such words (judged on the P axis's L; see §5 of the domain model for why) bypass the competition and route straight to a re-encoding task (Step 1+2 style re-introduction): admitting it's dead and starting over is both more honest and cheaper than testing it into failure.

**The 0.8 target lives in calibration.** Every adaptivity claim reduces to one: serve a KP when its R crosses ≈ 0.8 — the "desirable difficulty" point where recall is effortful but still succeeds. The ripeness threshold (0.9), H seeds, the ×2/÷2 stability updates, URGENCY_GAIN, H_cache, and NEW_WORD_BYPASS are initial guesses; once `events` data accumulates, fit the pass-rate-vs-R curve and set parameters so reviews land near an 80% observed pass rate.

#### Literature anchors

- **Desirable difficulty / New Theory of Disuse** (Bjork & Bjork): practice yields the most when retrieval strength is low but retrieval still succeeds — the theoretical basis of the service window.
- **Half-life regression** (Settles & Meeder 2016, Duolingo): the exponential-decay model p_recall = 2^(−Δt/h) with per-word half-life regression — our R formula is isomorphic.
- **Optimal control of spaced repetition** (Tabibian et al. 2019, PNAS): optimal review times are characterized by recall-probability thresholds — too early wastes, too late spikes failure; supports a "window", not "the more forgotten the better".
- **FSRS / Anki practice**: default desired retention 0.90 (matches RIPE_R).
- **Nation's four strands**: coverage of MFI / MFO / LRL / FD guides the design of the task library; the time share is not enforced by scheduling quotas but emerges from demand competition across the two axes' gaps.
