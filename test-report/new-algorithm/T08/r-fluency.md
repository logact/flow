# T08 R fluency material and evaluator

- Added isolated `lib/new-algorithm-r-fluency.ts`; no legacy material module or database file is used.
- Validates exactly 100 whitespace-delimited words, at least five occurrences across the declared target-form list, exactly two public comprehension questions, and two frozen private answer/evidence entries.
- Uses the existing D5-bounded T03 persistent material job (two attempts, 8-second timeout); invalid drafts cannot become ready. Material uses the confirmed gloss and does not require a book source.
- R evaluator is injected. It receives both responses, target meaning, and frozen keys; preserves invalid/uncertain/service_error and only returns a valid result for T02's existing R fluency score rules. No production provider is configured or claimed.
- Tests: `npx jest --runInBand test/new-algorithm-r-fluency.jest.test.cjs` PASS (11/11); full Jest PASS (10 suites / 109 tests); `git diff --check` PASS.
- `npx tsc --noEmit` still reports the two existing unrelated errors in `app/score-history/page.tsx:57` and `lib/manual-test-fixtures.ts:183`; it also identified a local evaluator union type issue during implementation, which was corrected. Re-run typecheck before acceptance.
- Not an end-to-end R fluency lifecycle: HTTP dispatch, timing validation, UI and recovery remain downstream T09/T13 work. Provider fixtures do not establish real AI content quality.
