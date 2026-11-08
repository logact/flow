# T13 lifecycle and continuous flow

## Scope delivered

- Formal task issuance dispatches scheduler-selected choice, cued, free, and axis-specific fluency work through `/api/new-algorithm/task`.
- Cued/free and fluency submissions freeze the first response before evaluation. R timing events are replayed on the server; persisted reading duration/WPM are derived from the frozen 100-word passage and event trace. Client `timing_valid`, `reading_seconds`, and `wpm` are ignored. Retries reuse the frozen answer/timing, and conflicting answers return `INSTANCE_CONFLICT`.
- `GET ?instanceId=...` restores the original public task. The page stores a pending answer before POST and restores/replays that exact instance before requesting another task, so a lost response does not hide the saved result.
- Skip and exit are separate terminal actions with deduplicated events. Repeated skip is idempotent; racing submit/skip/exit allows only one terminal transition. Issued tasks release their material claim on skip/exit. A grading-retry attempt can be closed only by explicit exit, which marks the attempt exited.
- Fluency renderers retain their established interruption behavior: no interrupted submission is sent, and a restarted attempt starts a fresh timer. EMPTY results have a manual retry path; there is no timer-based polling.

## Verification

- `npx jest --runInBand`: 15 suites, 187 tests passed.
- Service traces cover repeated skip, exit/submit conflict, release and reissue after skip, frozen text grading after evaluator failure, answer conflict rejection, replay without an extra tick, empty-answer non-freezing, material recovery, axis-specific fluency dispatch, R fluency timing/scoring, P fluency separate judgments/scoring, and explicit exit from grading retry.
- R timing regression: a valid 20-second read of 100 words calculates 300 WPM and `60→100` even when the client sends `timing_valid=false`, `reading_seconds=0.01`, and `wpm=1`. An interrupted trace remains invalid despite client claims of 1 second/6000 WPM; score stays 60 and tick remains unchanged.
- `git diff --check`: passed.
- `npx tsc --noEmit`: still reports only the unrelated errors at `app/score-history/page.tsx:57` and `lib/manual-test-fixtures.ts:183`; no T13/FIX-V03-01 file is reported.

## Limits of this evidence

Evaluator behavior in Jest is injected to make state transitions deterministic. This does not claim a live configured LLM provider check or browser/human interaction acceptance. Those observations remain in V03/V06. No `flow.db` was opened or modified.
