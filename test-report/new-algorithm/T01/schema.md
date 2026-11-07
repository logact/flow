# T01 schema validation

- Status: PASS for isolated schema v3 initialization and constraints; application integration is not part of T01.
- Database: tests use `createNewAlgorithmDb()` with in-memory SQLite. `flow.db` was not opened, modified, or migrated.
- Versioning: the schema version is `3`. Initialization is idempotent for a v3 database. Unversioned nonempty databases and v1/v2 databases are rejected inside the initialization transaction; the rejection leaves the old version marker unchanged and creates no `words` table. There is no in-place upgrade path.
- Reservation schema: `capacity_reservations` stores `task_count INTEGER NOT NULL CHECK(typeof(task_count)='integer' AND task_count > 0)`. Allowed kinds are `determined`, `conditional`, and `introduction`. The table CHECK restricts `introduction` to `axis='both'` and the two review kinds to `axis IN ('r','p')`. The existing uniqueness key remains `(word_id, axis, local_date, timezone, reservation_kind)`; `word_id` retains its foreign key to `words(id)`.
- Capacity policy is not implemented here. `task_count` is only a persisted positive integer; dates, status transitions, and how reservations consume daily capacity remain the responsibility of later tasks.
- Existing v2 columns and task/event/attempt constraints remain intact, including separate R/P due dates and review state, one live task instance, event dedupe, completed connection uniqueness, and retry after an invalid attempt.

## Verification

Command: `npx jest --runInBand test/new-algorithm-db.jest.test.cjs`

Result: PASS, 1 suite / 7 tests. Coverage includes v3 idempotency; rejection of unversioned nonempty, v1, and v2 databases; storage of task counts 3/5/7/9 and rejection of zero/fractional counts; `both` introduction and per-axis review constraints; duplicate reservation uniqueness; foreign keys; one live instance; retry after an invalid attempt; event dedupe; and transaction rollback.

Schema shape checked by the test fixture and insert constraints:

```sql
capacity_reservations(
  reservation_id TEXT PRIMARY KEY,
  word_id INTEGER NOT NULL REFERENCES words(id),
  axis TEXT NOT NULL CHECK(axis IN ('r','p','both')),
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  reservation_kind TEXT NOT NULL CHECK(reservation_kind IN ('determined','conditional','introduction')),
  task_count INTEGER NOT NULL CHECK(typeof(task_count)='integer' AND task_count > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','cancelled','consumed')),
  CHECK((reservation_kind='introduction' AND axis='both') OR
        (reservation_kind IN ('determined','conditional') AND axis IN ('r','p'))),
  UNIQUE(word_id, axis, local_date, timezone, reservation_kind)
)
```

`git diff --check -- lib/new-algorithm-db.ts test/new-algorithm-db.jest.test.cjs`: PASS.
