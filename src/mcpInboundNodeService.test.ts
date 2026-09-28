import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import WebSocket from 'ws';
import { NodeClient } from '../packages/cli-node/dist/client';
import { CLI_NODE_CAPABILITIES } from '../packages/shared/dist/nodeCapabilities';
import { HttpServer } from './httpServer';
import { normalizeMcpInboundConfig, authenticateMcpInboundBearer } from './mcpInboundConfig';
import { McpInboundMcpCatalog } from './mcpInboundCatalog';
import { McpInboundHttpService } from './mcpInboundHttp';
import type { ExternalExecutionContext } from './mcpInboundHttp';
import { callExternalNodeTool, externalExecResult, externalNodeAction, listExternalNodeTools } from './mcpInboundNodeService';
import { nodesManager } from './nodes/manager';
import {
  approvePendingPairing, createNodeRegistryStore, createPendingPairing, resetNodeRegistryForTests, setNodeRegistryStoreForTests,
} from './nodes/registry';
import { registerNodeWebSocket } from './nodes/websocket';
import { sessionCatalogStore } from './session/catalogStore';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from './toolAuthorization';

const credentials = normalizeMcpInboundConfig({ enabled: true, identities: { alpha: { token: 'synthetic-alpha-token' }, beta: { token: 'synthetic-beta-token' } } });
const policy = parseToolAuthorizationPolicyBytes(`
version: 1
defaultAction: deny
rules:
  - id: allow-node-control
    match: { externalId: alpha, tool: { source: builtin, name: node } }
    action: allow
  - id: allow-node-files
    match: { externalId: alpha, tool: { source: node, name: [read, write, edit, apply_patch, exec] }, targetNode: [paired-external-node, paired-old-node] }
    action: allow
`);

