#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { spawn } = require('node:child_process');

const { BridgeUsageError, parseArgs, runBridge } = require('./multicaBridge.js');

function captureStream() {
  let value = '';
  const stream = new Writable({ write(chunk, _encoding, callback) { value += chunk.toString(); callback(); } });
  return { stream, value: () => value };
}

function jsonLines(value) {
  return value.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function readBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

async function createFakeFoxwarm(options = {}) {
  const state = {
    agent: options.agent || 'multica-agent',
    created: 0,
    streamOpened: false,
    streamBeforeMessage: false,
    cwd: '',
    model: 'default/model',
    prompt: '',
    stops: 0,
    authHeaders: [],
    messages: options.initialMessages ? [...options.initialMessages] : [],
    nextSeq: (options.initialMessages?.length || 0) + 1,
    rootQueueLength: options.initialQueueLength || 0,
    realCompletionSent: false,
    sse: null,
  };
  const sessionId = options.sessionId || 'multica-agent/run-1';

  const sessionPayload = (runtimeState = { state: 'idle', busy: false, queueLength: 0 }) => ({
    id: sessionId,
    agent: state.agent,
    busy: runtimeState.busy,
    queueLength: state.rootQueueLength,
    runtimeState,
    cwd: state.cwd || null,
    modelKey: state.model,
  });
  const sendEvent = event => state.sse?.write(`data: ${JSON.stringify(event)}\n\n`);
  const append = message => {
    message.__meta = { ...(message.__meta || {}), seq: state.nextSeq++ };
    state.messages.push(message);
    sendEvent({ type: 'message', message });
  };
  const complete = () => {
    state.rootQueueLength = 0;
    state.realCompletionSent = true;
    const finalText = options.finalText || 'Final answer';
    sendEvent({ type: 'session-state', session: sessionPayload({ state: 'requesting-model', busy: true, queueLength: 0 }) });
    if (options.transientError) {
      sendEvent({
        type: 'message',
        message: { role: 'assistant', parts: [{ text: `⚠️ LLM request failed: ${options.transientError}` }], __meta: { temporary: true } },
      });
      sendEvent({ type: 'session-state', session: sessionPayload() });
      return;
    }
    sendEvent({ type: 'session-event', event: {
      type: 'model-stream-update', streamId: 'stream-tools', reasoning: 'thinking', text: 'Checking',
      toolCalls: [{ index: 0, id: 'call-1', name: 'read_file' }],
    } });
    append({
      role: 'model', parts: [{ functionCall: { id: 'call-1', name: 'read_file', args: { path: 'README.md' } } }],
      __meta: { modelId: state.model, usage: { inputTokens: 2, outputTokens: 1, cachedTokens: 1 } },
    });
    append({ role: 'tool', parts: [{ functionResponse: { tool_use_id: 'call-1', name: 'read_file', response: { output: 'ok' } } }] });
    sendEvent({ type: 'session-event', event: {
      type: 'model-stream-update', streamId: 'stream-final', reasoning: '', text: finalText, toolCalls: [],
    } });
    append({
      role: 'model', parts: [{ text: finalText }],
      __meta: { modelId: state.model, usage: { inputTokens: 3, outputTokens: 4, cachedTokens: 1 } },
    });
    sendEvent({ type: 'session-state', session: sessionPayload() });
  };

  const server = http.createServer(async (request, response) => {
    state.authHeaders.push(request.headers.authorization || '');
    const url = new URL(request.url, 'http://localhost');
    if (options.malformedCreate && request.method === 'POST' && url.pathname === '/api/sessions') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{bad');
      return;
    }
    if (request.headers.authorization !== 'Bearer foxwarm-secret') {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: `denied foxwarm-secret ${options.secretPrompt || ''}` }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const body = await readBody(request);
      state.created += 1;
      state.agent = body.agentId;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, sessionId }));
      return;
    }
    const match = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(state|history|cwd|model|message|stream)$/);
    if (!match) { response.writeHead(404); response.end(); return; }
    const action = match[2];
    if (action === 'state') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ session: sessionPayload() }));
    } else if (action === 'history') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ session: sessionPayload(), messages: state.messages }));
    } else if (action === 'cwd') {
      state.cwd = (await readBody(request)).cwd;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, cwd: state.cwd }));
    } else if (action === 'model') {
      state.model = (await readBody(request)).model;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, modelKey: state.model }));
    } else if (action === 'stream') {
      state.streamOpened = true;
      state.sse = response;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      sendEvent({ type: 'connected' });
      sendEvent({ type: 'session-state', session: sessionPayload() });
      request.on('close', () => { if (state.sse === response) state.sse = null; });
    } else if (action === 'message') {
      const body = await readBody(request);
      if (body.text === '/stop') {
        state.stops += 1;
        options.onStop?.();
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ success: true }));
        return;
      }
      state.prompt = body.text;
      state.streamBeforeMessage = state.streamOpened;
      if (options.ambiguousMessage) {
        sendEvent({ type: 'session-state', session: sessionPayload({ state: 'requesting-model', busy: true, queueLength: 0 }) });
        request.socket.destroy();
        return;
      }
      if (options.failMessage) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: `reflected ${body.text} foxwarm-secret` }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true }));
      options.onMessage?.();
      if (options.enqueueRace) {
        state.rootQueueLength = 1;
        append({ role: 'user', parts: [{ text: body.text }] });
        sendEvent({ type: 'session-state', session: sessionPayload() });
        setTimeout(complete, 50);
      } else if (!options.hold) setImmediate(complete);
      else sendEvent({ type: 'session-state', session: sessionPayload({ state: 'requesting-model', busy: true, queueLength: 0 }) });
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    state,
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      state.sse?.destroy();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function bridgeEnv(url, extra = {}) {
  return {
    FOXWARM_MULTICA_BASE_URL: url,
    FOXWARM_MULTICA_TOKEN: 'foxwarm-secret',
    FOXWARM_MULTICA_AGENT: 'multica-agent',
    MULTICA_TOKEN: 'must-not-propagate',
    ...extra,
  };
}

