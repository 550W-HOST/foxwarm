#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { BridgeError, FoxwarmClient, createTurnObserver } = require('./multicaBridgeHttp.js');

const BRIDGE_VERSION = '0.1.0';
const QWEN_CONTEXT_MAX_BYTES = 256 * 1024;

class BridgeUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeUsageError';
  }
}

function valueAfter(argv, index, option) {
  if (index + 1 >= argv.length) throw new BridgeUsageError(`${option} requires a value.`);
  return argv[index + 1];
}

function parseArgs(argv) {
  const result = { prompt: '', outputFormat: '', resume: '', model: '', help: false, version: false };
  const valueOptions = new Map([
    ['-p', 'prompt'], ['--prompt', 'prompt'], ['-o', 'outputFormat'], ['--output-format', 'outputFormat'],
    ['-r', 'resume'], ['--resume', 'resume'], ['-m', 'model'], ['--model', 'model'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') result.help = true;
    else if (arg === '-v' || arg === '--version') result.version = true;
    else if (arg === '-y' || arg === '--yolo') continue;
    else if (valueOptions.has(arg)) {
      result[valueOptions.get(arg)] = valueAfter(argv, index, arg);
      index += 1;
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const [option, ...rest] = arg.split('=');
      const key = valueOptions.get(option);
      if (!key) throw new BridgeUsageError(`Unsupported option: ${option}.`);
      result[key] = rest.join('=');
    } else {
      throw new BridgeUsageError(`Unsupported option or argument: ${arg}.`);
    }
  }
  if (!result.help && !result.version) {
    if (!result.prompt) throw new BridgeUsageError('A prompt is required with -p or --prompt.');
    if (result.outputFormat !== 'stream-json') throw new BridgeUsageError('--output-format stream-json is required.');
  }
  return result;
}

function printHelp(stream) {
  stream.write(`foxwarm-multica — Qwen JSONL compatibility bridge for Multica\n\nUsage:\n  foxwarm-multica -p <prompt> --output-format stream-json [--resume <session>] [--model <key>] [--yolo]\n\nConfiguration:\n  FOXWARM_MULTICA_BASE_URL   Foxwarm WebUI base URL\n  FOXWARM_MULTICA_TOKEN      Foxwarm instance bearer token\n  FOXWARM_MULTICA_AGENT      Dedicated Foxwarm agent name\n`);
}

function loadConfig(env) {
  const rawBaseUrl = env.FOXWARM_MULTICA_BASE_URL || '';
  const token = env.FOXWARM_MULTICA_TOKEN || '';
  const agent = env.FOXWARM_MULTICA_AGENT || '';
  if (!rawBaseUrl) throw new BridgeUsageError('FOXWARM_MULTICA_BASE_URL is required.');
  if (!token) throw new BridgeUsageError('FOXWARM_MULTICA_TOKEN is required.');
  if (!agent.trim()) throw new BridgeUsageError('FOXWARM_MULTICA_AGENT is required.');
  let parsed;
  try { parsed = new URL(rawBaseUrl); } catch { throw new BridgeUsageError('FOXWARM_MULTICA_BASE_URL must be a valid HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BridgeUsageError('FOXWARM_MULTICA_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment.');
  }
  const timeoutValue = Number(env.FOXWARM_MULTICA_REQUEST_TIMEOUT_MS || 30_000);
  if (!Number.isFinite(timeoutValue) || timeoutValue <= 0) throw new BridgeUsageError('FOXWARM_MULTICA_REQUEST_TIMEOUT_MS must be a positive number.');
  return {
    baseUrl: parsed.toString().replace(/\/+$/, ''),
    token,
    agent: agent.trim(),
    requestTimeoutMs: Math.round(timeoutValue),
  };
}

async function readQwenContext(cwd) {
  const filePath = path.join(cwd, 'QWEN.md');
  let stat;
  try { stat = await fs.lstat(filePath); } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw new BridgeError('The task-local QWEN.md could not be inspected.', 'context');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new BridgeError('The task-local QWEN.md must be a regular, non-symlink file.', 'context');
  if (stat.size > QWEN_CONTEXT_MAX_BYTES) throw new BridgeError(`The task-local QWEN.md exceeds ${QWEN_CONTEXT_MAX_BYTES} bytes.`, 'context');
  let content;
  try { content = await fs.readFile(filePath, 'utf8'); } catch { throw new BridgeError('The task-local QWEN.md could not be read.', 'context'); }
  if (content.includes('\0')) throw new BridgeError('The task-local QWEN.md is not valid text.', 'context');
  return content;
}

function composePrompt(prompt, qwenContext) {
  if (!qwenContext.trim()) return prompt;
  return `<foxwarm-system kind="multica-runtime-context" source="QWEN.md">\n${qwenContext}\n</foxwarm-system>\n\n${prompt}`;
}

function emitJson(stream, event) {
  stream.write(`${JSON.stringify(event)}\n`);
}

function messageSeq(message) {
  const value = message?.__meta?.seq;
  return Number.isFinite(value) ? value : null;
}

function historyBaseline(history) {
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  const seqs = messages.map(messageSeq).filter(value => value !== null);
  return { count: messages.length, maxSeq: seqs.length ? Math.max(...seqs) : null };
}

function messagesAfterBaseline(history, baseline) {
  const messages = Array.isArray(history?.messages) ? history.messages : [];
  if (baseline.maxSeq !== null) {
    const sequenced = messages.filter(message => messageSeq(message) !== null);
    if (sequenced.length) return sequenced.filter(message => messageSeq(message) > baseline.maxSeq);
  }
  return messages.slice(baseline.count);
}

function messageText(message) {
  return (Array.isArray(message?.parts) ? message.parts : [])
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .join('');
}

function summarizeTurn(history, baseline, fallbackModel) {
  const messages = messagesAfterBaseline(history, baseline);
  const modelMessages = messages.filter(message => message?.role === 'model');
  let output = '';
  let model = fallbackModel || '';
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  for (const message of modelMessages) {
    const text = messageText(message);
    if (text) output = text;
    if (message.__meta?.modelId) model = String(message.__meta.modelId);
    const current = message.__meta?.usage;
    if (current && typeof current === 'object') {
      usage.input_tokens += Number(current.inputTokens) || 0;
      usage.output_tokens += Number(current.outputTokens) || 0;
      usage.cache_read_input_tokens += Number(current.cachedTokens) || 0;
    }
  }
  return { output, model, usage, isError: /^Error:\s/i.test(output) };
}

function signalExitCode(signal) {
  return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1;
}

function createProcessTermination() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = () => resolve(signal);
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return {
    promise,
    dispose() { for (const [signal, handler] of handlers) process.removeListener(signal, handler); },
  };
}

async function startCancellationWatchdog({ baseUrl, token, sessionId }, options = {}) {
  const watchdogPath = options.watchdogPath || path.join(__dirname, 'multicaBridgeWatchdog.js');
  const child = (options.spawnImpl || spawn)(process.execPath, [watchdogPath], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
    env: {},
  });
  child.on('error', () => {});
  await new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', () => reject(new BridgeError('The cancellation watchdog could not be started.', 'watchdog')));
  });
  child.stdin.on('error', () => {});
  child.stdout.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      let output = '';
      const timeout = setTimeout(() => reject(new BridgeError('The cancellation watchdog did not become ready.', 'watchdog')), 5_000);
      const fail = () => {
        clearTimeout(timeout);
        reject(new BridgeError('The cancellation watchdog exited before becoming ready.', 'watchdog'));
      };
      child.once('exit', fail);
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        if (!output.includes('\n')) return;
        clearTimeout(timeout);
        child.removeListener('exit', fail);
        resolve();
      });
      child.stdin.write(`${JSON.stringify({ type: 'init', baseUrl, token, sessionId })}\n`, error => {
        if (!error) return;
        clearTimeout(timeout);
        child.removeListener('exit', fail);
        reject(new BridgeError('The cancellation watchdog could not be initialized.', 'watchdog'));
      });
    });
  } catch (error) {
    child.kill();
    throw error;
  }
  let disarmed = false;
  return {
    async disarm() {
      if (disarmed) return;
      disarmed = true;
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.stdin.end(`${JSON.stringify({ type: 'disarm' })}\n`);
      let timeout;
      await Promise.race([
        exited,
        new Promise(resolve => { timeout = setTimeout(resolve, 1_000); }),
      ]);
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

async function runBridge(argv, options = {}) {
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  let args;
  try { args = parseArgs(argv); } catch (error) {
    stderr.write(`Usage error: ${error.message}\n`);
    return 2;
  }
  if (args.help) { printHelp(stdout); return 0; }
  if (args.version) { stdout.write(`foxwarm-multica ${BRIDGE_VERSION}\n`); return 0; }

  let config;
  try { config = loadConfig(options.env || process.env); } catch (error) {
    stderr.write(`Usage error: ${error.message}\n`);
    return 2;
  }

  const cwd = options.cwd || process.cwd();
  const termination = options.terminationPromise ? { promise: options.terminationPromise, dispose() {} } : createProcessTermination();
  const client = new FoxwarmClient({ ...config, fetchImpl: options.fetchImpl });
  let sessionId = args.resume;
  let observer;
  let watchdog;
  let promptDispatchAttempted = false;
  let resultEmitted = false;

  const emitResult = event => {
    if (resultEmitted) return;
    resultEmitted = true;
    emitJson(stdout, event);
  };

  try {
    if (!sessionId) {
      const created = await client.createSession(config.agent);
      if (!created || typeof created.sessionId !== 'string' || !created.sessionId) throw new BridgeError('Foxwarm create-session response did not contain a session ID.', 'malformed');
      sessionId = created.sessionId;
    }

    let state = await client.getState(sessionId);
    if (!state?.session || typeof state.session !== 'object') throw new BridgeError('Foxwarm session-state response was malformed.', 'malformed');
    if (state.session.agent !== config.agent) throw new BridgeError('The Foxwarm session does not belong to the configured bridge agent.', 'session');

    await client.setCwd(sessionId, cwd);
    if (args.model) await client.setModel(sessionId, args.model);
    state = await client.getState(sessionId);
    if (!state?.session || typeof state.session !== 'object') throw new BridgeError('Foxwarm session-state response was malformed.', 'malformed');
    const runtimeState = state.session?.runtimeState || {};
    if (state.session.busy || runtimeState.busy || ['requesting-model', 'running-tool'].includes(runtimeState.state) || state.session.queueLength > 0) {
      throw new BridgeError('The Foxwarm session is already running or has queued work.', 'session_busy');
    }
    const baseline = historyBaseline(await client.getHistory(sessionId));
    const qwenContext = await readQwenContext(cwd);
    const prompt = composePrompt(args.prompt, qwenContext);

    observer = createTurnObserver({ client, sessionId, emit: event => emitJson(stdout, event) });
    await observer.ready;
    watchdog = await startCancellationWatchdog({ baseUrl: config.baseUrl, token: config.token, sessionId }, options);
    const effectiveModel = state.session.modelKey || args.model || '';
    emitJson(stdout, {
      type: 'system', subtype: 'init', session_id: sessionId, cwd, model: effectiveModel,
      permission_mode: 'bypassPermissions', qwen_code_version: `foxwarm-multica/${BRIDGE_VERSION}`,
    });

    observer.markSent();
    promptDispatchAttempted = true;
    await client.sendMessage(sessionId, prompt, `multica-${randomUUID()}`);
    const outcome = await Promise.race([
      observer.terminal.then(value => ({ type: 'terminal', value })),
      termination.promise.then(signal => ({ type: 'signal', signal })),
    ]);

    if (outcome.type === 'signal') {
      try { await client.stop(sessionId, AbortSignal.timeout(2_000)); } catch { /* best-effort stop */ }
      observer.close();
      emitResult({
        type: 'result', subtype: 'error_during_execution', session_id: sessionId, is_error: true,
        error: { type: 'cancelled', message: 'Foxwarm run cancelled.' },
      });
      return signalExitCode(outcome.signal);
    }

    if (outcome.value?.isError) {
      observer.close();
      emitResult({
        type: 'result', subtype: 'error_during_execution', session_id: sessionId, is_error: true,
        error: { type: 'execution_error', message: 'Foxwarm turn completed with an error.' },
      });
      return 1;
    }

    const summary = summarizeTurn(await client.getHistory(sessionId), baseline, observer.model() || effectiveModel);
    observer.close();
    if (summary.isError) {
      emitResult({
        type: 'result', subtype: 'error_during_execution', session_id: sessionId, model: summary.model,
        is_error: true, usage: summary.usage, error: { type: 'execution_error', message: 'Foxwarm turn completed with an error.' },
      });
      return 1;
    }
    emitResult({
      type: 'result', subtype: 'success', session_id: sessionId, model: summary.model,
      is_error: false, result: summary.output, usage: summary.usage,
    });
    return 0;
  } catch (error) {
    observer?.close();
    if (promptDispatchAttempted && sessionId) {
      try { await client.stop(sessionId, AbortSignal.timeout(2_000)); } catch { /* accepted turn may still be running; stop is best effort */ }
    }
    const message = error instanceof BridgeError ? error.message : 'Foxwarm bridge failed unexpectedly.';
    stderr.write(`Error: ${message}\n`);
    emitResult({
      type: 'result', subtype: 'error_during_execution', ...(sessionId ? { session_id: sessionId } : {}),
      is_error: true, error: { type: error?.code || 'bridge_error', message },
    });
    return 1;
  } finally {
    termination.dispose();
    await watchdog?.disarm();
  }
}

async function main(argv = process.argv.slice(2)) {
  const code = await runBridge(argv);
  process.exitCode = code;
}

if (require.main === module) main();

module.exports = {
  BRIDGE_VERSION,
  BridgeUsageError,
  composePrompt,
  historyBaseline,
  loadConfig,
  messagesAfterBaseline,
  parseArgs,
  readQwenContext,
  runBridge,
  startCancellationWatchdog,
  summarizeTurn,
};
