# T06 retrieval material/evaluator contracts

- Added `lib/new-algorithm-retrieval-evaluator.ts`, isolated from legacy `lib/material.ts` and T04 API/UI.
- Defines and validates the six R/P × choice/cued/free material shapes. Validation is contract-only and does not fabricate generated learning content. Public payloads that contain answer-key-shaped fields are rejected; P cued/free payloads are also rejected if they expose the target form or an allowlisted inflection.
- Choice grading compares the submitted `selected_index` only to the frozen private `correct_index`.
- R cued/free grading requires an injected semantic evaluator. It preserves `pass`, `fail`, `uncertain`, and `service_error`; evaluator absence, malformed judgment, or thrown error cannot become a learner failure by default.
- P cued/free matching only lowercases and trims outer whitespace. Accepted inflections must appear in the frozen `allowed_inflections` list. Punctuation and internal whitespace are not normalized away.
- `generateNewAlgorithmRetrievalMaterial` wraps T03's persistent generation job and applies the T06 validator before a draft can become ready. T03's D5 bound (two attempts, 8-second provider timeout) remains authoritative. Tests cover first-attempt success, malformed-first/valid-second retry, and failed status after two invalid drafts.
- `toRetrievalSettlementDecision` is the service boundary to T02: pass/fail become retrieval judgments; uncertain/service_error become retry decisions with reasons. Non-final evaluations cannot silently become failed answers. T13 owns async persistence/retry integration.
- `gradeAndSettleFrozenRetrievalAttempt` loads the frozen task, attempt, response and ready material from the existing schema. Final pass/fail persists the frozen judgment and invokes T02 settlement in one SQLite transaction; uncertain/service_error persist `grading_retry` on the attempt and instance plus a deduplicated retry event, without touching score/tick/capacity. Exact calls after completion replay T02's saved event result. The helper checks the D5 two-attempt bound before calling the evaluator again; HTTP/concurrency policy remains with T13.
- Command: `npx jest --runInBand test/new-algorithm-retrieval-evaluator.jest.test.cjs`
- Result: PASS, 1 suite / 26 tests. Covers six material contracts, distinct normalized choice options, correct/wrong choice, R semantic pass/uncertain/service failure/unavailable, P exact matching and allowlisted forms, malformed/key-leaking/target-leaking material rejection, bounded producer success/retry/failure, all four T02 boundary mappings, DB retry→settle/replay, service_error no-state-change, and no third evaluator call after two retries.
- Integrated `npx jest --runInBand`: PASS, 9 suites / 98 tests.
- `git diff --check`: PASS.

## Remaining scope

The producer and semantic evaluator accept injected providers, but no production AI provider is configured or called here. HTTP dispatch/UI integration and concurrency handling await later lifecycle/service work in T07/T13; these tests do not claim full retrieval flow completion.
