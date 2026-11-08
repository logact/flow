# T09 R fluency timing

Added a staged R reading component that starts on a ready screen without revealing the passage. It shows passage only while reading/reviewing and questions only while answering. `RReadingClock` records initial read and reread segments, excludes answer intervals, invalidates interruption, rejects zero-second reads, and emits an event protocol. WPM uses 100-word passage and accumulated visible reading seconds. Replay validates review transitions before starting a reread.

- Focused fake-clock and renderer contract Jest: 6/6.
- Full Jest: `npx jest --runInBand` — 13 suites / 127 tests. `git diff --check`: PASS.
- Timing event server replay/concurrency and lifecycle integration remain T13; browser/human interaction evidence remains V03.
