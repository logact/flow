# FIX-V02-01: isolated target controls

## Delivered

- `/api/new-algorithm/goals` now returns `target_r` and `target_p` and accepts `POST { action: "target", wordId, targetR, targetP }`.
- The action calls `updateNewAlgorithmTargets` inside its existing SQLite transaction. It keeps the other axis unchanged, rejects invalid ranges and live affected tasks, and returns the axes requeued today or blocked by capacity.
- `/new-algorithm/goals` is a new target page for the isolated schema. The task page links to it.
- `scripts/prepare-new-algorithm-v02-demo.cjs` creates an isolated database with six due tasks (R/P × choice/cued/free) plus a word for one-axis target requeue. It refuses to overwrite an existing path. It was run successfully against `/tmp/flow-v02-demo-local.db` for Asia/Shanghai on 2026-11-08; `flow.db` was not used.

## Automated verification

- API tests cover one-axis update/preservation, invalid range rollback, active-instance conflict, and capacity-blocked requeue without overbooking.
- `npx jest --runInBand`: 15 suites, 186 tests passed.
- `git diff --check`: passed.
- `npx tsc --noEmit`: only the existing errors in `app/score-history/page.tsx:57` and `lib/manual-test-fixtures.ts:183` remain.

## V02 manual run

The isolated database already exists at `/tmp/flow-v02-demo-local.db`. Start the app with:

```sh
FLOW_NEW_ALGORITHM_DB=/tmp/flow-v02-demo-local.db npm run dev -- -p 3102
```

Open `http://localhost:3102/new-algorithm`. The fixture starts from post-connection scores so V02 can focus on retrieval behavior; the six tasks are ordered R choice, R cued, R free, P choice, P cued, P free. Answer them in that order:

| Task | Suggested action | Expected score change |
|---|---|---|
| R choice, 5 | choose “transport something” | 5 → 20 |
| R cued, 20 | enter a correct synonym such as “transport” | 20 → 40 |
| R free, 40 | explain “carry” correctly | 40 → 60 |
| P choice, 5 | choose an incorrect option | 5 → 5 |
| P cued, 20 | enter an incorrect form | 20 → 5 |
| P free, 40 | enter `carried` | 40 → 60 |

R cued/free use the configured semantic evaluator. If it is unavailable or uncertain, the response remains frozen for retry; it must not lower the score. For target adjustment, open `/new-algorithm/goals`, set only the `target-adjustment` word’s R goal from 80 to 90, leave P at 80, and save. Expected: R returns to today’s learning queue, P remains unchanged, and the page reports the result. The reviewer should record any mismatch, confusing copy, or visual/interaction problem; no human PASS is claimed by this technical report.

## Current execution environment

An existing Next development server already owns the repository `.next` lock on port 3000. Starting a second server from this same checkout on port 3102 was rejected by Next. No process was stopped. To use the prepared isolated database manually, stop the existing dev server from its owning terminal, then run the command above. Alternatively, regenerate a fresh fixture at a different non-existing path with the script and start the isolated server there.
