import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as sessionManager from './sessionManager';
import * as tools from './tools';
import { executeTools, resolveSessionToolDefinitions } from './llm';
import { tool_search_tools } from './tools/unifiedSearch';
import { resolveDirectTool } from './tools/resolvedTools';
import { getAgentDir } from './config';
import { buildToolAuthorizationRequest, parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from './toolAuthorization';
import { getToolScriptRunForTests, shutdownToolScriptRuntime } from './toolscript';
import * as nodeExecution from './nodeExecution';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from './nodeExecutionService';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';
import { AuthenticatedRemoteNodeProvider, NodeProviderRegistry, type NodeFilesystemRequest, type NodeProvider, type NodeProviderDescriptor } from './nodes/providerRegistry';
import { nodesManager } from './nodes/manager';
import { negotiateNodeProtocol } from '../packages/shared/dist/nodeProtocol';
import { NodeClient } from '../packages/cli-node/dist/client';
import { RESOLVED_PATH_SIDECAR } from '../packages/shared/dist/resolvedPathMetadata';
import { setNodeToolSessionEventDispatcher } from '../packages/shared/dist/nodeTools';

function policy(text: string): void { setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(text)); }
function id(): string { return `source_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
async function owner() {
  const session = await sessionManager.getSession(id());
  session.currentNode = 'master';
  return session;
}
function context(session: any) { return { sessionId: session.id, session }; }
async function model(session: any, name: string, args: any) {
  const message = await executeTools([{ id: id(), name, args }], context(session), session);
  return message.parts[0].functionResponse!.response;
}
async function attach(providers: NodeProviderRegistry, expectedSourceSessionId?: string) {
  const registry = new RpcServiceRegistry();
  registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ providerRegistry: providers, expectedSourceSessionId }));
  const transport = new LocalRpcTransport(registry);
  await nodeExecution.initializeNodeExecution({ transport, placement: 'child-reverse' });
  return { transport, client: new RpcClient(nodeExecutionServiceDescriptor, transport) };
}
function primitive(files: Record<string, Buffer>) {
  const requests: NodeFilesystemRequest[] = [];
  const descriptors: NodeProviderDescriptor[] = ['source-a', 'source-b'].map(nodeId => ({
    id: nodeId, kind: 'sandbox', provider: 'source-files', type: 'memory', availability: 'ready', primitiveBackends: { filesystem: 'read' },
  }));
  const provider: NodeProvider = {
    id: 'source-files', listNodes: () => descriptors, getNode: nodeId => descriptors.find(item => item.id === nodeId),
    invokeFilesystem: async request => {
      requests.push(request);
      const data = files[request.path];
      if (!data) throw new Error('Synthetic source not found');
      if (request.operation === 'stat') return { kind: 'file', size: data.length, modifiedAtMs: 0 };
      if (request.operation === 'read') return { dataBase64: data.subarray(request.offset, request.offset! + request.count!).toString('base64') };
      throw new Error('Unexpected source operation');
    },
  };
  return { provider, requests };
}

test.afterEach(async () => {
  setToolAuthorizationPolicyForTests(undefined);
  await nodeExecution.shutdownNodeExecution();
  nodeExecution.resetNodeExecutionForTests();
});
test.after(async () => { await shutdownToolScriptRuntime(); });

test('Main source requires read in addition to starter permission across supported entry points', async () => {
  const session = await owner();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-source-'));
  const source = path.join(root, 'source.py');
  await fs.writeFile(source, 'return "MAIN_SOURCE"');
  policy(`version: 1\ndefaultAction: deny\nrules:\n- id: starters\n  match: { tool: { source: builtin, name: [run_script, start_toolscript_run] } }\n  action: allow\n`);
  const originalRead = fs.readFile;
  let sourceReads = 0;
  (fs as any).readFile = async (file: any, ...rest: any[]) => {
    if (file === source) sourceReads += 1;
    return (originalRead as any)(file, ...rest);
  };
  try {
    for (const [name, args] of [
      ['run_script', { filePath: source, mode: 'foreground' }],
      ['run_script', { filePath: source, mode: 'background' }],
      ['call_tool', { toolId: 'builtin:run_script', args: { filePath: source } }],
      ['call_tool', { toolId: 'builtin:start_toolscript_run', args: { filePath: source } }],
    ] as const) {
      const denied = await model(session, name, args);
      assert.match(denied.error, /authorization.*denies.*read/i);
    }
    assert.equal(sourceReads, 0);
    policy('version: 1\ndefaultAction: allow\nrules: []\n');
    const allowed = await model(session, 'run_script', { node: 'master', filePath: `  ${source}  ` });
    assert.equal(allowed.result, 'MAIN_SOURCE');
    assert.equal(sourceReads, 1);
    assert.equal((await getToolScriptRunForTests(allowed.runId))?.sourceNode, 'master');
    policy(`version: 1\ndefaultAction: allow\nrules:\n- id: no-starter\n  match: { tool: { source: builtin, name: run_script } }\n  action: deny\n`);
    assert.match((await model(session, 'run_script', { filePath: source })).error, /denies.*run_script/i);
    assert.equal(sourceReads, 1);
  } finally { (fs as any).readFile = originalRead; await fs.remove(root); }
});

test('source path facts follow selection and code precedence; master realpath blocks static symlink escape', async () => {
  const session = await owner();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-path-'));
  const allowed = path.join(root, 'allowed'); const outside = path.join(root, 'outside');
  await fs.ensureDir(allowed); await fs.ensureDir(outside);
  await fs.writeFile(path.join(outside, 'source.py'), 'return "OUTSIDE"');
  await fs.symlink(outside, path.join(allowed, 'escape'), 'dir');
  try {
    session.cwd = allowed;
    for (const name of ['run_script', 'start_toolscript_run']) {
      const request = buildToolAuthorizationRequest({ session, tool: { source: 'builtin', name }, targetNode: 'master', args: { filePath: ' escape/source.py ' } });
      assert.equal(request.paths[0].resolved, path.join(outside, 'source.py'));
      const remote = buildToolAuthorizationRequest({ session, tool: { source: 'builtin', name }, targetNode: 'source-a', args: { filePath: 'memory://source' } });
      assert.deepEqual(remote.paths, [{ arg: 'filePath', raw: 'memory://source', targetNode: 'source-a' }]);
      const inline = buildToolAuthorizationRequest({ session, tool: { source: 'builtin', name }, targetNode: 'master', args: { code: 'return 1', filePath: 'ignored.py' } });
      assert.deepEqual(inline.paths, []);
    }
    policy(`version: 1\ndefaultAction: allow\nrules:\n- id: only-local-source\n  match: { tool: { source: builtin, name: run_script }, path: { anyNotWithin: ${JSON.stringify(allowed)} } }\n  action: deny\n`);
    assert.match((await model(session, 'run_script', { filePath: 'escape/source.py' })).error, /denies.*run_script/i);
    policy(`version: 1\ndefaultAction: allow\nrules:\n- id: only-local-read\n  match: { tool: { source: node, name: read }, targetNode: master, path: { anyNotWithin: ${JSON.stringify(allowed)} } }\n  action: deny\n`);
    assert.match((await model(session, 'run_script', { filePath: 'escape/source.py' })).error, /denies.*read/i);
    policy('version: 1\ndefaultAction: allow\nrules: []\n');
    session.cwd = getAgentDir('main');
    const tokenDir = path.join(getAgentDir('main'), 'tmp', id()); await fs.ensureDir(tokenDir);
    try {
      await fs.writeFile(path.join(tokenDir, 'source.py'), 'return "TOKEN_SOURCE"');
      const result = await model(session, 'run_script', { filePath: `$fw_tmp/${path.basename(tokenDir)}/source.py` });
      assert.equal(result.result, 'TOKEN_SOURCE');
    } finally { await fs.remove(tokenDir); }
  } finally { await fs.remove(root); }
});

test('primitive source defaults to current Node and does not relocate VM or nested tool routing', async () => {
  const session = await owner(); session.currentNode = 'source-a'; session.cwd = 'memory://cwd';
  const fixture = primitive({ 'memory://source': Buffer.from('return call_tool("read", {"filePath": "memory://nested"})'), 'memory://nested': Buffer.from('NESTED_CURRENT') });
  const { transport } = await attach(new NodeProviderRegistry([fixture.provider]));
  policy('version: 1\ndefaultAction: allow\nrules: []\n');
  try {
    const resolved = await resolveDirectTool('run_script', { node: 'source-b', filePath: 'memory://source' }, context(session));
    assert.equal(resolved.executionNode, 'master'); assert.equal(resolved.permissionNode, 'source-b');
    assert.equal(resolved.targetNode, undefined);
    const result = await model(session, 'run_script', { node: 'source-b', filePath: ' memory://source ' });
    assert.equal(result.status, 'completed'); assert.equal(result.result.content, 'NESTED_CURRENT');
    assert.equal(session.currentNode, 'source-a'); assert.equal(session.cwd, 'memory://cwd');
    assert.equal(fixture.requests[0].nodeId, 'source-b'); assert.equal(fixture.requests[0].context.cwd, undefined);
    const nested = fixture.requests.find(item => item.path === 'memory://nested')!;
    assert.equal(nested.nodeId, 'source-a'); assert.equal(nested.context.cwd, 'memory://cwd');
    fixture.requests.length = 0;
    const modern = await model(session, 'run_script', { filePath: 'memory://source', mode: 'background' });
    assert.equal(modern.status, 'completed'); assert.equal(fixture.requests[0].nodeId, 'source-a');
    const compat = await model(session, 'call_tool', { toolId: 'builtin:start_toolscript_run', args: { node: 'current', filePath: 'memory://source' } });
    assert.equal(compat.status, 'completed'); assert.equal((await getToolScriptRunForTests(compat.runId))?.mode, 'background');
  } finally { await nodeExecution.shutdownNodeExecution(); await transport.drain(); transport.close(); }
});

test('actual source Node controls starter and read policy; inline cannot borrow remote source permission', async () => {
  const session = await owner(); session.currentNode = 'source-a';
  const fixture = primitive({ 'memory://source': Buffer.from('return "SOURCE_POLICY"') });
  const { transport } = await attach(new NodeProviderRegistry([fixture.provider]));
  policy(`version: 1\ndefaultAction: deny\nrules:\n- id: remote-starter\n  match: { tool: { source: builtin, name: [run_script, start_toolscript_run] }, targetNode: source-b }\n  action: allow\n- id: source-read\n  match: { tool: { source: node, name: read }, targetNode: source-b }\n  action: allow\n`);
  try {
    assert.equal((await model(session, 'run_script', { node: 'source-b', filePath: 'memory://source' })).result, 'SOURCE_POLICY');
    const count = fixture.requests.length;
    assert.match((await model(session, 'run_script', { filePath: 'memory://source' })).error, /denies.*run_script/i);
    assert.match((await model(session, 'run_script', { code: 'return 1' })).error, /denies.*run_script/i);
    assert.match((await model(session, 'run_script', { node: 'source-b', code: 'return 1', filePath: 'memory://source' })).error, /node applies only to filePath/i);
    assert.equal(fixture.requests.length, count);
    const injected = await resolveSessionToolDefinitions(session);
    assert.ok(injected.some(item => item.name === 'run_script'));
    const discovered = await tool_search_tools({ sources: ['builtin'], query: 'run_script', limit: 200 }, context(session));
    assert.match(discovered.output, /builtin:run_script/);
    policy(`version: 1\ndefaultAction: allow\nrules:\n- id: deny-read\n  match: { tool: { source: node, name: read }, targetNode: source-b }\n  action: deny\n`);
    assert.match((await model(session, 'run_script', { node: 'source-b', filePath: 'memory://source' })).error, /denies.*read/i);
    assert.equal(fixture.requests.length, count);
    assert.equal((await model(session, 'run_script', { code: 'return "INLINE"', filePath: 'memory://ignored' })).result, 'INLINE');
  } finally { await nodeExecution.shutdownNodeExecution(); await transport.drain(); transport.close(); }
});

test('complete source exceeds programmatic read budget, while resumed snapshots do not read it again', async () => {
  const session = await owner();
  const largeSource = Buffer.from(`#${'x'.repeat(1024 * 1024 + 1)}\nreturn "LARGE_SOURCE_TAIL"`);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-large-'));
  const filePath = path.join(root, 'large.py'); await fs.writeFile(filePath, largeSource);
  const files: Record<string, Buffer> = {
    'memory://large': largeSource,
    'memory://waiting': Buffer.from('value = ask_agent("safe pause")\nreturn {"value": value, "marker": "SNAPSHOT_SOURCE"}'),
  };
  const fixture = primitive(files);
  const { transport } = await attach(new NodeProviderRegistry([fixture.provider]));
  policy('version: 1\ndefaultAction: allow\nrules: []\n');
  try {
    assert.equal((await model(session, 'run_script', { node: 'master', filePath })).result, 'LARGE_SOURCE_TAIL');
    assert.equal((await model(session, 'run_script', { node: 'source-a', filePath: 'memory://large' })).result, 'LARGE_SOURCE_TAIL');
    const waiting = await model(session, 'run_script', { node: 'source-a', filePath: 'memory://waiting' });
    assert.equal(waiting.status, 'waiting');
    delete files['memory://waiting'];
    const before = fixture.requests.length;
    policy(`version: 1\ndefaultAction: allow\nrules:\n- id: deny-source-reads\n  match: { tool: { source: node, name: read } }\n  action: deny\n`);
    const continued = await model(session, 'continue_script', { runId: waiting.runId, continuationId: waiting.continuationId, input: 'answer' });
    assert.deepEqual(continued.result, { value: 'answer', marker: 'SNAPSHOT_SOURCE' });
    assert.equal(fixture.requests.length, before);
    const nested = await model(session, 'run_script', { code: 'return call_tool("node:master/read", {"filePath": args["path"]})', args: { path: filePath } });
    assert.equal(nested.status, 'failed'); assert.match(nested.error, /denies.*read/i);
  } finally { await nodeExecution.shutdownNodeExecution(); await transport.drain(); transport.close(); await fs.remove(root); }
});