test('argument parser accepts Multica Qwen invocation and rejects protocol drift', () => {
  assert.deepEqual(parseArgs(['-p', 'task', '--output-format', 'stream-json', '--model=m', '--resume', 's', '--yolo']), {
    prompt: 'task', outputFormat: 'stream-json', resume: 's', model: 'm', help: false, version: false,
  });
  assert.throws(() => parseArgs(['-p', 'task', '--output-format', 'json']), error => error instanceof BridgeUsageError && /stream-json/.test(error.message));
  assert.throws(() => parseArgs(['-p', 'task', '--output-format', 'stream-json', '--mcp-config', 'x']), /Unsupported option/);
});

test('new run maps agent, cwd, model, QWEN context, streaming events, and one final result', async t => {
  const fake = await createFakeFoxwarm();
  t.after(fake.close);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-multica-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'QWEN.md'), 'Repository instruction.');
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runBridge(
    ['-p', 'secret task prompt', '--output-format', 'stream-json', '--model', 'selected/model', '--yolo'],
    { env: bridgeEnv(fake.url), cwd, stdout: stdout.stream, stderr: stderr.stream, terminationPromise: new Promise(() => {}) },
  );
  assert.equal(code, 0, stderr.value());
  assert.equal(fake.state.created, 1);
  assert.equal(fake.state.stops, 0);
  assert.equal(fake.state.streamBeforeMessage, true);
  assert.equal(fake.state.cwd, cwd);
  assert.equal(fake.state.model, 'selected/model');
  assert.match(fake.state.prompt, /Repository instruction\./);
  assert.match(fake.state.prompt, /secret task prompt/);
  assert.doesNotMatch(fake.state.prompt, /must-not-propagate/);
  assert.ok(fake.state.authHeaders.every(value => value === 'Bearer foxwarm-secret'));

  const events = jsonLines(stdout.value());
  assert.equal(events[0].type, 'system');
  assert.equal(events[0].session_id, 'multica-agent/run-1');
  assert.equal(events.filter(event => event.type === 'result').length, 1);
  const result = events.find(event => event.type === 'result');
  assert.equal(result.subtype, 'success');
  assert.equal(result.result, 'Final answer');
  assert.deepEqual(result.usage, { input_tokens: 5, output_tokens: 5, cache_read_input_tokens: 2 });
  const assistantText = events.filter(event => event.type === 'assistant')
    .flatMap(event => event.message.content).filter(block => block.type === 'text').map(block => block.text).join('');
  assert.equal(assistantText, 'CheckingFinal answer');
  assert.equal(events.flatMap(event => event.message?.content || []).filter(block => block.type === 'tool_use').length, 1);
  const toolResults = events.flatMap(event => event.message?.content || []).filter(block => block.type === 'tool_result');
  assert.equal(toolResults.length, 1);
  assert.equal(toolResults[0].content, 'ok');
  assert.equal(stderr.value(), '');
});

