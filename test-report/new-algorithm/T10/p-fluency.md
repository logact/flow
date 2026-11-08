# T10 P fluency material and evaluator

- Added isolated `lib/new-algorithm-p-fluency.ts` helpers; legacy routes/database/provider remain untouched.
- P material producer uses T03 persistent D5-bounded generation (at most 2 attempts, provider timeout 8 seconds). It rejects learner-visible target forms/forbidden inflections from private grading requirements and missing private answer-key data before material can become ready. `public_payload` stores only the Chinese scene/instructions; a DB test verifies target forms and answer keys stay in private columns.
- Meaningful-word counter excludes common function words and tokens repeated more than three times.
- Injected evaluator judges target use and overall recall separately and returns separate evidence. Exceptions become `service_error`; `uncertain` and `service_error` map to T02 no-change settlement.
- Timing rule: evaluator runs before the short-response rule; at <=5 seconds, only a confirmed missing target form becomes invalid. Evaluator uncertainty/error is preserved. A short response with target use continues to meaningful-word validation.
- Answer keys accept only non-empty strings or non-empty objects/arrays; scalar numbers/booleans are rejected. Successful judgments require non-empty target and overall evidence; malformed evidence becomes uncertain.
- Missing private requirements return validation errors without throwing; null/primitive evaluator outputs become uncertain; non-finite or non-positive elapsed time is invalid before scoring.
- Evaluator verdicts must each be boolean or `uncertain`; missing or malformed values become uncertain.
- Focused Jest: 29/29. Full Jest: 14 suites / 150 tests. `git diff --check`: PASS.
- No production AI provider or HTTP/retry persistence lifecycle is wired. Submitted answer persistence and retry lifecycle remain T13 scope.