test('raw source service retains exact source, read denial, availability and complete-data fences', async () => {
  const session = await owner();
  const fixture = primitive({ 'memory://source': Buffer.from('return 99') });
  const provider: NodeProvider = {
    id: 'partial-files',
    listNodes: () => [],
    getNode: nodeId => nodeId === 'display-only'
      ? { id: nodeId, kind: 'remote', provider: 'partial-files', type: 'custom', availability: 'ready', tools: [{ name: 'read' }] }
      : nodeId === 'no-read'
        ? { id: nodeId, kind: 'remote', provider: 'partial-files', type: 'custom', availability: 'ready', tools: [] }
        : undefined,
    invokeTool: async () => { throw new Error('Display reads must not load source'); },
  };
  const { transport, client } = await attach(new NodeProviderRegistry([fixture.provider, provider]), session.id);
  policy('version: 1\ndefaultAction: allow\nrules: []\n');
  try {
    await assert.rejects(() => client.call('readFile', { sourceSessionId: 'wrong-owner', nodeId: 'source-a', filePath: 'memory://source' }), { code: 'NODE_EXECUTION_SOURCE_MISMATCH' });
    await assert.rejects(() => client.call('readFile', { sourceSessionId: session.id, nodeId: 'master', filePath: 'source.py' }), { code: 'NODE_EXECUTION_MASTER_FORBIDDEN' });
    await assert.rejects(() => client.call('readFile', { sourceSessionId: session.id, nodeId: 'source-a', filePath: 'memory://source', routingSnapshot: { currentNode: 'another-node', cwd: 'private-cwd' } }), /cwd must belong/i);
    for (const [nodeId, code] of [['offline', 'NODE_EXECUTION_NODE_UNAVAILABLE'], ['no-read', 'NODE_EXECUTION_TOOL_UNAVAILABLE'], ['display-only', 'NODE_FILE_READ_UNAVAILABLE']]) {
      await assert.rejects(() => client.call('readFile', { sourceSessionId: session.id, nodeId, filePath: 'source.py' }), { code });
    }
    assert.equal(fixture.requests.length, 0);
    policy(`version: 1\ndefaultAction: allow\nrules:\n- id: no-read\n  match: { tool: { source: node, name: read } }\n  action: deny\n`);
    await assert.rejects(() => client.call('readFile', { sourceSessionId: session.id, nodeId: 'source-a', filePath: 'memory://source' }), /denies.*read/i);
    assert.equal(fixture.requests.length, 0);
    policy('version: 1\ndefaultAction: allow\nrules: []\n');
    const original = fixture.provider.invokeFilesystem!;
    fixture.provider.invokeFilesystem = async (request, options) => request.operation === 'read'
      ? { dataBase64: Buffer.from('return 1').toString('base64') } : original(request, options);
    await assert.rejects(() => client.call('readFile', { sourceSessionId: session.id, nodeId: 'source-a', filePath: 'memory://source' }), { code: 'NODE_FILE_READ_INCOMPLETE' });
  } finally { await nodeExecution.shutdownNodeExecution(); await transport.drain(); transport.close(); }
});

