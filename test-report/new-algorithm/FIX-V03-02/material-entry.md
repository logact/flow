# FIX-V03-02: R/P fluency material entry

## Delivered

- Added isolated `POST /api/new-algorithm/materials` for R/P fluency material generation. It reads only the new-algorithm database, requires a known word and confirmed meaning, applies the existing material generators/validators, and returns ready or validation failure.
- The provider call is bounded to 7.5 seconds; the shared job makes at most two attempts. The job rechecks `meaning_version` and meaning both before and after generation, so a changed gloss cannot publish a stale draft. Failed-job attempt counts now report actual attempts.
- Added R reading and P writing generation buttons to `/new-algorithm/goals`, with pending, success, and error feedback.
- Added an isolated demo database script for V03/V04. It requires a new explicit output path and refuses to overwrite an existing file. It does not read or modify `flow.db`.

## Automated evidence

- Focused: 5 Jest suites / 65 tests passed (`materials-api`, goals material UI, import, R fluency, P fluency).
- Full: 19 Jest suites / 208 tests passed.
- `node --check scripts/prepare-new-algorithm-v03-v04-demo.cjs` passed.
- Ran the demo script against a fresh `/tmp/flow-v03-v04-demo-20261108-1794108152.db`; it initialized the isolated database and printed the local date/timezone and run instructions.
- `git diff --check` passed.

## Manual run

```sh
node scripts/prepare-new-algorithm-v03-v04-demo.cjs /tmp/flow-v03-v04-demo.db
FLOW_NEW_ALGORITHM_DB=/tmp/flow-v03-v04-demo.db npm run dev -- -p 3103
```

Open `http://localhost:3103/new-algorithm/goals`, generate R/P fluency materials, then practice at `/new-algorithm`. Choose a fresh output path if the example database already exists; the script deliberately refuses overwrite.

## Limits and remaining acceptance

No live provider response or browser/human content review was performed in this automated run. Generated content quality, target-form leakage in real provider drafts, and desktop/narrow-screen interaction remain V03/V04 acceptance items. Those nodes remain BLOCKED pending that evidence; this implementation does not claim their PASS.
