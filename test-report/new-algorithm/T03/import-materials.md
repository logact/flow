# T03 partial implementation evidence

- Deterministic V/rank mapping is implemented in `lib/new-algorithm-import.ts` at the normative boundaries `0.5V`, `V`, and `1.5V`.
- Import requires explicit timezone and capacity-gate callback. Missing gate fails closed with `CAPACITY_GATE_PENDING`; no capacity default was added for OPEN O1. Accepted rows use V/rank estimates, set `introduced` only for nonzero estimates, and set both axes due at the supplied import instant. The 0/0 word remains unintroduced for its single connection path.
- Confirmed gloss edits increment `meaning_version` and invalidate older versioned materials transactionally.
- `lib/new-algorithm-material-jobs.ts` requires a confirmed current gloss, validates generated material before ready status, uses the confirmed D5 two-attempt/8-second batch limit, and records failed generation state without lowering the task stage.
- `flow.db` was not opened or changed.

## Verification

Command: `npx jest --runInBand test/new-algorithm-import.jest.test.cjs`

Result: PASS, 1 suite / 11 tests. Covers initial-score boundaries and unknown/incomparable rank, capacity gate fail-closed behavior, due-now import state, gloss version invalidation/idempotent confirmation, confirmed-gloss requirement, and bounded material generation failure.

`git diff --check`: PASS.

## Remaining T03 work / blocker

T03 is not DONE. OPEN O1 still blocks production admission against daily capacity and remaining training time; the callback is an explicit boundary, not an implementation of the policy. Formal `/goals` API/page wiring, material job persistence/worker integration, ready-material lookup and successful generation/validation sample coverage are also not complete. No route or page was changed in this partial pass.
