# FIX-V04-01: server-authoritative P writing time

## Defect

The formal P submission trusted client `elapsed_seconds`, which directly determines WPM and therefore the P score.

## Change

- Added explicit `start_writing` and `interrupt_writing` task actions. The server stores P start time on the frozen task instance; an explicit restart records a new server timestamp.
- P renderer waits for server start confirmation, preserves short drafts, sends only final text, and reports visibility interruption. A response that races with tab hiding is interrupted before writing begins.
- P submission derives elapsed seconds from the saved server start and server submission time. The client elapsed field is ignored. The server duration is frozen with the first answer and reused by grading retry.
- R event replay behavior remains unchanged.

## Reproducible evidence

Command: `npx jest --runInBand`

Result: 17 suites, 201 tests passed. Focused P/service/UI contract run: 4 suites, 33 tests passed.

P score/state trace starts at P=80, target=100, with R=80 and an independent future R review:

| Scenario | Server time | P transition | R state |
|---|---:|---:|---|
| 24 WPM | 75 s | 80 → 40 | score 80 and due date unchanged |
| 25 WPM | 72 s | 80 → 60 | unchanged |
| 42.5 WPM | 42.353 s | 80 → 80 (approximately) | unchanged |
| 60 WPM | 30 s | 80 → 100 | unchanged; only P starts level 1 review |
| Target failed | 60 WPM | 80 → 40 | unchanged |
| Overall failed | 60 WPM | 80 → 80 | unchanged |

Additional integrity traces:

- Forged client `elapsed_seconds=0.001` is ignored; server measures the actual 60 seconds.
- A 5-second writing session, 24-second interruption, then 72-second restarted session scores as 25 WPM; only the restarted 72 seconds count.
- Evaluator retry after another 90 seconds reuses the original 30-second duration and frozen text. Exactly one completed event is written.

`npx tsc --noEmit` still reports only the two unrelated existing errors in `app/score-history/page.tsx:57` and `lib/manual-test-fixtures.ts:183`. `git diff --check` passes.

## Limits

This deterministic verification does not establish naturalness of real Chinese scenarios or human writing usability. V04 remains blocked until a person reviews real generated scenarios and uses the formal writing page.
