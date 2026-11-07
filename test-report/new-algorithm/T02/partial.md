# T02 score, review and settlement evidence

- Pure score mapping covers current `algorithm.md` choice/cued/free thresholds, R/P FLUENCY formulas, target outcomes and one-tick double-zero connection.
- Pure review rules cover independent per-axis 1/3/7/30 progression, actual local settlement-date anchoring (O3), pass/fail demotion, same-day return to learning below target, invalid no-op and DST/local-midnight conversion.
- SQLite settlement now applies a valid connection to both axes, and applies each R/P score, FLUENCY evidence, `learning_complete`, review level, local `due_at`, per-axis graduation and aggregate graduation atomically. A valid first FLUENCY pass that meets target starts that axis at level 1; a scheduled review only passes when the current FLUENCY outcome is fully fluent and the resulting score meets target.
- Capacity is consumed in the same transaction as score settlement. The immutable `task_instances.snapshot_json` must carry `capacity_reservation_id`; settlement validates that exact active reservation, word, axis/type and local day, decrements its positive `task_count` (marking it consumed at the last task), and increments `daily_capacity.completed`. No reservation is guessed. T04/T12 must freeze the ID into every capacity-backed task instance. Invalid/uncertain/service-error outcomes do not consume capacity.
- If settlement crosses local midnight, capacity usage moves to the actual completion day: the original reservation is decremented, and the next day's configured capacity plus active reservations are checked before incrementing its completed count. Missing next-day capacity fails closed and rolls back.
- `updateNewAlgorithmTargets` validates 60–100 targets. If a target increase makes an axis ineligible, that axis loses learning/FLUENCY/review/graduation evidence, its active R/P review reservations are cancelled, and it returns to the user's current local day; the other axis schedule is preserved. Lower or still-satisfied targets do not reset eligible review evidence.
- Jest commands:
  - `npx jest --runInBand test/new-algorithm-score.jest.test.cjs test/new-algorithm-review.jest.test.cjs test/new-algorithm-settlement.jest.test.cjs`
  - Result: 3 suites / 34 tests passed (16 scoring, 9 review rules, 9 DB settlement); full configured Jest run: 6 suites / 63 tests passed.
  - `git diff --check`: PASS.
  - `npx tsc --noEmit`: only the previously known errors remain at `app/score-history/page.tsx:57` and `lib/manual-test-fixtures.ts:183`; no T02 error reported.
- `flow.db` was not opened or changed.

## Scenarios covered by DB settlement tests

1. Connection writes R/P=5, consumes one of nine reserved tasks, increments daily completion and tick once; replay changes none of these again.
2. R FLUENCY target pass sets score 80, records pass/completion, and schedules R at the next local date while leaving P unchanged.
3. R review failure with no score drop demotes 3→1 and schedules from the actual local settlement day, preserving the P due date.
4. R passes its level-30 review and graduates R only; P remains not graduated.
5. Raising R target above its score cancels only R review reservations and returns R to today's local learning queue, preserving P's independent review schedule.
6. Valid completion across local midnight moves capacity consumption to the actual local day.
7. Invalid FLUENCY retries without consuming capacity, changing score/review schedule or incrementing tick.
8. A missing reservation ID fails closed and transactionally rolls back score, task/attempt status, tick and capacity writes.
9. Target changes while a task on an affected axis is active fail atomically, preventing stale issued snapshots.

## Integration gate

Every issued task that consumes configured daily capacity must freeze its exact reservation ID as `snapshot_json.capacity_reservation_id`. T04 and T12 are downstream owners of task creation/selection and must populate this field before calling settlement. Their integration and end-to-end evidence remain outstanding; this report does not claim formal task dispatch is complete.
