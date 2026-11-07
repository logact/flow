# T07 retrieval renderer

Added a separate renderer for choice, cued and free retrieval payloads. Choice submits `selected_index`; cued/free submit the entered answer. It delegates judgment to the existing API and contains no client scoring or answer key access. P free renderer displays only server-provided prompt; fixtures must not include target forms.

The isolated task page can render the three stages when supplied. Current T04 API still only issues choice, so cued/free end-to-end issuance and HTTP lifecycle remain for T13. The existing T05 source contract was updated to check that the page delegates choice rendering to this component.

- Focused Jest: `npx jest --runInBand test/new-algorithm-task-view.jest.test.cjs test/new-algorithm-retrieval-renderer.jest.test.cjs` — 2 suites / 4 tests pass.
- Full Jest: `npx jest --runInBand` — 12 suites / 116 tests pass.
- `git diff --check`: PASS.
- No browser or human visual evidence is claimed; V02 remains required.
