import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ACCESS_RUNTIME, APP_CONFIG_PATH, getActiveModelsConfigPath, resolveModelConfig } from './config';
import { configInstaller } from './configInstaller';
import { HttpServer, setHttpServer } from './httpServer';
import { WebUIChannel } from './channels/webuiChannel';
import { McpInboundHttpService, type ExternalExecutionContext } from './mcpInboundHttp';
import * as sessionManager from './sessionManager';
import { initializeSessionRuntime, shutdownSessionRuntime } from './sessionRuntime';
import { set_config, call_tool } from './tools';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from './toolAuthorization';
import { shutdownMainManagementTools } from './mainManagementTools';
import { tool_run_script } from './toolscript';
import { normalizeAccessConfig } from './accessConfig';

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

function client(url: string, token: string) {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  return { transport, sdk: new Client({ name: 'synthetic-hot-config', version: '1.0.0' }) };
}

async function socket(url: string, token: string, sessionId: string): Promise<WebSocket> {
  const ws = new WebSocket(`${url.replace('http:', 'ws:')}/api/webui/stream`, { headers: { Authorization: `Bearer ${token}` } });
  await once(ws, 'open');
  const applied = new Promise<void>((resolve, reject) => {
    ws.on('message', data => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'subscriptions-applied') resolve();
      if (frame.type === 'protocol-error') reject(new Error(frame.message));
    });
  });
  ws.send(JSON.stringify({ type: 'set-subscriptions', revision: 1, sessionListActive: false, sessionListIds: [], sessionIds: [sessionId] }));
  await applied;
  return ws;
}

