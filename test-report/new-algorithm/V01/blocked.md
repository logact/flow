# V01 minimum learning loop — BLOCKED

## Available technical evidence

- T03 isolated import/material setup: `test-report/new-algorithm/T03/import-materials.md` (22 Jest tests at node delivery).
- T04 isolated task API: `test-report/new-algorithm/T04/isolated-task-service.md` (connection and choice only).
- T05 isolated page: `test-report/new-algorithm/T05/isolated-task-ui.md` (source-contract tests only).
- T07 renderer now supports choice/cued/free payload shapes, but the T04 service still issues choice only; T13 must wire later stages.

## Why V01 cannot pass yet

1. The V01 high-estimated-score path must issue the corresponding initial stage. Current T04 service supports only choice, so estimated profiles requiring cued/free/fluency cannot complete the formal path.
2. There is no end-to-end evidence tying `/goals` import, material job, DB reservation, connection, choice, feedback, and next task/EMPTY in one run.
3. Required human desktop/narrow-screen interaction evidence has not been supplied. No visual or usability PASS is claimed.

## Human steps to perform after prerequisites are ready

1. Use a fresh isolated DB (`FLOW_NEW_ALGORITHM_DB`); confirm it is not `flow.db`.
2. In `/goals`, import one low-frequency 0/0 word with confirmed meaning and ready ENCODE material. Open `/new-algorithm`, confirm the single connection, and verify both axes become 5 once.
3. Import one comparable nonzero estimated word with ready material at each required initial stage. Confirm no ENCODE is issued and the expected stage/axis appears.
4. Answer one choice correctly and one incorrectly; inspect score delta, feedback, next task/EMPTY, persisted event, and capacity reservation.
5. Repeat at desktop and narrow/mobile widths; record build revision, operating environment, observations, and screenshots.

**Current blocker:** T04/T13 formal task lifecycle must issue all V01 initial stages; then an authorized human tester must perform the B/H steps above. This report is a runbook, not evidence that the steps passed.
