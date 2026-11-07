# T01 schema validation

- Status: PASS for T01 schema and temporary DB acceptance; no application integration is in T01 scope.
- Database: `createNewAlgorithmDb()` in-memory temporary SQLite; `flow.db` was not opened, modified, or migrated.
- Date representation: `due_at_r/p` preserve an ISO timestamp as text; `local_timezone` stores an explicit IANA timezone per word. Capacity/reservation rows store the local calendar date and timezone separately. This is a storage shape only; OPEN O1–O3 scheduling policies remain unresolved and are not encoded here.
- Schema includes independent R/P learning completion, review level, graduation, due dates; `axis=both` is restricted to ENCODE/encode; successful connection can only be completed once per word; daily capacity and determined/conditional reservations are separate; unique event keys, foreign keys, and one live instance are enforced.
- Invalid attempts may be followed by a new attempt: only active frozen/grading-retry attempts and completed attempts have per-instance uniqueness constraints.

## Verification

Command: `npx jest --runInBand test/new-algorithm-db.jest.test.cjs`

Result: PASS, 1 suite / 5 tests. Covered initialization idempotency at schema version 2, rejection of nonempty and version-1 databases, independent axis fields, connection uniqueness, daily-capacity primary key and nonnegative CHECK, determined/conditional reservations coexisting plus duplicate rejection, live-instance uniqueness, invalid-attempt retry, event dedupe, composite material/task foreign key, and transaction rollback.

`git diff --check`: PASS.
