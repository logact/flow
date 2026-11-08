# FIX-V03-01: server-authoritative R timing

## Defect

Before the fix, the formal fluency submission path trusted client-supplied `timing_valid`, `reading_seconds`, and `wpm`. Those values reached the R score function without replaying the submitted event trace. A caller could claim a very high reading speed regardless of actual recorded read intervals.

## Change

The task service now validates event shape and bounds against task issue/submission timestamps, requires a final `answer_submit`, replays the initial read and any reread using the R timing protocol, and derives reading seconds/WPM from the frozen passage's word count. Only these server-derived values enter grading and the persisted authoritative `timing_json`. P timing and scoring are unchanged.

## Reproducible evidence

Command: `npx jest --runInBand`

Result: 15 suites, 187 tests passed.

- Valid trace: 100-word passage; read from `NOW+1` to `NOW+20,001` (20 seconds); answers finish at `NOW+60,000`. Server stores 20 seconds/300 WPM. The client simultaneously sends `timing_valid=false`, `reading_seconds=0.01`, `wpm=1`. Evaluator passes both checks; R score is `60→100`, and the attempt timing snapshot contains the server replay result.
- Interrupted trace: read begins at `NOW+1`, interruption at `NOW+10,001`, then submit. The client claims valid/1 second/6000 WPM. The server records invalid `interrupted`, returns grading retry, leaves R score at 60 and leaves the learning tick unchanged.
- Full Jest includes existing task lifecycle, replay, settlement, and R timing protocol tests.
- `npx tsc --noEmit` has only existing errors in `app/score-history/page.tsx:57` and `lib/manual-test-fixtures.ts:183`.
- `git diff --check` passes.

## Remaining V03 evidence

This closes the discovered timing trust gap and revalidates T13's R timing submission behavior. It does not establish real material quality or human UI acceptance. Those remain V03 checks; do not infer them from these deterministic fixtures.
