#!/usr/bin/env node
'use strict';
require('./test/test-process-env.cjs').initializeTestEnvironment();

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CliUsageError, parseArgs, runModelCli } = require('./model.js');
const { run } = require('./foxwarm.js');

function capture() {
  let value = '';
  return { stream: new Writable({ write(chunk, _encoding, callback) { value += chunk; callback(); } }), value: () => value };
}

function invoke(args, env, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, 'foxwarm.js'), ...args], {
      env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(input);
  });
}

function completed(response, text) {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const event of [
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', role: 'assistant', content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_text.done', output_index: 0, content_index: 0, text },
    { type: 'response.completed', response: { id: 'resp_cli', output: [], usage: { input_tokens: 3, output_tokens: 2 } } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end('data: [DONE]\n\n');
}

test('public parser retains aliases, positive timeout and usage errors', () => {
  assert.equal(parseArgs([]).timeoutMs, undefined);
  assert.deepEqual(parseArgs(['-m', 'x', '-p', 'hello', '-s', 'system', '-t', '.125', '-j', '--list-models']),
    { model: 'x', prompt: 'hello', system: 'system', timeoutMs: 125, json: true, list: true, help: false });
  for (const args of [['--wat'], ['--model'], ['--timeout', 'NaN'], ['--timeout', '-1']])
    assert.throws(() => parseArgs(args), error => error instanceof CliUsageError);
});

test('frontend forwards parsed options and stdin without a second parser or backend library', async () => {
  const stdin = new PassThrough();
  stdin.end('raw stdin');
  let received;
  const code = await runModelCli(['-m', 'chosen', '-s', 'system', '-t', '7', '-j'], {
    stdin, backend: async (operation, input, options) => { received = { operation, input, stdin: options.stdin }; return 1; },
  });
  assert.equal(code, 1);
  assert.equal(received.operation, 'model');
  assert.equal(received.input.model, 'chosen');
  assert.equal(received.input.system, 'system');
  assert.equal(received.input.timeoutMs, 7000);
  assert.equal(received.stdin, stdin);
});

test('help/version/no-argument and usage paths do not load Core or configuration', async () => {
  const stdout = capture(), stderr = capture();
  assert.equal(await run([], { stdout: stdout.stream }), 0);
  assert.equal(await run(['--version'], { stdout: stdout.stream }), 0);
  assert.equal(await run(['model', '--help'], { stdout: stdout.stream, backend: () => { throw Error('backend loaded'); } }), 0);
  assert.equal(await run(['unknown'], { stderr: stderr.stream }), 2);
  assert.equal(await run(['archive', 'invalid'], { stderr: stderr.stream, backend: () => { throw Error('backend loaded'); } }), 2);
});

test('real public model caller uses only Core, captured settings, one-shot requests and clean exits', async t => {
  const assembly = path.join(__dirname, '../runtime/current/Foxwarm.dll');
  if (!fs.existsSync(assembly)) { t.skip('requires npm run build'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-cli-'));
  const temporary = path.join(root, 'temporary directory '.repeat(6));
  fs.mkdirSync(temporary);
  const data = path.join(root, 'selected data');
  fs.mkdirSync(path.join(data, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data_dir'), ' selected data \n');
  fs.writeFileSync(path.join(data, 'state/config.yaml'), 'llm:\n  maxOutput: 17\n');
  fs.writeFileSync(path.join(root, 'wrong.yaml'), 'llm:\n  maxOutput: 99\n');
  const preload = path.join(root, 'no-ts-backend.cjs');
  fs.writeFileSync(preload, `const Module=require('node:module'); const load=Module._load; Module._load=function(id,...args){ if(typeof id==='string' && id.includes(${JSON.stringify(path.resolve(__dirname, '../lib') + path.sep)})) throw Error('TypeScript backend loaded'); return load.call(this,id,...args); };`);
  const env = {
    FOXWARM_CONFIG_PATH: path.join(root, 'app.yaml'), CONFIG_PATH: path.join(root, 'wrong.yaml'),
    FOXWARM_DATA_DIR: data,
    TMPDIR: temporary,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preload}`,
  };
  const requests = [];
  const timeoutAttempts = [];
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8'); request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
      requests.push({ url: request.url, body });
      if (request.url === '/v1/messages') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ content: [{ type: 'text', text: 'anthropic-cli-ok' }], usage: { input_tokens: 2, output_tokens: 1 } }));
        return;
      }
      if (!Array.isArray(body.input)) { response.writeHead(400); response.end('{"error":"unexpected fixture request"}'); return; }
      const prompt = JSON.stringify(body.input);
      if (prompt.includes('timeout-probe')) {
        const attempt = { started: performance.now(), disconnected: false };
        timeoutAttempts.push(attempt);
        if (timeoutAttempts.length === 1) {
          response.once('close', () => { attempt.disconnected = true; });
          return; // Never complete: the caller must abort this attempt before retrying.
        }
        attempt.previousDisconnected = timeoutAttempts[0].disconnected;
      }
      if (prompt.includes('fatal-probe')) { response.writeHead(400); response.end('{"error":"synthetic invalid request"}'); return; }
      completed(response, prompt.includes('empty-probe') ? '' : prompt.includes('unicode-response') ? '回覆😀' : 'route-ok');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(data, 'state/models.yaml'), `default: sticky\nproviders:\n  sticky: test/model\n  test:\n    providerType: openai\n    baseUrl: http://127.0.0.1:${server.address().port}\n    models: [model]\n  anthro:\n    providerType: anthropic\n    baseUrl: http://127.0.0.1:${server.address().port}\n    extraFields: {stream: false}\n    models: [wire]\n`);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });

  const listed = await invoke(['model', '--list-models'], env);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /Default: sticky/);
  assert.match(listed.stdout, /provider: session-hash/);
  assert.equal(requests.length, 0);
  const json = await invoke(['model', '-p', 'hello', '-s', 'only supplied system', '-j'], env);
  assert.equal(json.code, 0, json.stderr);
  assert.equal(json.stderr, '');
  const result = JSON.parse(json.stdout);
  assert.equal(result.text, 'route-ok');
  assert.equal(result.modelId, 'test/model');
  assert.equal(result.usage.outputTokens, 2);
  assert.equal(requests[0].url, '/responses');
  assert.equal(requests[0].body.instructions, 'only supplied system');
  assert.equal(requests[0].body.max_output_tokens, 17);
  assert.deepEqual(requests[0].body.tools || [], []);
  assert.equal(JSON.stringify(requests[0].body.input).includes('hello'), true);
  const piped = await invoke(['model', '-m', 'test/model'], env, 'from stdin 漢字');
  assert.deepEqual(piped, { code: 0, stdout: 'route-ok\n', stderr: '' });
  assert.match(JSON.stringify(requests.at(-1).body.input), /from stdin 漢字/);
  assert.equal(requests.at(-1).body.instructions, '');
  assert.deepEqual(await invoke(['model', '-p', 'unicode-response'], env), { code: 0, stdout: '回覆😀\n', stderr: '' });
  const anthropic = await invoke(['model', '-m', 'anthro/wire', '-p', 'Anthropic prompt', '-s', 'standalone', '-j', '-t', '.5'], env);
  assert.equal(anthropic.code, 0, anthropic.stderr);
  assert.equal(JSON.parse(anthropic.stdout).text, 'anthropic-cli-ok');
  assert.equal(JSON.parse(anthropic.stdout).modelId, 'anthro/wire');
  assert.equal(requests.at(-1).url, '/v1/messages');
  assert.equal(requests.at(-1).body.stream, false);
  assert.match(JSON.stringify(requests.at(-1).body.system), /standalone/);
  assert.equal((await invoke(['model', '-m', 'missing', '-p', 'x'], env)).code, 2);
  assert.equal((await invoke(['model'], env)).code, 2);
  const beforeTimeout = requests.length;
  // The bound tests a deliberately held request, not sub-100ms cold transport/JIT speed.
  const timed = await invoke(['model', '-p', 'timeout-probe', '-t', '1'], env);
  assert.equal(timed.code, 0, timed.stderr);
  assert.equal(timed.stdout, 'route-ok\n');
  assert.equal(requests.length, beforeTimeout + 2); // One cancelled attempt, one successful retry.
  assert.equal(timeoutAttempts.length, 2);
  assert.equal(timeoutAttempts[0].disconnected, true);
  assert.equal(timeoutAttempts[1].previousDisconnected, true, 'Retry follows cancellation of the held attempt.');
  t.diagnostic(`Timeout probe: retry reached the peer after ${Math.round(timeoutAttempts[1].started - timeoutAttempts[0].started)} ms.`);
  const empty = await invoke(['model', '-p', 'empty-probe'], env);
  assert.equal(empty.code, 1);
  assert.equal(empty.stdout, '');
  const fatal = await invoke(['model', '-p', 'fatal-probe'], env);
  assert.equal(fatal.code, 1);
  assert.equal(fatal.stdout, '');
  assert.equal(fs.existsSync(path.join(data, 'agents')), false);
  assert.equal(fs.existsSync(path.join(data, 'state/token')), false);
  assert.equal(fs.existsSync(path.join(data, 'state/sessions')), false);
  assert.equal(fs.existsSync(path.join(data, 'state/db')), false);
  // A real journal export is parseable, tool-free purpose:cli and has no Session identity.
  const output = path.join(root, 'exported');
  const exported = await invoke(['archive', 'export-jsonl', '-o', output], env);
  assert.equal(exported.code, 0, exported.stderr);
  const summary = JSON.parse(exported.stdout);
  assert.equal(summary.sessions.records, 0);
  const records = fs.readFileSync(path.join(output, 'llm-request-journal.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(summary.llm.records, records.length);
  const manifests = records.filter(row => row.kind === 'request');
  assert.equal(manifests.length, 7);
  for (const row of manifests) { assert.equal(row.purpose, 'cli'); assert.equal(row.iteration, 0); assert.equal(row.sessionId, undefined); }
});

test('terminating the public frontend stops the one-shot provider process after prompt EOF', { timeout: 20000 }, async t => {
  const assembly = path.join(__dirname, '../runtime/current/Foxwarm.dll');
  if (!fs.existsSync(assembly)) { t.skip('requires npm run build'); return; }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-cli-lifetime-'));
  const temporary = path.join(root, 'temporary directory '.repeat(6));
  fs.mkdirSync(temporary);
  fs.mkdirSync(path.join(root, 'state'));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(root, 'state/models.yaml'), `default: peer\nproviders:\n  peer:\n    providerType: openai\n    baseUrl: http://127.0.0.1:${server.address().port}\n    models: [wire]\n`);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  for (const signal of ['SIGKILL', 'SIGTERM']) {
    let requests = 0;
    let disconnected;
    const first = new Promise(resolve => server.on('request', (request, response) => {
      request.resume();
      requests++;
      disconnected = new Promise(resolveClose => response.once('close', resolveClose));
      resolve(); // Leave this real provider attempt pending until frontend termination.
    }));
    const child = spawn(process.execPath, [path.join(__dirname, 'foxwarm.js'), 'model', '-p', signal, '-t', '1'], {
      env: { ...process.env, FOXWARM_DATA_DIR: root,
        TMPDIR: temporary },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const closed = new Promise(resolve => child.once('close', resolve));
    child.stdin.end(); // Normal prompt EOF must not stop the request.
    try {
      await first;
      child.kill(signal);
      await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(Error('orphan provider connection')), 2000))]);
      await closed; // Child inherited stdout/stderr must close too.
      await new Promise(resolve => setTimeout(resolve, 3300)); // Beyond the first retry boundary.
      assert.equal(requests, 1);
    } finally {
      child.kill('SIGKILL');
      server.removeAllListeners('request');
    }
  }
});
