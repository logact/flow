const fs = require('node:fs');
const path = require('node:path');

const file = process.env.LOG_FILE ?? path.join(process.cwd(), 'logs', 'app.log');
const requestedId = process.argv[2];

if (!fs.existsSync(file)) {
  console.error(`Log file not found: ${file}`);
  process.exit(1);
}

const entries = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
  try {
    const event = JSON.parse(line);
    return event.event === 'task_generation.attempt' ? [event] : [];
  } catch {
    return [];
  }
});

const matches = requestedId ? entries.filter(event => event.generationId === requestedId) : entries;
function promptsFor(event) {
  let request;
  try { request = event.request?.body ? JSON.parse(event.request.body) : undefined; } catch {}
  return {
    systemPrompt: event.systemPrompt ?? event.request?.systemPrompt ?? request?.messages?.find(message => message.role === 'system')?.content,
    userPrompt: event.userPrompt ?? event.request?.userPrompt ?? request?.messages?.find(message => message.role === 'user')?.content,
  };
}
const event = [...matches].reverse().find(candidate => promptsFor(candidate).userPrompt) ?? matches.at(-1);
if (!event) {
  console.error(requestedId ? `No task generation log found for ${requestedId}` : `No task generation events found in ${file}`);
  process.exit(1);
}

const { systemPrompt, userPrompt } = promptsFor(event);
let readableUserPrompt = userPrompt;
try { readableUserPrompt = JSON.parse(userPrompt); } catch {}

console.log(JSON.stringify({
  generationId: event.generationId,
  attempt: event.attempt,
  provider: event.provider,
  model: event.model,
  systemPrompt: systemPrompt ?? '(not recorded)',
  userPrompt: readableUserPrompt ?? '(not recorded)',
}, null, 2));