test('resume uses the existing dedicated-agent session without creating another session', async t => {
  const fake = await createFakeFoxwarm({
    sessionId: 'multica-agent/resume-1',
    initialMessages: [{ role: 'model', parts: [{ text: 'old answer' }], __meta: { seq: 1 } }],
  });
  t.after(fake.close);
  const stdout = captureStream();
  const code = await runBridge(
    ['--prompt', 'continue', '--output-format=stream-json', '--resume', 'multica-agent/resume-1'],
    { env: bridgeEnv(fake.url), cwd: os.tmpdir(), stdout: stdout.stream, stderr: captureStream().stream, terminationPromise: new Promise(() => {}) },
  );
  assert.equal(code, 0);
  assert.equal(fake.state.created, 0);
  const result = jsonLines(stdout.value()).find(event => event.type === 'result');
  assert.equal(result.session_id, 'multica-agent/resume-1');
  assert.equal(result.result, 'Final answer');
});

test('queued user commit plus idle state cannot finish before the real Foxwarm turn', async t => {
  const fake = await createFakeFoxwarm({ enqueueRace: true });
  t.after(fake.close);
  const stdout = captureStream();
  const code = await runBridge(
    ['-p', 'queued prompt', '--output-format', 'stream-json'],
    { env: bridgeEnv(fake.url), cwd: os.tmpdir(), stdout: stdout.stream, stderr: captureStream().stream, terminationPromise: new Promise(() => {}) },
  );
  assert.equal(code, 0);
  assert.equal(fake.state.realCompletionSent, true);
  assert.equal(jsonLines(stdout.value()).find(event => event.type === 'result').result, 'Final answer');
});

test('resume preflight rejects root-level queued work before sending a prompt', async t => {
  const fake = await createFakeFoxwarm({ sessionId: 'multica-agent/busy', initialQueueLength: 1 });
  t.after(fake.close);
  const stdout = captureStream();
  const code = await runBridge(
    ['-p', 'must not queue', '--output-format', 'stream-json', '--resume', 'multica-agent/busy'],
    { env: bridgeEnv(fake.url), cwd: os.tmpdir(), stdout: stdout.stream, stderr: captureStream().stream, terminationPromise: new Promise(() => {}) },
  );
  assert.equal(code, 1);
  assert.equal(fake.state.prompt, '');
  assert.equal(jsonLines(stdout.value())[0].error.type, 'session_busy');
});

test('HTTP errors and malformed responses are nonzero and redact token and prompt diagnostics', async t => {
  const prompt = 'redaction-prompt-value';
  const failing = await createFakeFoxwarm({ failMessage: true, secretPrompt: prompt });
  t.after(failing.close);
  const stdout = captureStream();
  const stderr = captureStream();
  assert.equal(await runBridge(
    ['-p', prompt, '--output-format', 'stream-json'],
    { env: bridgeEnv(failing.url), stdout: stdout.stream, stderr: stderr.stream, cwd: os.tmpdir(), terminationPromise: new Promise(() => {}) },
  ), 1);
  const diagnostics = `${stdout.value()}${stderr.value()}`;
  assert.doesNotMatch(diagnostics, /redaction-prompt-value/);
  assert.doesNotMatch(diagnostics, /foxwarm-secret/);
  assert.equal(jsonLines(stdout.value()).filter(event => event.type === 'result' && event.is_error).length, 1);

  const unauthorizedOut = captureStream();
  const unauthorizedErr = captureStream();
  assert.equal(await runBridge(
    ['-p', prompt, '--output-format', 'stream-json'],
    {
      env: bridgeEnv(failing.url, { FOXWARM_MULTICA_TOKEN: 'wrong-token' }),
      stdout: unauthorizedOut.stream,
      stderr: unauthorizedErr.stream,
      cwd: os.tmpdir(),
      terminationPromise: new Promise(() => {}),
    },
  ), 1);
  assert.match(unauthorizedErr.value(), /HTTP 401/);
  assert.doesNotMatch(`${unauthorizedOut.value()}${unauthorizedErr.value()}`, /redaction-prompt-value|foxwarm-secret|wrong-token/);

  const malformed = await createFakeFoxwarm({ malformedCreate: true });
  t.after(malformed.close);
  const malformedOut = captureStream();
  assert.equal(await runBridge(
    ['-p', 'x', '--output-format', 'stream-json'],
    { env: bridgeEnv(malformed.url), stdout: malformedOut.stream, stderr: captureStream().stream, cwd: os.tmpdir(), terminationPromise: new Promise(() => {}) },
  ), 1);
  assert.equal(jsonLines(malformedOut.value())[0].error.type, 'malformed');

  const turnFailure = await createFakeFoxwarm({ finalText: 'Error: synthetic provider failure' });
  t.after(turnFailure.close);
  const turnFailureOut = captureStream();
  assert.equal(await runBridge(
    ['-p', 'x', '--output-format', 'stream-json'],
    { env: bridgeEnv(turnFailure.url), stdout: turnFailureOut.stream, stderr: captureStream().stream, cwd: os.tmpdir(), terminationPromise: new Promise(() => {}) },
  ), 1);
  const turnFailureResult = jsonLines(turnFailureOut.value()).find(event => event.type === 'result');
  assert.equal(turnFailureResult.is_error, true);
  assert.equal(turnFailureResult.error.type, 'execution_error');

  const transientFailure = await createFakeFoxwarm({ transientError: 'synthetic transport failure' });
  t.after(transientFailure.close);
  const transientOut = captureStream();
  assert.equal(await runBridge(
    ['-p', 'x', '--output-format', 'stream-json'],
    { env: bridgeEnv(transientFailure.url), stdout: transientOut.stream, stderr: captureStream().stream, cwd: os.tmpdir(), terminationPromise: new Promise(() => {}) },
  ), 1);
  assert.equal(jsonLines(transientOut.value()).find(event => event.type === 'result').error.type, 'execution_error');
});

