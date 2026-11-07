# T03 partial implementation evidence

- Deterministic V/rank mapping is implemented in `lib/new-algorithm-import.ts` at the normative boundaries `0.5V`, `V`, and `1.5V`.
- Import requires an explicit capacity reservation callback. The production route uses `reserveIntroductionCapacity` inside the same SQLite transaction as word insertion. It checks daily capacity minus DB `completed` and active reservation `task_count`, enforces the configured local training window, then inserts one active `axis='both'`, `reservation_kind='introduction'` row per word with the 3/5/7/9 minimum path. Any gate failure rolls back both the word and reservation inserts. The runtime DB is `.flow-new-algorithm.db` or `FLOW_NEW_ALGORITHM_DB`; `flow.db` is not opened.
- Confirmed gloss edits increment `meaning_version` and invalidate older versioned materials transactionally.
- `lib/new-algorithm-material-jobs.ts` requires a confirmed current gloss, validates generated material before ready status, uses the confirmed D5 two-attempt/8-second batch limit, and records failed generation state without lowering the task stage.
- `flow.db` was not opened or changed.

## O1 and goals UI/API

- `/goals` now exposes a separate new-algorithm prototype import panel with user-provided vocabulary size, daily task capacity, local training window, and `term|meaning|rank` rows.
- `/api/new-algorithm/goals` stores daily availability in the new algorithm database and imports through the capacity gate. The runtime database is `.flow-new-algorithm.db` (or `FLOW_NEW_ALGORITHM_DB`); it does not open `flow.db`.
- Capacity feasibility uses 3/5/7/9 minimum task paths and the confirmed conservative cooldown floor of 20 minutes per adjacent same-word task, excluding answer time. Capacity/window are user configured; no history estimate is used.
- Material states are persisted in the `materials` table (`preparing`, `ready`, `failed`); ready lookup filters current gloss version and unused material.
- The `/goals` API uses the isolated runtime DB and requires an explicit timezone on GET and import. Configure reads actual DB completion state and ignores client-supplied `completed`.
- Materials persist `preparing` / `ready` / `failed` job state, bounded retry attempts, validation results, and ready lookup filters current gloss version plus unused state.
- API tests use a fresh on-disk temporary SQLite file via `FLOW_NEW_ALGORITHM_DB`; they cover missing timezone, configured capacity/completed behavior, malformed input and fail-closed import.
- `npx jest --runInBand test/new-algorithm-import.jest.test.cjs test/new-algorithm-goals-api.jest.test.cjs` — PASS, 22 tests. Coverage includes V/rank boundaries, 3/5/7/9 path costs, capacity and active-reservation accounting, transaction rollback on insufficient capacity, window-start/exclusive-end and exact cooldown-floor boundaries, materials retry/status and ready lookup, and API validation against an isolated temporary DB.
- `git diff --check` — PASS.

## Remaining integration gates

- No browser/manual UI acceptance evidence has been collected.
- Material provider/worker invocation and downstream issuance/settlement are handled by later DAG tasks; this task persists job state and exposes ready lookup only.
- T02 settlement must consume/release active capacity reservations when tasks complete; the T03 admission path intentionally counts active reservations until settlement does so.
