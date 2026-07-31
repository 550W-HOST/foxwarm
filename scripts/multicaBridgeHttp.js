'use strict';

class BridgeError extends Error {
  constructor(message, code = 'bridge_error') {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // The stream can fail before its consumer reaches the matching await. Keep
  // that narrow race from becoming an unhandled rejection; callers still see
  // the original rejected promise.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

function endpointPath(sessionId, suffix) {
  return `/api/sessions/${encodeURIComponent(sessionId)}${suffix}`;
}

class FoxwarmClient {
  constructor({ baseUrl, token, fetchImpl = globalThis.fetch, requestTimeoutMs = 30_000 }) {
    if (typeof fetchImpl !== 'function') throw new BridgeError('This CLI requires a Node.js runtime with fetch support.', 'config');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async json(method, path, body, options = {}) {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new BridgeError(`Foxwarm ${method} request failed before a response was received.`, 'network');
    }
    if (!response.ok) {
      throw new BridgeError(`Foxwarm ${method} request failed with HTTP ${response.status}.`, response.status === 401 || response.status === 403 ? 'auth' : 'http');
    }
    let text;
    try {
      text = await response.text();
      return text ? JSON.parse(text) : {};
    } catch {
      throw new BridgeError(`Foxwarm ${method} response was not valid JSON.`, 'malformed');
    }
  }

  async openStream(sessionId, signal) {
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${endpointPath(sessionId, '/stream')}`, {
        method: 'GET',
        signal,
        headers: { authorization: `Bearer ${this.token}`, accept: 'text/event-stream' },
      });
    } catch {
      throw new BridgeError('Foxwarm SSE connection failed before a response was received.', 'network');
    }
    if (!response.ok) throw new BridgeError(`Foxwarm SSE connection failed with HTTP ${response.status}.`, response.status === 401 || response.status === 403 ? 'auth' : 'http');
    if (!response.body) throw new BridgeError('Foxwarm SSE response had no body.', 'malformed');
    return response;
  }

  createSession(agentId, signal) {
    return this.json('POST', '/api/sessions', { agentId }, { signal });
  }

  listAgents(signal) {
    return this.json('GET', '/api/agents', undefined, { signal });
  }

  createAgent(agentId, signal) {
    return this.json('POST', '/api/agents', { agentId }, { signal });
  }

  getState(sessionId, signal) {
    return this.json('GET', endpointPath(sessionId, '/state'), undefined, { signal });
  }

  getHistory(sessionId, signal) {
    return this.json('GET', endpointPath(sessionId, '/history'), undefined, { signal });
  }

  setCwd(sessionId, cwd, signal) {
    return this.json('POST', endpointPath(sessionId, '/cwd'), { cwd }, { signal });
  }

  setModel(sessionId, model, signal) {
    return this.json('POST', endpointPath(sessionId, '/model'), { model }, { signal });
  }

  sendMessage(sessionId, text, clientMessageId, signal) {
    return this.json('POST', endpointPath(sessionId, '/message'), { text, clientMessageId }, { signal });
  }

  stop(sessionId, signal) {
    return this.json('POST', endpointPath(sessionId, '/message'), { text: '/stop' }, { signal });
  }
}

async function consumeSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  const dispatch = () => {
    if (dataLines.length === 0) return;
    const raw = dataLines.join('\n');
    dataLines = [];
    let payload;
    try { payload = JSON.parse(raw); } catch { throw new BridgeError('Foxwarm SSE event was not valid JSON.', 'malformed'); }
    onEvent(payload);
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') dispatch();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (done) {
      if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).trimStart());
      dispatch();
      return;
    }
  }
}

function textSuffix(previous, current) {
  if (!current || current === previous) return '';
  return current.startsWith(previous) ? current.slice(previous.length) : '';
}

function stringifyToolOutput(response) {
  if (response === undefined) return '';
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    if (response.output !== undefined) return stringifyToolOutput(response.output);
    if (response.content !== undefined) return stringifyToolOutput(response.content);
    if (response.error !== undefined) return stringifyToolOutput(response.error);
  }
  try { return JSON.stringify(response); } catch { return String(response); }
}

function createTurnObserver({ client, sessionId, emit, signal }) {
  const ready = deferred();
  const terminal = deferred();
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let sent = false;
  let sawActivity = false;
  let sawPostSendMessage = false;
  let sawTerminalError = false;
  let currentModel = '';
  let currentStreamId = '';
  let streamedText = '';
  let streamedThinking = '';
  const emittedTools = new Set();
  const emittedToolResults = new Set();
  const emittedCommittedMessages = new Set();

  const emitAssistantBlocks = blocks => {
    if (!blocks.length) return;
    emit({
      type: 'assistant',
      session_id: sessionId,
      message: { role: 'assistant', model: currentModel, content: blocks },
    });
  };

  const handleStreamUpdate = event => {
    const stream = event.event || {};
    if (stream.type === 'model-stream-reset') {
      currentStreamId = stream.streamId || '';
      streamedText = '';
      streamedThinking = '';
      return;
    }
    if (stream.type !== 'model-stream-update') return;
    if (stream.streamId && stream.streamId !== currentStreamId) {
      currentStreamId = stream.streamId;
      streamedText = '';
      streamedThinking = '';
    }
    const blocks = [];
    const reasoning = typeof stream.reasoning === 'string' ? stream.reasoning : '';
    const text = typeof stream.text === 'string' ? stream.text : '';
    const reasoningDelta = textSuffix(streamedThinking, reasoning);
    const textDelta = textSuffix(streamedText, text);
    if (reasoningDelta) blocks.push({ type: 'thinking', thinking: reasoningDelta });
    if (textDelta) blocks.push({ type: 'text', text: textDelta });
    streamedThinking = reasoning || streamedThinking;
    streamedText = text || streamedText;
    for (const tool of Array.isArray(stream.toolCalls) ? stream.toolCalls : []) {
      const id = typeof tool.id === 'string' && tool.id ? tool.id : `tool-${tool.index ?? emittedTools.size}`;
      if (emittedTools.has(id)) continue;
      emittedTools.add(id);
      blocks.push({ type: 'tool_use', id, name: tool.name || 'tool', input: {} });
    }
    emitAssistantBlocks(blocks);
  };

  const handleCommittedMessage = message => {
    if (!sent || !message || typeof message !== 'object') return;
    const key = String(message.__meta?.seq ?? message.__meta?.timestamp ?? '');
    if (key && emittedCommittedMessages.has(key)) return;
    if (key) emittedCommittedMessages.add(key);
    if (message.role !== 'user') sawPostSendMessage = true;
    if (message.__meta?.modelId) currentModel = String(message.__meta.modelId);
    const parts = Array.isArray(message.parts) ? message.parts : [];
    if (message.role === 'assistant') {
      const text = parts.map(part => typeof part?.text === 'string' ? part.text : '').join('');
      if (/^(?:Error:|⚠️\s*LLM request failed:)/i.test(text)) sawTerminalError = true;
    } else if (message.role === 'model') {
      const blocks = [];
      const fullThinking = parts.map(part => typeof part.thinking === 'string' ? part.thinking : '').join('');
      const fullText = parts.map(part => typeof part.text === 'string' ? part.text : '').join('');
      const thinkingDelta = textSuffix(streamedThinking, fullThinking);
      const textDelta = textSuffix(streamedText, fullText);
      if (thinkingDelta) blocks.push({ type: 'thinking', thinking: thinkingDelta });
      if (textDelta) blocks.push({ type: 'text', text: textDelta });
      streamedThinking = fullThinking || streamedThinking;
      streamedText = fullText || streamedText;
      for (const part of parts) {
        const call = part?.functionCall;
        if (!call) continue;
        const id = call.id || `tool-${emittedTools.size}`;
        if (emittedTools.has(id)) continue;
        emittedTools.add(id);
        blocks.push({ type: 'tool_use', id, name: call.name || 'tool', input: call.args || {} });
      }
      emitAssistantBlocks(blocks);
    } else if (message.role === 'tool') {
      const content = [];
      for (const part of parts) {
        const result = part?.functionResponse;
        if (!result) continue;
        const id = result.tool_use_id || `tool-result-${emittedToolResults.size}`;
        if (emittedToolResults.has(id)) continue;
        emittedToolResults.add(id);
        content.push({ type: 'tool_result', tool_use_id: id, content: stringifyToolOutput(result.response) });
      }
      if (content.length) emit({ type: 'user', session_id: sessionId, message: { role: 'user', content } });
    }
  };

  const onEvent = payload => {
    if (payload?.type === 'connected') { ready.resolve(); return; }
    if (payload?.type === 'session-event') { if (sent) handleStreamUpdate(payload); return; }
    if (payload?.type === 'message') { handleCommittedMessage(payload.message); return; }
    if (payload?.type === 'session-deleted') { terminal.reject(new BridgeError('Foxwarm session was deleted during the run.', 'session')); return; }
    if (payload?.type !== 'session-state') return;
    ready.resolve();
    const session = payload.session || {};
    if (session.modelKey) currentModel = String(session.modelKey);
    if (!sent) return;
    const runtime = session.runtimeState || {};
    const state = runtime.state || (session.busy ? 'requesting-model' : 'idle');
    const queueLength = Number(session.queueLength) || 0;
    if (runtime.busy || session.busy || state === 'requesting-model' || state === 'running-tool') sawActivity = true;
    if ((state === 'idle' || state === 'waiting') && queueLength === 0 && !runtime.busy && !session.busy && (sawActivity || sawPostSendMessage)) {
      terminal.resolve({ state, isError: sawTerminalError });
    }
  };

  const run = (async () => {
    try {
      const response = await client.openStream(sessionId, combinedSignal);
      await consumeSse(response, onEvent);
      if (!combinedSignal.aborted) throw new BridgeError('Foxwarm SSE stream ended before the run completed.', 'stream');
    } catch (error) {
      if (!combinedSignal.aborted) {
        ready.reject(error);
        terminal.reject(error);
      }
    }
  })();

  return {
    ready: ready.promise,
    terminal: terminal.promise,
    markSent() { sent = true; },
    model() { return currentModel; },
    close() { controller.abort(); },
    run,
  };
}

module.exports = {
  BridgeError,
  FoxwarmClient,
  createTurnObserver,
  endpointPath,
};