test('termination forwards /stop and emits one cancelled result', async t => {
  let releaseMessage;
  const messageReceived = new Promise(resolve => { releaseMessage = resolve; });
  const fake = await createFakeFoxwarm({ hold: true, onMessage: releaseMessage });
  t.after(fake.close);
  let terminate;
  const terminationPromise = new Promise(resolve => { terminate = resolve; });
  const stdout = captureStream();
  const run = runBridge(
    ['-p', 'cancel me', '--output-format', 'stream-json'],
    { env: bridgeEnv(fake.url), cwd: os.tmpdir(), stdout: stdout.stream, stderr: captureStream().stream, terminationPromise },
  );
  await messageReceived;
  terminate('SIGTERM');
  assert.equal(await run, 143);
  assert.equal(fake.state.stops, 1);
  const results = jsonLines(stdout.value()).filter(event => event.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].error.type, 'cancelled');
});

test('ambiguous accepted message failure stops Foxwarm and emits one error result', async t => {
  const fake = await createFakeFoxwarm({ ambiguousMessage: true });
  t.after(fake.close);
  const stdout = captureStream();
  const stderr = captureStream();
  const code = await runBridge(
    ['-p', 'ambiguous dispatch', '--output-format', 'stream-json'],
    { env: bridgeEnv(fake.url), cwd: os.tmpdir(), stdout: stdout.stream, stderr: stderr.stream, terminationPromise: new Promise(() => {}) },
  );
  assert.equal(code, 1);
  assert.equal(fake.state.prompt, 'ambiguous dispatch');
  assert.equal(fake.state.stops, 1);
  const results = jsonLines(stdout.value()).filter(event => event.type === 'result');
  assert.equal(results.length, 1);
  assert.equal(results[0].is_error, true);
  assert.doesNotMatch(`${stdout.value()}${stderr.value()}`, /foxwarm-secret/);
});

test('hard-killed bridge leaves an orphan watchdog that forwards /stop without protocol duplication', async t => {
  let releaseMessage;
  let releaseStop;
  const messageReceived = new Promise(resolve => { releaseMessage = resolve; });
  const stopReceived = new Promise(resolve => { releaseStop = resolve; });
  const fake = await createFakeFoxwarm({ hold: true, onMessage: releaseMessage, onStop: releaseStop });
  t.after(fake.close);
  const child = spawn(process.execPath, [path.join(__dirname, 'multicaBridge.js'), '-p', 'hard cancel', '--output-format', 'stream-json'], {
    cwd: os.tmpdir(),
    env: bridgeEnv(fake.url),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  await messageReceived;
  child.kill('SIGKILL');
  const exit = await new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  assert.deepEqual(exit, { code: null, signal: 'SIGKILL' }, stderr);
  await Promise.race([
    stopReceived,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('watchdog did not forward /stop')), 5_000);
      timer.unref();
    }),
  ]);
  assert.equal(fake.state.stops, 1);
  const events = jsonLines(stdout);
  assert.equal(events.filter(event => event.type === 'system').length, 1);
  assert.equal(events.filter(event => event.type === 'result').length, 0);
});