test('Setup and Worker set_config share live WebUI/MCP identities without resetting unrelated contexts', { timeout: 60_000 }, async () => {
  await sessionManager.loadSessions();
  await initializeSessionRuntime();
  const bound = 'main/hot-config-bound';
  const other = 'main/hot-config-other';
  const sourceId = 'main/hot-config-source';
  await sessionManager.createEmptySession(bound);
  await sessionManager.createEmptySession(other);
  const source = await sessionManager.getSession(sourceId);
  const ctx: any = { sessionId: sourceId, session: source, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hot-config-candidate-'));
  const candidate = path.join(dir, 'candidate.yaml');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const admin = 'synthetic-hot-superuser';
  const server = new HttpServer(port, admin);
  setHttpServer(server);
  configInstaller.setHttpAvailable(true);
  const released: string[] = [];
  const contexts = new Map<string, ExternalExecutionContext>();
  const inbound = new McpInboundHttpService(ACCESS_RUNTIME, {
    async listTools(context) { contexts.set(context.externalId, context); return [{ name: 'synthetic_context', inputSchema: { type: 'object' } }]; },
    async callTool(context) { context.currentNode = 'synthetic-node'; context.cwd = 'synthetic-working-directory'; return { content: [{ type: 'text', text: context.id }] }; },
    releaseContext(context) { released.push(context.id); },
  });
  inbound.register(server);
  await server.start();
  const channel = new WebUIChannel({ token: admin, enableTrigger: false, router: { handleMessage: async () => {} } as any });
  await channel.start();
  const sockets: WebSocket[] = [];
  const clients: ReturnType<typeof client>[] = [];
  const streams: AbortController[] = [];
  const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
  const raw = (alphaToken: string, scopes: string[], beta = true, mcp = true) => `# Keep the original YAML\naccess:\n  identities:\n    alpha:\n      token: ${alphaToken}\n      surfaces:\n        webui: { sessions: [${scopes.join(', ')}] }\n${mcp ? '        mcp: {}\n' : ''}${beta ? `    beta:\n      token: beta-token\n      surfaces: { webui: { sessions: [${bound}] }, mcp: {} }\n` : ''}channels: {}\n`;
  const save = async (yaml: string) => {
    const response = await fetch(`${base}/api/setup/config`, { method: 'POST', headers: { ...headers(admin), 'Content-Type': 'application/json' }, body: JSON.stringify({ yaml }) });
    const body: any = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.saved, true);
    assert.deepEqual(body.notApplied, []);
    return body;
  };
  const history = (token: string, id: string) => fetch(`${base}/api/sessions/${encodeURIComponent(id)}/history`, { headers: headers(token) });
  try {
    assert.equal((await fetch(`${base}/mcp`, { headers: headers('alpha-token') })).status, 401);
    const initial = raw('alpha-token', [bound]);
    await save(initial);
    assert.equal(await fs.readFile(APP_CONFIG_PATH, 'utf8'), initial);
    assert.equal((await history('alpha-token', other)).status, 403);
    const alpha = client(base, 'alpha-token');
    const beta = client(base, 'beta-token');
    clients.push(alpha, beta);
    await alpha.sdk.connect(alpha.transport);
    await beta.sdk.connect(beta.transport);
    await alpha.sdk.listTools();
    await beta.sdk.listTools();
    await alpha.sdk.callTool({ name: 'synthetic_context' });
    const alphaContext = contexts.get('alpha')!;
    const betaContext = contexts.get('beta')!;
    const betaSocket = await socket(base, 'beta-token', bound);
    sockets.push(betaSocket);
    const initialSocket = await socket(base, 'alpha-token', bound);
    sockets.push(initialSocket);
    const initialClose = once(initialSocket, 'close');
    await save(raw('alpha-token', ['main/*']));
    await initialClose;
    assert.equal((await history('alpha-token', other)).status, 200);
    await alpha.sdk.listTools();
    assert.equal(contexts.get('alpha'), alphaContext);
    assert.equal(alphaContext.currentNode, 'synthetic-node');
    assert.equal(alphaContext.cwd, 'synthetic-working-directory');
    assert.equal(betaSocket.readyState, WebSocket.OPEN);

    const wideSocket = await socket(base, 'alpha-token', other);
    sockets.push(wideSocket);
    const wideClose = once(wideSocket, 'close');
    const streamAbort = new AbortController();
    streams.push(streamAbort);
    const stream = await fetch(`${base}/api/sessions/${encodeURIComponent(other)}/stream`, { headers: headers('alpha-token'), signal: streamAbort.signal });
    assert.equal(stream.status, 200);
    const reader = stream.body!.getReader();
    await reader.read();
    const streamClosed = (async () => { try { while (!(await reader.read()).done) {} } catch {} })();
    await fs.writeFile(candidate, raw('alpha-token', [bound]));
    const toolResult: any = await set_config({ target: 'config', filePath: candidate }, ctx);
    assert.equal(JSON.parse(toolResult.output).saved, true);
    await wideClose;
    await streamClosed;
    assert.equal((await history('alpha-token', other)).status, 403);
    assert.equal((await history('alpha-token', bound)).status, 200);
    await alpha.sdk.listTools();
    assert.equal(contexts.get('alpha'), alphaContext);
    assert.equal(contexts.get('beta'), betaContext);
    assert.deepEqual(released, []);

    const upload = new FormData();
    upload.set('sessionId', bound);
    upload.set('file', new Blob(['synthetic attachment']), 'attachment.txt');
    const uploaded = await fetch(`${base}/api/upload`, { method: 'POST', headers: headers('alpha-token'), body: upload });
    assert.equal(uploaded.status, 200);
    const uploadedFile: any = await uploaded.json();
    const alphaSocket = await socket(base, 'alpha-token', bound);
    sockets.push(alphaSocket);
    const rotatedClose = once(alphaSocket, 'close');
    const oldMcpSession = alpha.transport.sessionId!;
    await save(raw('rotated-token', [bound]));
    await rotatedClose;
    assert.equal((await history('alpha-token', bound)).status, 401);
    assert.equal((await history('rotated-token', bound)).status, 200);
    assert.equal(alphaContext.disposed, true);
    assert.deepEqual(released, [alphaContext.id]);
    assert.equal(await fs.pathExists(uploadedFile.path), false);
    const staleContext = await fetch(`${base}/mcp`, { headers: { ...headers('rotated-token'), Accept: 'text/event-stream', 'Mcp-Session-Id': oldMcpSession } });
    assert.equal(staleContext.status, 404);
    const attachmentReuse = await fetch(`${base}/api/sessions/${encodeURIComponent(bound)}/message`, { method: 'POST', headers: { ...headers('rotated-token'), 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'reuse', uploadedFiles: [uploadedFile] }) });
    assert.equal(attachmentReuse.status, 403);
    await beta.sdk.listTools();
    assert.equal(contexts.get('beta'), betaContext);
    assert.equal(betaSocket.readyState, WebSocket.OPEN);

    const rotated = client(base, 'rotated-token');
    clients.push(rotated);
    await rotated.sdk.connect(rotated.transport);
    await rotated.sdk.listTools();
    const rotatedContext = contexts.get('alpha')!;
    const webUiWithdrawnSocket = await socket(base, 'rotated-token', bound);
    sockets.push(webUiWithdrawnSocket);
    const webUiWithdrawnClose = once(webUiWithdrawnSocket, 'close');
    await save(raw('rotated-token', [bound]).replace(`        webui: { sessions: [${bound}] }\n`, ''));
    await webUiWithdrawnClose;
    assert.equal((await history('rotated-token', bound)).status, 401);
    await rotated.sdk.listTools();
    assert.equal(contexts.get('alpha'), rotatedContext);
    assert.equal(rotatedContext.disposed, false);
    await save(raw('rotated-token', [bound]));
    await save(raw('rotated-token', [bound], true, false));
    assert.equal(rotatedContext.disposed, true);
    assert.equal((await fetch(`${base}/mcp`, { headers: headers('rotated-token') })).status, 401);
    assert.equal((await history('rotated-token', bound)).status, 200);
    await beta.sdk.listTools();
    const betaClosed = once(betaSocket, 'close');
    await save(raw('rotated-token', [bound], false, false));
    await betaClosed;
    assert.equal((await history('beta-token', bound)).status, 401);
    assert.equal(betaContext.disposed, true);
    assert.equal((await fetch(`${base}/mcp`, { headers: headers('beta-token') })).status, 401);

    const before = await fs.readFile(APP_CONFIG_PATH, 'utf8');
    const snapshot = ACCESS_RUNTIME.snapshot;
    const invalid = await fetch(`${base}/api/setup/config`, { method: 'POST', headers: { ...headers(admin), 'Content-Type': 'application/json' }, body: JSON.stringify({ yaml: raw(admin, [bound]) }) });
    assert.equal(invalid.status, 400);
    assert.equal(await fs.readFile(APP_CONFIG_PATH, 'utf8'), before);
    assert.equal(ACCESS_RUNTIME.snapshot, snapshot);
    await fs.writeFile(candidate, 'access: [synthetic-secret-that-must-not-be-echoed');
    await assert.rejects(() => set_config({ target: 'config', filePath: candidate }, ctx), error => {
      assert.match(String(error), /Invalid config YAML candidate/);
      assert.equal(String(error).includes('synthetic-secret-that-must-not-be-echoed'), false);
      return true;
    });
    assert.equal(await fs.readFile(APP_CONFIG_PATH, 'utf8'), before);
    assert.equal(ACCESS_RUNTIME.snapshot, snapshot);

    setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: allow\nrules:\n- id: models-only\n  match: { tool: { source: builtin, name: set_config }, args: { target: models } }\n  action: allow\n- id: deny-other-config\n  match: { tool: { source: builtin, name: set_config } }\n  action: deny\n'));
    await assert.rejects(() => set_config({ target: 'config', filePath: candidate }, ctx), /denies builtin/);
    const models = '# model candidate\nproviders: { synthetic: { providerType: openai, models: [hot-model] } }\ndefault: synthetic/hot-model\n';
    await fs.writeFile(candidate, models);
    await call_tool({ source: 'builtin', name: 'set_config', args: { target: 'models', filePath: candidate } }, ctx);
    assert.equal(await fs.readFile(getActiveModelsConfigPath(), 'utf8'), models);
    assert.equal(resolveModelConfig('synthetic/hot-model').modelEntry.model, 'hot-model');
    const scripted = await tool_run_script({ code: 'return call_tool("set_config", {"target": "models", "filePath": args["path"]})', args: { path: candidate } }, ctx);
    assert.equal(scripted.status, 'completed');
    const structured = await fetch(`${base}/api/setup/models`, { method: 'POST', headers: { ...headers(admin), 'Content-Type': 'application/json' }, body: JSON.stringify({ providerKey: 'synthetic', providerType: 'openai', models: 'structured-model', defaultModel: 'synthetic/structured-model' }) });
    assert.equal(structured.status, 200);
    assert.equal(resolveModelConfig('synthetic/structured-model').modelEntry.model, 'structured-model');
  } finally {
    setToolAuthorizationPolicyForTests(undefined);
    streams.forEach(abort => abort.abort());
    sockets.forEach(ws => ws.terminate());
    await Promise.allSettled(clients.map(entry => entry.sdk.close()));
    await inbound.stop();
    await channel.stop();
    await server.stop();
    setHttpServer(null);
    await ACCESS_RUNTIME.apply(normalizeAccessConfig(undefined));
    await shutdownMainManagementTools();
    await shutdownSessionRuntime();
    await fs.remove(dir);
  }
});
