const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const buildDir = process.env.FLOW_LLM_BUILD_DIR;
if (!buildDir) throw new Error('Run with node test/run-llm-tests.cjs');

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, parent, isMain);
};
const { LlmError, requestLlmJson } = require(path.join(buildDir, 'lib/llm.js'));
Module._load = originalLoad;

const isGreeting = (value) => value != null && typeof value === 'object' &&
  !Array.isArray(value) && typeof value.greeting === 'string';
const configNames = ['LLM_API_KEY', 'LLM_BASE_URL', 'LLM_MODEL', 'LLM_NATIVE_LANGUAGE'];
const previous = Object.fromEntries(configNames.map((name) => [name, process.env[name]]));

function setConfig(baseUrl) {
  process.env.LLM_API_KEY = 'test-secret-never-echo';
  process.env.LLM_BASE_URL = baseUrl;
  process.env.LLM_MODEL = 'test-model';
  process.env.LLM_NATIVE_LANGUAGE = 'Japanese';
}

async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}/v1`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function providerResponse(content, status = 200) {
  return { status, body: JSON.stringify({ choices: [{ message: { content } }] }) };
}

test.after(() => {
  for (const name of configNames) {
    if (previous[name] === undefined) delete process.env[name];
    else process.env[name] = previous[name];
  }
});

test('sends server credentials/config and returns schema-validated JSON', async () => {
  await withServer((req, res) => {
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer test-secret-never-echo');
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      assert.equal(body.model, 'test-model');
      assert.equal(body.messages[0].content.includes('Japanese'), true);
      const output = providerResponse(JSON.stringify({ greeting: 'こんにちは' }));
      res.writeHead(output.status, { 'content-type': 'application/json' });
      res.end(output.body);
    });
  }, async (baseUrl) => {
    setConfig(baseUrl);
    assert.deepEqual(await requestLlmJson({ system: 'Only JSON.', user: 'Say hello.', validate: isGreeting }), {
      greeting: 'こんにちは',
    });
  });
});

test('missing configuration fails without disclosing any value', async () => {
  delete process.env.LLM_API_KEY;
  process.env.LLM_BASE_URL = 'https://localhost/v1';
  process.env.LLM_MODEL = 'test-model';
  process.env.LLM_NATIVE_LANGUAGE = 'Japanese';
  await assert.rejects(requestLlmJson({ system: '', user: '', validate: isGreeting }), (error) => {
    assert.ok(error instanceof LlmError);
    assert.equal(error.code, 'missing_config');
    assert.doesNotMatch(error.message, /test-secret|Bearer/);
    return true;
  });
});

test('provider HTTP errors are mapped without leaking provider body', async () => {
  await withServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'sensitive provider text' } }));
  }, async (baseUrl) => {
    setConfig(baseUrl);
    await assert.rejects(requestLlmJson({ system: '', user: '', validate: isGreeting }), (error) => {
      assert.equal(error.code, 'http_error');
      assert.doesNotMatch(error.message, /sensitive provider text|test-secret/);
      return true;
    });
  });
});

test('malformed provider envelope and malformed JSON are rejected', async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [] }));
  }, async (baseUrl) => {
    setConfig(baseUrl);
    await assert.rejects(requestLlmJson({ system: '', user: '', validate: isGreeting }), { code: 'malformed_response' });
  });

  await withServer((_req, res) => {
    const output = providerResponse('not json');
    res.writeHead(output.status, { 'content-type': 'application/json' });
    res.end(output.body);
  }, async (baseUrl) => {
    setConfig(baseUrl);
    await assert.rejects(requestLlmJson({ system: '', user: '', validate: isGreeting }), { code: 'invalid_json' });
  });
});

test('schema mismatch and timeout fail closed', async () => {
  await withServer((_req, res) => {
    const output = providerResponse(JSON.stringify({ unexpected: true }));
    res.writeHead(output.status, { 'content-type': 'application/json' });
    res.end(output.body);
  }, async (baseUrl) => {
    setConfig(baseUrl);
    await assert.rejects(requestLlmJson({ system: '', user: '', validate: isGreeting }), { code: 'schema_mismatch' });
  });

  await withServer((_req, res) => {
    setTimeout(() => {
      if (!res.destroyed) res.end(JSON.stringify({ choices: [] }));
    }, 100);
  }, async (baseUrl) => {
    setConfig(baseUrl);
    await assert.rejects(requestLlmJson({ system: '', user: '', validate: isGreeting, timeoutMs: 10 }), { code: 'timeout' });
  });
});