test('Worker exact-owner source read uses reverse fence and hot cwd without Session hydration', async () => {
  const projection = await owner(); projection.currentNode = 'projection-node'; projection.cwd = 'memory://stale';
  const hot = { ...projection, currentNode: 'source-a', cwd: 'memory://hot' };
  const fixture = primitive({ 'memory://source': Buffer.from('return "WORKER_SOURCE"') });
  const { transport } = await attach(new NodeProviderRegistry([fixture.provider]), hot.id);
  const originals = { getSession: sessionManager.getSession, getExistingSession: sessionManager.getExistingSession, saveSession: sessionManager.saveSession };
  for (const key of Object.keys(originals)) (sessionManager as any)[key] = async () => { throw new Error(`Forbidden Session hydration: ${key}`); };
  policy('version: 1\ndefaultAction: allow\nrules: []\n');
  try {
    const ctx: any = { sessionId: hot.id, session: hot, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
    const result = await tools.callTool('call_tool', { toolId: 'builtin:run_script', args: { filePath: 'memory://source' } }, ctx);
    assert.equal(result.result, 'WORKER_SOURCE'); assert.equal(fixture.requests[0].context.cwd, 'memory://hot');
    assert.equal(projection.currentNode, 'projection-node'); assert.equal(projection.cwd, 'memory://stale');
    policy(`version: 1\ndefaultAction: allow\nrules:\n- id: no-read\n  match: { tool: { source: node, name: read }, targetNode: source-a }\n  action: deny\n`);
    const before = fixture.requests.length;
    await assert.rejects(() => tools.callTool('run_script', { filePath: 'memory://source' }, ctx), /denies.*read/i);
    assert.equal(fixture.requests.length, before);
  } finally { Object.assign(sessionManager, originals); await nodeExecution.shutdownNodeExecution(); await transport.drain(); transport.close(); }
});

test('source reads retain isolated bound-Node, exact read-rule and master path restrictions', async () => {
  const session = await owner(); session.agent = id(); session.currentNode = 'source-a';
  const fixture = primitive({ 'memory://source': Buffer.from('return "BOUND_SOURCE"') });
  const { transport } = await attach(new NodeProviderRegistry([fixture.provider]));
  const rules: any[] = [{ source: 'builtin', tool: 'run_script', effect: 'allow' }, { source: 'node', node: 'master', tool: 'read', effect: 'allow' }];
  await sessionManager.setAgentMetadata(session.agent, { isolated: true, isolatedNode: 'source-a', toolRules: rules });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'script-isolated-'));
  const filePath = path.join(outside, 'source.py'); await fs.writeFile(filePath, 'return "OUTSIDE"');
  policy('version: 1\ndefaultAction: allow\nrules: []\n');
  try {
    assert.equal((await model(session, 'run_script', { filePath: 'memory://source' })).result, 'BOUND_SOURCE');
    const count = fixture.requests.length;
    assert.match((await model(session, 'run_script', { node: 'source-b', filePath: 'memory://source' })).error, /cannot use node capability/i);
    assert.match((await model(session, 'run_script', { node: 'master', filePath })).error, /only access agents\//i);
    await sessionManager.setAgentMetadata(session.agent, { isolated: true, isolatedNode: 'source-a', toolRules: [...rules, { source: 'node', node: 'source-a', tool: 'read', effect: 'deny' }] });
    assert.match((await model(session, 'run_script', { filePath: 'memory://source' })).error, /tool rule denies.*read/i);
    assert.equal(fixture.requests.length, count);
  } finally {
    await sessionManager.setAgentMetadata(session.agent, { isolated: false });
    await nodeExecution.shutdownNodeExecution(); await transport.drain(); transport.close(); await fs.remove(outside);
  }
});

