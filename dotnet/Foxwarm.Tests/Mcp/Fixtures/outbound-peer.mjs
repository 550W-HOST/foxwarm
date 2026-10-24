import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const [mode, root] = process.argv.slice(2);
await mkdir(root, { recursive: true });
const events = [];
const holds = new Map();
const connections = new Map();
let delayedListUsed = false;
const record = event => {
  events.push(event);
  return appendFile(join(root, 'events.ndjson'), JSON.stringify(event) + '\n');
};
await record({ kind: 'process' });
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nS0AAAAASUVORK5CYII=';
const text = value => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) });
function result(kind) {
  const structured = { b: [2, null], a: 1 };
  switch (kind) {
    case 'object': return { content: [text({ output: 'business', nested: [1] })] };
    case 'array': return { content: [text([1, { n: null }, false])] };
    case 'text': return { content: [text('hello')] };
    case 'primitive-text': return { content: [text('false')] };
    case 'structured': return { content: [], structuredContent: structured };
    case 'duplicate': return { content: [text({ a: 1, b: [2, null] })], structuredContent: structured };
    case 'mixed': return { content: [text(structured), text('explanation')], structuredContent: structured };
    case 'annotated': return { content: [{ ...text(structured), annotations: { audience: ['assistant'] } }], structuredContent: structured };
    case 'opaque': return { content: [text('opaque')], customTag: { retained: true } };
    case 'meta': return { content: [text(structured)], structuredContent: structured, _meta: { retained: true } };
    case 'error': return { content: [text(structured)], structuredContent: structured, isError: true };
    case 'audio': return { content: [{ type: 'audio', data: 'AA==', mimeType: 'audio/wav' }, text('audio remains data')] };
    case 'resource': return { content: [{ type: 'resource', resource: { uri: 'data:application/octet-stream;base64,AA==', mimeType: 'application/octet-stream', blob: 'AA==' } }] };
    case 'image': return { content: [text('pixels and explanation'), { type: 'image', data: png, mimeType: 'image/png', annotations: { audience: ['assistant'] }, _meta: { imageNote: 'retained' } }], _meta: { note: 'mixed' } };
    default: return { content: [text({ kind })] };
  }
}
function peer(id, authorization = "", transport, notifications = false, delayedList = false) {
  const invalidResults = new Map();
  if (transport) {
    const send = transport.send.bind(transport);
    transport.send = (message, options) => {
      if (invalidResults.has(message.id) && message.result) {
        const raw = invalidResults.get(message.id);
        // Keep the valid placeholder for SDK response classification/routing. Inject
        // the raw result only when its correlated response is serialized to the wire.
        // Invalid _meta would otherwise route as an unsolicited message and leave
        // the original POST open, so it would not model a completed malformed reply.
        message = { ...message, result: { ...message.result, toJSON: () => raw } };
        invalidResults.delete(message.id);
      }
      return send(message, options);
    };
  }
  const server = new Server({ name: 'outbound-qualification-peer', version: '1' }, { capabilities: { tools: {}, ...(notifications ? { experimental: { 'foxwarm/session-notifications': { version: 1 } } } : {}) } });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await record({ kind: 'list', id });
    if (delayedList && !delayedListUsed) {
      delayedListUsed = true;
      await new Promise(resolve => setTimeout(resolve, 61000));
    }
    return { tools: ['probe', 'result', 'hold', 'fail'].map(name => ({ name, description: 'Synthetic outbound qualification', inputSchema: { type: 'object', additionalProperties: true } })).concat(authorization ? [{ name: 'unsafe_descriptor', description: authorization, inputSchema: { type: 'object' } }] : []) };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const { name, arguments: args = {} } = request.params;
    await record({ kind: 'call', id, name, tag: args.tag });
    if (name === 'fail') {
      await record({ kind: 'effect', id, tag: args.tag });
      throw new Error('Synthetic completed effect followed by an error');
    }
    if (name === 'result') {
      if (Object.hasOwn(args, 'rawResult')) {
        await record({ kind: 'effect', id, tag: args.tag });
        // Inject this wire result after the counted effect and SDK response routing.
        // The official server validates the typed placeholder before transport.send.
        invalidResults.set(extra.requestId, args.rawResult);
        return { content: [text('typed placeholder')] };
      }
      if (args.kind === 'credential') { await record({ kind: 'effect', id, tag: args.tag }); return { content: [text(authorization)] }; }
      if (args.kind === 'large') { await record({ kind: 'effect', id, tag: args.tag }); return { content: [text('é'.repeat(args.length))] }; }
      if (args.kind === 'environment') return { content: [text(Object.fromEntries(args.names.map(name => [name, process.env[name] ?? null])))] };
      if (args.kind === 'ordinary') return { content: [text({ command: 'printf ordinary', cwd: '/ordinary/path', env: args.value })] };
      return result(args.kind);
    }
    if (name === 'hold') {
      await record({ kind: 'effect', id, tag: args.tag });
      await new Promise((resolve, reject) => {
        holds.set(args.tag, resolve);
        extra.signal.addEventListener('abort', () => {
          void record({ kind: 'cancelled', id, tag: args.tag });
          holds.delete(args.tag);
          reject(new Error('Synthetic request cancelled after effect'));
        }, { once: true });
      });
    }
    return { content: [text({ id, tag: args.tag ?? null })] };
  });
  return server;
}
if (mode === 'stdio') {
  await peer('stdio').connect(new StdioServerTransport());
} else {
  const http = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/events') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(events));
        return;
      }
      if (url.pathname === '/notify') {
        let data = ''; for await (const chunk of req) data += chunk;
        const { id, method = 'notifications/foxwarm/session_message', params } = JSON.parse(data);
        await connections.get(id).server.notification({ method, params });
        res.end('attempted'); return;
      }
      if (url.pathname === '/release') {
        holds.get(url.searchParams.get('tag'))?.();
        holds.delete(url.searchParams.get('tag'));
        res.end('released');
        return;
      }
      if (url.pathname === '/sse' || url.pathname === '/auto') {
        if (req.method !== 'GET') {
          await record({ kind: 'failed-http-probe' });
          res.writeHead(405).end('Use SSE');
          return;
        }
        const transport = new SSEServerTransport('/messages', res);
        const id = transport.sessionId;
        const server = peer(id);
        connections.set(id, { transport, server });
        await record({ kind: 'sse-open', id });
        res.on('close', () => { void record({ kind: 'closed', id }); connections.delete(id); });
        await server.connect(transport);
        return;
      }
      if (url.pathname === '/messages') {
        const bound = connections.get(url.searchParams.get('sessionId'));
        if (!bound) { res.writeHead(404).end(); return; }
        await bound.transport.handlePostMessage(req, res);
        return;
      }
      let body;
      if (req.method === 'POST') {
        let data = '';
        for await (const chunk of req) data += chunk;
        body = JSON.parse(data);
        await record({ kind: 'request', method: body.method, id: req.headers['mcp-session-id'] ?? null });
      }
      if (url.pathname === '/init-fail') {
        if (body?.method === 'server/discover') {
          res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Initialize required' } }));
          return;
        }
        if (req.method === 'POST' && body?.method === 'initialize') {
          await record({ kind: 'blocked-initialize' });
          await new Promise(resolve => holds.set('initialize', resolve));
        }
        res.writeHead(503).end('Synthetic initialization unavailable');
        return;
      }
      const id = req.headers['mcp-session-id'];
      let bound = connections.get(id);
      if (!bound && req.method === 'POST' && body?.method === 'initialize') {
        const session = randomUUID();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => session });
        const server = peer(session, url.searchParams.get("descriptorSecret") ?? req.headers.authorization ?? "", transport, url.searchParams.has('notifications'), url.searchParams.has('delayedList'));
        bound = { transport, server };
        connections.set(session, bound);
        await server.connect(transport);
        const close = transport.onclose;
        transport.onclose = () => { close?.(); connections.delete(session); void record({ kind: 'closed', id: session }); };
        await record({ kind: 'initialize', id: session, protocol: body.params.protocolVersion });
      }
      if (!bound) {
        res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body?.id ?? null, error: { code: -32600, message: 'Initialize required' } }));
        return;
      }
      if (req.method === 'DELETE') {
        await record({ kind: 'delete', id });
        if (url.searchParams.has('holdDelete')) {
          const released = new Promise(resolve => holds.set('delete-' + id, resolve));
          await record({ kind: 'delete-pending', id });
          await released;
        }
      }
      if (req.method === 'GET') {
        // Observe SDK response headers after its standalone stream mapping is installed.
        const writeHead = res.writeHead.bind(res);
        res.writeHead = (...args) => {
          const result = writeHead(...args);
          if (res.statusCode === 200) {
            void record({ kind: 'get-ready', id });
          }
          return result;
        };
      }
      await bound.transport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end('Synthetic peer error');
    }
  });
  http.listen(0, '127.0.0.1', () => {
    process.stdout.write(JSON.stringify({ url: `http://127.0.0.1:${http.address().port}` }) + '\n');
  });
}
