# T05 isolated connection/choice UI

- Added `/new-algorithm` as an isolated page; it does not replace the legacy homepage or task UI.
- The client calls only `/api/new-algorithm/task`. It renders ENCODE confirmation and choice options, submits the response once per interaction, and displays the returned axis/score delta/tick plus replay and error states. Client code does not determine correctness or calculate scores.
- Choice buttons use native keyboard-operable buttons, `aria-pressed`, and a labelled group. Result announcements use `aria-live`; errors use `role=alert`.
- `npx jest --runInBand test/new-algorithm-task-view.jest.test.cjs` — PASS, 1 suite / 2 tests. `git diff --check` — PASS.
- `npx tsc --noEmit` still reports only the known unrelated errors at `app/score-history/page.tsx:57` and `lib/manual-test-fixtures.ts:183`.

Manual desktop/mobile and visual acceptance remains in V01/V08. The technical test checks the UI/API contract, not browser interaction.