test('CLI source retains real interceptor approval and consumes only complete programmatic or transfer content', async () => {
  const session = await owner();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-cli-'));
  const nodeId = `cli-source-${id()}`;
  session.currentNode = nodeId; session.cwd = root;
  const source = path.join(root, 'source.py'); await fs.writeFile(source, 'return "CLI_SOURCE"');
  const requests: any[] = []; const approvals: any[] = [];
  let approve = false; let keepResolvedPaths = false;
  const originalAgentDir = process.env.FOXWARM_AGENT_DIR;
  process.env.FOXWARM_AGENT_DIR = root;
  const cli = new NodeClient({
    host: 'http://fixture.invalid', nodeId, authToken: 'fixture-token', localTrigger: false,
    credentialsFile: path.join(root, 'credentials.json'),
    toolCallInterceptor: async (tool, args) => { approvals.push({ tool, args }); return approve; },
  });
  (cli as any).send = (message: any) => {
    if (message.type === 'tool_call_response') {
      const result = { ...message.result };
      if (!keepResolvedPaths) delete result[RESOLVED_PATH_SIDECAR];
      nodesManager.handleToolResponse(message.callId, result, nodeId);
    } else if (message.type === 'tool_call_error') nodesManager.handleToolError(message.callId, message.error, undefined, nodeId);
    else if (message.type === 'file_read_response') nodesManager.handleFileReadResponse(message.transferId, message.file);
    else if (message.type === 'file_transfer_error') nodesManager.handleFileTransferError(message.transferId, message.error);
  };
  const socket: any = {
    send: (raw: string) => {
      const message = JSON.parse(raw); if (message.type === 'registered') return;
      if (message.type === 'file_read_request') requests.push(message);
      void (cli as any).handleMessage(message);
    }, close: () => {},
  };
  const register = (programmatic: boolean) => nodesManager.registerNodeWithTools(socket, {} as any, 'cli-node', {
    tools: [{ name: 'read', description: 'Fixture read' }], ...(programmatic ? { features: { programmaticToolData: true } } : {}),
  }, nodeId, negotiateNodeProtocol({ min: 1, max: 1 }, undefined, true));
  register(false);
  const { transport } = await attach(new NodeProviderRegistry([new AuthenticatedRemoteNodeProvider()]));
  policy('version: 1\ndefaultAction: allow\nrules: []\n');
  try {
    const denied = await model(session, 'run_script', { filePath: 'source.py' });
    assert.match(denied.error, /rejected by user/i); assert.equal(approvals.length, 1); assert.equal(requests.length, 0);
    approve = true;
    const missing = await model(session, 'run_script', { filePath: 'missing.py' });
    assert.match(missing.error, /ENOENT|no such file/i); assert.equal(requests.length, 0);
    assert.equal((await model(session, 'run_script', { filePath: 'source.py' })).result, 'CLI_SOURCE');
    assert.equal(requests[0].filePath, source);
    assert.equal((await model(session, 'run_script', { filePath: '$fw_agentdir/source.py' })).result, 'CLI_SOURCE');
    assert.equal(requests[1].filePath, '$fw_agentdir/source.py');
    session.currentNode = 'master'; session.cwd = '/unrelated-session-cwd';
    assert.equal((await model(session, 'run_script', { node: nodeId, filePath: 'source.py' })).result, 'CLI_SOURCE');
    assert.equal(requests[2].filePath, 'source.py');
    session.currentNode = nodeId; session.cwd = root;
    register(true); keepResolvedPaths = true;
    const beforeComplete = requests.length;
    assert.equal((await model(session, 'run_script', { filePath: 'source.py' })).result, 'CLI_SOURCE');
    assert.equal(requests.length, beforeComplete, 'whole-file programmatic content needs no second read');
    await fs.writeFile(path.join(root, 'large.py'), `#${'x'.repeat(1024 * 1024 + 1)}\nreturn "CLI_LARGE_TAIL"`);
    assert.equal((await model(session, 'run_script', { filePath: 'large.py' })).result, 'CLI_LARGE_TAIL');
    assert.equal(requests.at(-1).filePath, path.join(root, 'large.py'));
    assert.ok(approvals.every(item => item.tool === 'read'));
    const bytes = Buffer.from('return "TRANSFER_SOURCE"');
    const originalRead = nodesManager.readFileFromNode; const originalTool = nodesManager.executeTool;
    try {
      (nodesManager as any).executeTool = async () => ({ content: 'return "PREFIX_ONLY"', truncated: false, sizeBytes: 100, selectedBytes: 20, filePath: source });
      assert.equal((await model(session, 'run_script', { filePath: 'source.py' })).result, 'CLI_SOURCE');
      assert.equal(requests.at(-1).filePath, source, 'partial content falls back to the actual approved path');
      const paths: string[] = [];
      (nodesManager as any).executeTool = async () => ({ output: 'Legacy display without source metadata' });
      (nodesManager as any).readFileFromNode = async (_nodeId: string, target: string) => {
        paths.push(target);
        return { dataBase64: bytes.toString('base64'), sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      };
      session.cwd = 'C:\\workspace\\src';
      assert.equal((await model(session, 'run_script', { filePath: '..\\source.py' })).result, 'TRANSFER_SOURCE');
      assert.equal((await model(session, 'run_script', { filePath: '\\source.py' })).result, 'TRANSFER_SOURCE');
      assert.equal((await model(session, 'run_script', { filePath: 'C:source.py' })).result, 'TRANSFER_SOURCE');
      assert.deepEqual(paths, ['C:\\workspace\\source.py', '\\source.py', 'C:\\workspace\\src\\source.py']);
      session.cwd = 'D:\\workspace';
      assert.match((await model(session, 'run_script', { filePath: 'C:source.py' })).error, /drive-absolute source path/i);
      assert.equal(paths.length, 3);
      session.cwd = '/posix-workspace';
      assert.equal((await model(session, 'run_script', { filePath: 'C:source.py' })).result, 'TRANSFER_SOURCE');
      assert.equal(paths[3], '/posix-workspace/C:source.py');
      session.cwd = root;
      (nodesManager as any).readFileFromNode = async () => ({ dataBase64: bytes.toString('base64'), sizeBytes: bytes.length + 1, sha256: createHash('sha256').update(bytes).digest('hex') });
      assert.match((await model(session, 'run_script', { filePath: 'source.py' })).error, /invalid sizeBytes/i);
    } finally { (nodesManager as any).readFileFromNode = originalRead; (nodesManager as any).executeTool = originalTool; }
  } finally {
    setNodeToolSessionEventDispatcher(undefined);
    if (originalAgentDir === undefined) delete process.env.FOXWARM_AGENT_DIR; else process.env.FOXWARM_AGENT_DIR = originalAgentDir;
    nodesManager.unregisterNode(nodeId); await nodeExecution.shutdownNodeExecution(); await transport.drain(); transport.close(); await fs.remove(root);
  }
});
