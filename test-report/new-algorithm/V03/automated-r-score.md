# V03 automated R fluency score trace

## What ran

Command: `npx jest --runInBand test/new-algorithm-r-fluency-service.jest.test.cjs`

Result: 1 suite, 6 tests passed. The tests obtain the R FLUENCY instance from the formal scheduler, submit through `submitNewAlgorithmFluencyAnswer`, replay the frozen timing protocol on the server, grade with deterministic evaluator outputs, and inspect persisted R/P state.

## Score/state transitions

All success-path cases begin at **R=80, P=35, target_R=100** with one due R reservation and a frozen 100-word passage. `WPM = 100 words × 60 ÷ server-replayed reading seconds`; the server interval is rounded to integer milliseconds.

| Scenario | Action / server timing | R transition | P after | State result |
|---|---|---:|---:|---|
| V03-R-149 | Read 100 words in 40.268 s; actual 148.999 WPM | 80 → 40 (−40; below 150) | 35 | No R fluency pass or review schedule |
| V03-R-150 | Read in 40 s; 150 WPM | 80 → 60 (−20; speed floor) | 35 | No R fluency pass or review schedule |
| V03-R-200 | Read in 30 s; 200 WPM | 80 → 73.333 (−6.667) | 35 | No R fluency pass or review schedule |
| V03-R-225 | Read in 26.667 s; actual 224.997 WPM | 80 → 79.999 (−0.001) | 35 | Just below target 100; no R fluency pass |
| V03-R-300 | Read in 20 s; 300 WPM | 80 → 100 (+20) | 35 | R target passes; `learning_complete_r=1`, review level 1, due next local day; P unchanged |
| V03-R-target-fail | 200 WPM, evaluator says target failed | 80 → 40 (−40) | 35 | No R fluency pass |
| V03-R-overall-fail | 200 WPM, target passes but overall comprehension fails | 80 → 80 (0) | 35 | Valid attempt; score unchanged |

## Limit

The passage and evaluator in this deterministic Jest fixture are not evidence of real provider output or naturalness. V03 remains BLOCKED until a real generated R passage and answer evidence are inspected and a person completes the formal-page initial-read/reread flow, including narrow-screen operation. No browser interaction is claimed.
