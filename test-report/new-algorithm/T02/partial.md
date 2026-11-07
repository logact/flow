# T02 partial score/connection evidence

- Implemented pure score mapping for current `algorithm.md`: choice/cued/free thresholds, RETRIEVE outcome values, R/P FLUENCY formulas, and a double-zero-only word-level connection that increments one tick.
- Removed the prior D2 half-life enhancement from the T02 settlement path. A valid target-axis FLUENCY outcome can update its pass/completion projection; ENCODE writes both scores once. No `due_at`, review-level or reservation transition is asserted because OPEN O2/O3 remain unresolved.
- Jest command: `npx jest --runInBand test/new-algorithm-score.jest.test.cjs`
- Result: PASS, 1 suite / 16 tests.
- Status: BLOCKED for T02 completion. Remaining: atomic DB settlement assertions against schema v2, due/review/capacity transaction behavior after O2/O3 are decided, and integrated error/replay evidence.
