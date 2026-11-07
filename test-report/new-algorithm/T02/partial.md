# T02 partial score/connection evidence

- Implemented pure score mapping for current `algorithm.md`: choice/cued/free thresholds, RETRIEVE outcome values, R/P FLUENCY formulas, and a double-zero-only word-level connection that increments one tick.
- Removed the prior D2 half-life enhancement from T02 settlement. ENCODE initializes both axes once; target-axis FLUENCY updates its pass/completion projection.
- Added pure independent-axis review transitions: ideal 1/3/7/30 progression, O3 actual-settlement-local-day anchor, valid no-score-drop demotion, below-target same-day learning recovery, invalid no-op, and local-calendar/DST conversion.
- Commands: `npx jest --runInBand test/new-algorithm-score.jest.test.cjs`; `npx jest --runInBand test/new-algorithm-review.jest.test.cjs`.
- Results: score 16/16; review 9/9. Coordinator rerun of both suites: 25/25.
- Status: BLOCKED for T02 completion while T01 schema v3 adds countable introduction reservations. Remaining: atomic DB settlement, consuming task_count, target-change projection, review/retake reservation updates, rollback/replay evidence. O2/O3 defaults are confirmed and applied by the pure helper.
