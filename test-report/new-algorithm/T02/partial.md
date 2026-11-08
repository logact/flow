# T02 score, review and settlement evidence

- Pure score mapping covers current `algorithm.md` choice/cued/free thresholds, R/P FLUENCY formulas, target outcomes and one-tick double-zero connection.
- Pure review rules cover independent per-axis 1/3/7/30 progression, actual local settlement-date anchoring (O3), pass/fail demotion, same-day return to learning below target, invalid no-op and DST/local-midnight conversion.
- SQLite settlement now applies a valid connection to both axes, and applies each R/P score, FLUENCY evidence, `learning_complete`, review level, local `due_at`, per-axis graduation and aggregate graduation atomically. A valid first FLUENCY pass that meets target starts that axis at level 1; a scheduled review only passes when the current FLUENCY outcome is fully fluent and the resulting score meets target.
- Capacity is consumed in the same transaction as score settlement. The immutable `task_instances.snapshot_json` must carry `capacity_reservation_id`; settlement validates that exact active reservation, word, axis/type and local day, decrements its positive `task_count` (marking it consumed at the last task), and increments `daily_capacity.completed`. No reservation is guessed. T04/T12 must freeze the ID into every capacity-backed task instance. Invalid/uncertain/service-error outcomes do not consume capacity.
- If settlement crosses local midnight, capacity usage moves to the actual completion day: the original reservation is decremented, and the next day's configured capacity plus active reservations are checked before incrementing its completed count. Missing next-day capacity fails closed and rolls back.
- `updateNewAlgorithmTargets` validates 60–100 targets. If a target increase makes an axis ineligible, that axis loses learning/FLUENCY/review/graduation evidence, its active R/P review reservations are cancelled, and it returns to the user's current local day; a deterministic one-task reservation is created when that local day's remaining capacity allows it. The result identifies requeued axes and axes blocked by full/unconfigured capacity; the other axis schedule is preserved. Lower or still-satisfied targets do not reset eligible review evidence.
- Jest commands:
  - `npx jest --runInBand test/new-algorithm-score.jest.test.cjs test/new-algorithm-review.jest.test.cjs test/new-algorithm-settlement.jest.test.cjs`
  - Result: 3 suites / 35 tests passed (16 scoring, 9 review rules, 10 DB settlement); full Jest run: 15 suites / 170 tests passed.
  - `git diff --check`: PASS.
  - `npx tsc --noEmit`: only the previously known errors remain at `app/score-history/page.tsx:57` and `lib/manual-test-fixtures.ts:183`; no T02 error reported.
- `flow.db` was not opened or changed.

## Scenarios covered by DB settlement tests

1. Connection writes R/P=5, consumes one of nine reserved tasks, increments daily completion and tick once; replay changes none of these again.
2. R FLUENCY target pass sets score 80, records pass/completion, and schedules R at the next local date while leaving P unchanged.
3. R review failure with no score drop demotes 3→1 and schedules from the actual local settlement day, preserving the P due date.
4. R passes its level-30 review and graduates R only; P remains not graduated.
5. Raising R target above its score cancels only R review reservations, creates today's R task reservation when capacity permits, and leaves P's independent review schedule intact; when P occupies the last slot, R is explicitly reported capacity-blocked.
6. A failed R review returns through the scheduler on its demoted axis due date; P remains independently scheduled.
7. Valid completion across local midnight moves capacity consumption to the actual local day.
8. Invalid FLUENCY retries without consuming capacity, changing score/review schedule or incrementing tick.
9. A missing reservation ID fails closed and transactionally rolls back score, task/attempt status, tick and capacity writes.
10. Target changes while a task on an affected axis is active fail atomically, preventing stale issued snapshots.

## Integration gate

Every issued task that consumes configured daily capacity must freeze its exact reservation ID as `snapshot_json.capacity_reservation_id`. T04/T12 connection and choice dispatch now freeze and consume the exact reservation; unsupported later stages and full lifecycle recovery are downstream T13 work. Human acceptance remains in V01/V05 and is not claimed by these database tests.
