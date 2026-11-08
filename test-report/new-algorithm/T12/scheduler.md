# T12 scheduling and capacity (in progress)

Implemented in `lib/new-algorithm-scheduler.ts`:

- Deterministic review → learning → new candidate ordering, then local due date, word ID, and R-before-P tie-break; graduated/material-unavailable candidates are omitted.
- Shared cooldown gate: seven valid ticks or 20 minutes.
- Per-axis minimum introduction task count matches T03's 3/5/7/9 tiers, plus `localReviewDates` for the 1/3/7/30 local-day path.
- Today through day 41 (42 local-date labels) capacity projection with completed, determined, conditional, and introduction counts and admission feasibility.
- Schema-backed candidate loading converts `due_at` instants using each word's IANA timezone and includes unintroduced double-zero words only when an active introduction reservation and ready ENCODE material exist.
- Axis-scoped active reservation cancellation and stable-ID idempotent upsert; daily-capacity and active-reservation projection from the isolated DB.

Validation: `npx jest --runInBand test/new-algorithm-scheduler.jest.test.cjs` — 8/8; full `npx jest --runInBand` — 15 suites / 157 tests; `git diff --check` PASS. `npx tsc --noEmit` still reports only the two pre-existing unrelated errors in `app/score-history/page.tsx:57` and `lib/manual-test-fixtures.ts:183`.

## Still incomplete

- New-word rank ordering and capacity admission/recalculation are not yet an atomic DB operation.
- Feasibility against remaining daily session time is not calculated.
- Material failure does not yet compare another same-stage candidate or return precise material status.
- EMPTY reasons and `next_available_at` are not derived here.
- Formal T04 dispatch is not yet wired to this scheduler; do not claim end-to-end priority/capacity behavior or mark T12 DONE.
- V05 human acceptance remains outstanding.