// A real paired CLI Node receives every call over the authenticated WebSocket.
test('an external context discovers, selects, and uses paired CLI file capabilities without a Session', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-external-node-'));
  setNodeRegistryStoreForTests(createNodeRegistryStore(path.join(dir, 'nodes.json')));
  resetNodeRegistryForTests();
  setToolAuthorizationPolicyForTests(policy);
  await sessionCatalogStore.initialize();
  const sourceSessionCount = sessionCatalogStore.count();
  const pending = await createPendingPairing({
    requestedName: 'paired-external-node', nodeType: 'cli-node',
    capabilities: { ...CLI_NODE_CAPABILITIES, tools: [...CLI_NODE_CAPABILITIES.tools], features: { externalToolOwner: 1, remoteExecBackgroundRegistration: true } },
  });
  const approved = await approvePendingPairing(pending.id, 'paired-external-node');
  const server = new HttpServer(0, 'instance-token');
  registerNodeWebSocket(server, 'pair-token');
  const inbound = new McpInboundHttpService(credentials, new McpInboundMcpCatalog(), 60_000);
  inbound.register(server);
  await server.start();
  const port = ((server as any).httpServer.address() as { port: number }).port;
  let registered!: () => void;
  const ready = new Promise<void>(resolve => { registered = resolve; });
  const client = new NodeClient({ host: `http://127.0.0.1:${port}`, nodeId: approved.nodeId, authToken: approved.authToken,
    credentialsFile: path.join(dir, 'client.json'), localTrigger: false,
    onStatus: event => { if (event === 'registered') registered(); } });
  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  const alphaTransport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: 'Bearer synthetic-alpha-token' } } });
  const betaTransport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: 'Bearer synthetic-beta-token' } } });
  const alphaClient = new Client({ name: 'external-alpha', version: '1' });
  const betaClient = new Client({ name: 'external-beta', version: '1' });
  let oldSocket: WebSocket | undefined;
  try {
    await client.connect();
    await Promise.race([ready, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('CLI Node did not register.')), 5_000))]);
    assert.equal(nodesManager.supportsExternalOwner('paired-external-node'), true);
    const alpha = authenticateMcpInboundBearer(credentials, 'Bearer synthetic-alpha-token')!;
    const beta = authenticateMcpInboundBearer(credentials, 'Bearer synthetic-beta-token')!;
    const a: ExternalExecutionContext = { id: '11111111-2222-4333-8444-555555555555', externalId: 'alpha', currentNode: 'master', cwd: null, selectionGeneration: 0 };
    const b: ExternalExecutionContext = { id: '11111111-2222-4333-8444-666666666666', externalId: 'beta', currentNode: 'master', cwd: null, selectionGeneration: 0 };
    assert.deepEqual(await listExternalNodeTools(beta, b), []);
    const tools = await listExternalNodeTools(alpha, a);
    assert.deepEqual(new Set(tools.map(tool => tool.name)), new Set(['read', 'write', 'edit', 'apply_patch', 'exec']));
    assert.equal((await externalNodeAction(alpha, a, 'status')).available, false); // master not yet supported externally.
    setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`version: 1
defaultAction: deny
rules:
  - id: master-only-node-action
    match: { externalId: alpha, tool: { source: builtin, name: node }, targetNode: master }
    action: allow
  - id: remote-file-is-visible
    match: { externalId: alpha, tool: { source: node, name: read }, targetNode: paired-external-node }
    action: allow
`));
    assert.equal((await externalNodeAction(alpha, a, 'status')).currentNode, 'master');
    await assert.rejects(() => externalNodeAction(alpha, a, 'list'), /not permitted/);
    await assert.rejects(() => externalNodeAction(alpha, a, 'select', 'paired-external-node'), /not permitted/);
    assert.equal(a.currentNode, 'master');
    setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`version: 1
defaultAction: deny
rules:
  - id: exact-node-select
    match: { externalId: alpha, tool: { source: builtin, name: node }, targetNode: paired-external-node, args: { action: select, nodeId: paired-external-node } }
    action: allow
  - id: remote-file-is-visible
    match: { externalId: alpha, tool: { source: node, name: read }, targetNode: paired-external-node }
    action: allow
`));
    assert.equal((await externalNodeAction(alpha, a, 'select', ' paired-external-node ')).currentNode, 'paired-external-node');
    setToolAuthorizationPolicyForTests(policy);
    assert.equal((await externalNodeAction(alpha, a, 'status')).available, true);
    const filePath = path.join(dir, 'test.txt');
    await callExternalNodeTool(alpha, a, 'paired-external-node', 'write', { filePath, content: 'one', createDirs: true });
    await callExternalNodeTool(alpha, a, 'paired-external-node', 'edit', { filePath, oldText: 'one', newText: 'two' });
    await callExternalNodeTool(alpha, a, 'paired-external-node', 'apply_patch', { input: `*** Begin Patch\n*** Update File: ${filePath}\n@@\n-two\n+three\n*** End Patch` });
    const read = await callExternalNodeTool(alpha, a, 'paired-external-node', 'read', { filePath });
    assert.match(String((read as any).output), /three/);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'three');
    await assert.rejects(() => callExternalNodeTool(beta, b, 'paired-external-node', 'read', { filePath }), /not permitted/);
    await assert.rejects(() => externalNodeAction(beta, b, 'select', 'paired-external-node'), /not permitted/);
    const foreground = await callExternalNodeTool(alpha, a, 'paired-external-node', 'exec', {
      command: `cd ${JSON.stringify(dir)}; printf foreground-result`, timeout: 2,
    }) as any;
    assert.equal(foreground.background, false);
    assert.match(foreground.output, /foreground-result/);
    assert.equal((await externalNodeAction(alpha, a, 'status')).cwd, dir);
    assert.equal((await externalExecResult(alpha, a, foreground.execId) as any).state, 'completed');
    const background = await callExternalNodeTool(alpha, a, 'paired-external-node', 'exec', {
      command: 'printf early-output; sleep 2; printf late-output', timeout: 1,
    }) as any;
    assert.equal(background.background, true);
    assert.equal(typeof background.execId, 'string');
    await assert.rejects(() => externalExecResult(beta, b, background.execId), /unavailable/);
    const partial = await externalExecResult(alpha, a, background.execId) as any;
    assert.equal(partial.state, 'running');
    assert.match(partial.output, /early-output/);
    let finished: any;
    for (let attempt = 0; attempt < 25; attempt++) {
      finished = await externalExecResult(alpha, a, background.execId);
      if (finished.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(finished.state, 'completed', JSON.stringify(finished));
    assert.match(finished.output, /late-output/);
    const externalDir = path.join(dir, 'external-exec', crypto.createHash('sha256').update('alpha').digest('hex'), a.id);
    assert.equal(await fs.pathExists(path.join(externalDir, 'running.json')), true);
    await alphaClient.connect(alphaTransport);
    await betaClient.connect(betaTransport);
    assert.deepEqual((await alphaClient.listTools()).tools.map(tool => tool.name),
      ['foxwarm_discover', 'foxwarm_call', 'foxwarm_node', 'foxwarm_exec_result', 'foxwarm_session']);
    const selection = await alphaClient.callTool({ name: 'foxwarm_node', arguments: { action: 'select', nodeId: 'paired-external-node' } });
    assert.equal((selection.structuredContent as any)?.currentNode, 'paired-external-node');
    const discovered = await alphaClient.callTool({ name: 'foxwarm_discover', arguments: { sources: ['node'], limit: 20 } });
    assert.ok((discovered.structuredContent as any)?.tools?.some((tool: any) => tool.toolId === 'node:paired-external-node/exec'));
    const other = await betaClient.callTool({ name: 'foxwarm_discover', arguments: { sources: ['node'], limit: 20 } });
    assert.equal((other.structuredContent as any)?.total, 0);
    const oldPending = await createPendingPairing({ requestedName: 'paired-old-node', nodeType: 'cli-node',
      capabilities: { tools: [...CLI_NODE_CAPABILITIES.tools], features: { externalToolOwner: 1 } },
      nodeProtocol: { min: 1, max: 2 } });
    const oldApproved = await approvePendingPairing(oldPending.id, 'paired-old-node');
    oldSocket = new WebSocket(`ws://127.0.0.1:${port}/node_ws?id=paired-old-node&auth=${oldApproved.authToken}`);
    await once(oldSocket, 'open');
    let oldEffectCount = 0;
    const oldRegistered = new Promise<any>(resolve => oldSocket!.on('message', raw => {
      const packet = JSON.parse(String(raw));
      if (packet.type === 'tool_call') oldEffectCount++;
      if (packet.type === 'registered') resolve(packet);
    }));
    oldSocket.send(JSON.stringify({ type: 'node_register', nodeType: 'cli-node',
      capabilities: { tools: [...CLI_NODE_CAPABILITIES.tools], features: { externalToolOwner: 1 } },
      nodeProtocol: { min: 1, max: 2 } }));
    assert.equal((await oldRegistered).nodeProtocol.negotiated, 2);
    assert.equal(nodesManager.supportsExternalOwner('paired-old-node'), false);
    const oldRead = await alphaClient.callTool({ name: 'foxwarm_call', arguments: {
      toolId: 'node:paired-old-node/read', args: { filePath: path.join(dir, 'test.txt') },
    } });
    assert.equal(oldRead.isError, true);
    assert.equal(oldEffectCount, 0, 'v2 Node was rejected by Main before sending a tool_call');
    const sdkFile = path.join(dir, 'sdk.txt');
    const sdkWrite = await alphaClient.callTool({ name: 'foxwarm_call', arguments: {
      toolId: 'node:paired-external-node/write', args: { filePath: sdkFile, content: 'sdk-data' },
    } });
    assert.equal(sdkWrite.isError, undefined);
    assert.equal(await fs.readFile(sdkFile, 'utf8'), 'sdk-data');
    const betaRead = await betaClient.callTool({ name: 'foxwarm_call', arguments: {
      toolId: 'node:paired-external-node/read', args: { filePath: sdkFile },
    } });
    assert.equal(betaRead.isError, true);
    const sdkForeground = await alphaClient.callTool({ name: 'foxwarm_call', arguments: {
      toolId: 'node:paired-external-node/exec', args: { command: `cd ${JSON.stringify(dir)}; printf sdk-foreground`, timeout: 2 },
    } });
    assert.equal((sdkForeground.structuredContent as any)?.background, false);
    assert.equal(((await alphaClient.callTool({ name: 'foxwarm_node', arguments: { action: 'status' } })).structuredContent as any)?.cwd, dir);
    const laterCwd = path.join(dir, 'later');
    await fs.ensureDir(laterCwd);
    const sdkBackground = await alphaClient.callTool({ name: 'foxwarm_call', arguments: {
      toolId: 'node:paired-external-node/exec', args: {
        command: `cd ${JSON.stringify(laterCwd)}; printf sdk-early; sleep 2; printf sdk-late`, timeout: 1,
      },
    } });
    assert.equal((sdkBackground.structuredContent as any)?.background, true);
    const sdkExecId = (sdkBackground.structuredContent as any).execId as string;
    assert.equal((await betaClient.callTool({ name: 'foxwarm_exec_result', arguments: { execId: sdkExecId } })).isError, true);
    let sdkFinished: any;
    for (let attempt = 0; attempt < 25; attempt++) {
      sdkFinished = await alphaClient.callTool({ name: 'foxwarm_exec_result', arguments: { execId: sdkExecId } });
      if (sdkFinished.structuredContent?.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.equal(sdkFinished.structuredContent?.state, 'completed', JSON.stringify(sdkFinished));
    assert.match((sdkFinished.structuredContent as any).output, /sdk-late/);
    assert.equal(((await alphaClient.callTool({ name: 'foxwarm_node', arguments: { action: 'status' } })).structuredContent as any)?.cwd, laterCwd);
    const siblingTransport = new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { Authorization: 'Bearer synthetic-alpha-token' } },
    });
    const siblingClient = new Client({ name: 'external-alpha-new-context', version: '1' });
    await siblingClient.connect(siblingTransport);
    try {
      const guessed = await siblingClient.callTool({ name: 'foxwarm_exec_result', arguments: { execId: sdkExecId } });
      assert.equal(guessed.isError, true, 'the same external identity cannot claim another transport context result');
    } finally { await siblingClient.close(); }
    const reconnectTransport = new StreamableHTTPClientTransport(endpoint, {
      sessionId: alphaTransport.sessionId, requestInit: { headers: { Authorization: 'Bearer synthetic-alpha-token' } },
    });
    const reconnectClient = new Client({ name: 'external-alpha-reconnected', version: '1' });
    await reconnectClient.connect(reconnectTransport);
    try {
      const selected = await reconnectClient.callTool({ name: 'foxwarm_node', arguments: { action: 'status' } });
      assert.equal((selected.structuredContent as any)?.cwd, laterCwd);
      const known = await reconnectClient.callTool({ name: 'foxwarm_exec_result', arguments: {} });
      assert.ok((known.structuredContent as any)?.executions.some((entry: any) => entry.execId === sdkExecId));
    } finally { await reconnectClient.close(); }

    // Losing one POST response is not a DELETE: the same SDK session can still discover its real exec ID.
    const interrupted = new AbortController();
    const disconnectedPost = fetch(endpoint, {
      method: 'POST', signal: interrupted.signal,
      headers: { Authorization: 'Bearer synthetic-alpha-token', 'Mcp-Session-Id': alphaTransport.sessionId!,
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 987, method: 'tools/call', params: { name: 'foxwarm_call', arguments: {
        toolId: 'node:paired-external-node/exec', args: { command: 'printf posted-early; sleep 3; printf posted-finished', timeout: 1 },
      } } }),
    }).catch((): undefined => undefined);
    await new Promise(resolve => setTimeout(resolve, 200));
    interrupted.abort();
    await disconnectedPost;
    let postedExecId: string | undefined;
    for (let attempt = 0; attempt < 30; attempt++) {
      const listed = await alphaClient.callTool({ name: 'foxwarm_exec_result', arguments: {} });
      postedExecId = (listed.structuredContent as any)?.executions.find((entry: any) =>
        entry.execId !== sdkExecId && entry.execId !== (sdkForeground.structuredContent as any).execId)?.execId;
      if (postedExecId) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(typeof postedExecId, 'string');
    let postedFinished: any;
    for (let attempt = 0; attempt < 35; attempt++) {
      postedFinished = await alphaClient.callTool({ name: 'foxwarm_exec_result', arguments: { execId: postedExecId } });
      if (postedFinished.structuredContent?.state === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.equal(postedFinished.structuredContent?.state, 'completed', JSON.stringify(postedFinished));
    assert.match((postedFinished.structuredContent as any).output, /posted-finished/);
    setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: deny\nrules: []\n'));
    await assert.rejects(() => externalExecResult(alpha, a, background.execId), /not permitted/);
    assert.equal((await alphaClient.callTool({ name: 'foxwarm_exec_result', arguments: { execId: sdkExecId } })).isError, true);
    setToolAuthorizationPolicyForTests(policy);
    const marker = path.join(dir, 'exec-survived-delete.txt');
    const sessionId = alphaTransport.sessionId!;
    const survivingJob = await alphaClient.callTool({ name: 'foxwarm_call', arguments: {
      toolId: 'node:paired-external-node/exec', args: {
        command: `sleep 2; printf survived > ${JSON.stringify(marker)}`, timeout: 1,
      },
    } });
    assert.equal((survivingJob.structuredContent as any)?.background, true);
    await alphaTransport.terminateSession();
    const expired = await fetch(endpoint, { headers: { Authorization: 'Bearer synthetic-alpha-token',
      'Mcp-Session-Id': sessionId, Accept: 'text/event-stream' } });
    assert.equal(expired.status, 404);
    await expired.body?.cancel();
    let survived = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      if (await fs.pathExists(marker)) { survived = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(survived, true, 'DELETE expires the owner map but does not terminate an already-running command');
    const releasedDir = path.join(dir, 'external-exec', crypto.createHash('sha256').update('alpha').digest('hex'), sessionId);
    let cleaned = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (!await fs.pathExists(releasedDir)) { cleaned = true; break; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(cleaned, true, 'Node removes released external artifacts only after the command exits');
    assert.equal(sessionCatalogStore.count(), sourceSessionCount,
      'external Node calls and completions did not create a Foxwarm Session or its event history');
  } finally {
    oldSocket?.close();
    await alphaClient.close().catch((): undefined => undefined);
    await betaClient.close().catch((): undefined => undefined);
    await inbound.stop();
    await client.disconnect();
    await server.stop().catch((): undefined => undefined);
    nodesManager.unregisterNode('paired-external-node');
    await new Promise(resolve => setTimeout(resolve, 150)); // Registered-node activity is persisted best-effort after socket close.
    setToolAuthorizationPolicyForTests(undefined);
    setNodeRegistryStoreForTests(null);
    resetNodeRegistryForTests();
    await fs.remove(dir);
  }
});
