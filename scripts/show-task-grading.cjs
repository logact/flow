const fs = require('node:fs');
const path = require('node:path');

const file = process.env.LOG_FILE ?? path.join(process.cwd(), 'logs', 'app.log');
const requestedId = process.argv[2];
if (!fs.existsSync(file)) { console.error(`Log file not found: ${file}`); process.exit(1); }
const matches = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
  try { const entry = JSON.parse(line); return entry.event === 'task_grading.attempt' && (!requestedId || entry.attemptId === requestedId) ? [entry] : []; }
  catch { return []; }
});
if (!matches.length) { console.error(requestedId ? `No P7 grading logs found for ${requestedId}` : `No P7 grading logs found in ${file}`); process.exit(1); }
process.stdout.write(`${matches.map(entry => JSON.stringify(entry, null, 2)).join('\n--- retry ---\n')}\n`);
