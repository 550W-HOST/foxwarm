import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import * as sessionManager from './sessionManager';
import * as sessionRuntime from './sessionRuntime';
import * as checks from './isolatedCheck';
import * as tools from './tools';
import { executeTools } from './llm';
import { buildToolAuthorizationRequest, parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from './toolAuthorization';
import { getToolScriptRunForTests, shutdownToolScriptRuntime } from './toolscript';
import * as nodeExecution from './nodeExecution';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from './nodeExecutionService';
import { LocalRpcTransport, RpcServiceRegistry } from './rpc';
import { AuthenticatedRemoteNodeProvider, MasterNodeProvider, NodeProviderRegistry, type NodeProviderDescriptor } from './nodes/providerRegistry';
import { nodesManager } from './nodes/manager';
import { NodeClient } from '../packages/cli-node/dist/client';
import { negotiateNodeProtocol } from '../packages/shared/dist/nodeProtocol';
import { RESOLVED_PATH_SIDECAR } from '../packages/shared/dist/resolvedPathMetadata';
import { setNodeToolSessionEventDispatcher } from '../packages/shared/dist/nodeTools';
import { SessionWorkerHost } from './sessionWorkerHost';
import { SessionWorkerStore } from './sessionWorkerStore';
import { serializeSessionHistoryPayload } from './session/metadataStore';
import { LocalSessionTurnHost } from './sessionTurnRunner';

function id(): string { return `source_routing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }
async function model(session: any, name: string, args: any) {
  const message = await executeTools([{ id: id(), name, args }], { sessionId: session.id, session }, session);
  return message.parts.find(part => part.functionResponse)!.functionResponse!.response;
}

test.afterEach(async () => {
  setToolAuthorizationPolicyForTests(undefined);
  await nodeExecution.shutdownNodeExecution();
  nodeExecution.resetNodeExecutionForTests();
});
test.after(async () => {
  await shutdownToolScriptRuntime();
  await sessionRuntime.shutdownSessionRuntime();
});

test('Main source stays bound across real cwd settings updates at outer and inner authorization awaits', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-source-cwd-'));
  const allowed = path.join(root, 'allowed'); const outside = path.join(root, 'outside');
  await fs.ensureDir(allowed); await fs.ensureDir(outside);
  await fs.writeFile(path.join(allowed, 'source.py'), 'return {"source": "ALLOWED_SOURCE", "nested": call_tool("read", {"filePath": "nested.txt"})}');
  await fs.writeFile(path.join(outside, 'source.py'), 'return {"source": "OUTSIDE_SOURCE"}');
  await fs.writeFile(path.join(allowed, 'nested.txt'), 'NESTED_BEFORE_SETTINGS');
  await fs.writeFile(path.join(outside, 'nested.txt'), 'NESTED_AFTER_SETTINGS');
  const session = await sessionManager.getSession(id());
  await sessionRuntime.updateSettings(session.id, { currentNode: 'master', cwd: allowed });
  const rawPath = ' source.py ';
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`version: 1\ndefaultAction: deny\nrules:\n- id: source-starter\n  match: { tool: { source: builtin, name: run_script }, args: { filePath: ${JSON.stringify(rawPath)} }, path: { allWithin: ${JSON.stringify(allowed)} } }\n  action: allow\n- id: source-read\n  match: { tool: { source: node, name: read }, targetNode: master, args: { filePath: source.py }, path: { allWithin: ${JSON.stringify(allowed)} } }\n  action: allow\n- id: nested-read\n  match: { tool: { source: node, name: read }, targetNode: master, args: { filePath: nested.txt } }\n  action: allow\n`));
  try {
    const control = await model(session, 'run_script', { filePath: rawPath });
    assert.equal(control.result.source, 'ALLOWED_SOURCE');
    assert.equal(control.result.nested.content, 'NESTED_BEFORE_SETTINGS');
    for (const boundary of ['outer', 'read'] as const) {
      await sessionRuntime.updateSettings(session.id, { cwd: allowed });
      let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
      let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
      const originalGeneric = checks.checkGenericToolAuthorizationForSession;
      const originalRead = checks.checkToolPermissionForSession;
      let checkedPath: string | undefined;
      const pause = async (owner: any, identity: any, targetNode: string, args: any) => {
        checkedPath = buildToolAuthorizationRequest({ session: owner, tool: { source: identity.source, name: identity.tool }, targetNode, args }).paths[0].resolved;
        entered(); await held;
      };
      (checks as any).checkGenericToolAuthorizationForSession = async (owner: any, identity: any, targetNode: string, args: any, ...rest: any[]) => {
        const result = await (originalGeneric as any)(owner, identity, targetNode, args, ...rest);
        if (boundary === 'outer' && identity.source === 'builtin' && identity.tool === 'run_script') await pause(owner, identity, targetNode, args);
        return result;
      };
      (checks as any).checkToolPermissionForSession = async (owner: any, identity: any, targetNode: string, args: any, ...rest: any[]) => {
        const result = await (originalRead as any)(owner, identity, targetNode, args, ...rest);
        if (boundary === 'read' && identity.source === 'node' && identity.tool === 'read' && args.filePath === 'source.py') await pause(owner, identity, targetNode, args);
        return result;
      };
      let pending: Promise<any> | undefined;
      try {
        pending = model(session, 'run_script', { filePath: rawPath });
        await Promise.race([reached, pending.then(() => { throw new Error('Source completed before the authorization barrier'); })]);
        await sessionRuntime.updateSettings(session.id, { cwd: outside });
        release();
        const result = await pending;
        assert.equal(checkedPath, path.join(allowed, 'source.py'));
        assert.equal(result.result.source, 'ALLOWED_SOURCE');
        assert.equal(result.result.nested.content, 'NESTED_AFTER_SETTINGS', 'only source routing is frozen, not the VM owner or nested tools');
        assert.equal((await getToolScriptRunForTests(result.runId))?.filePath, rawPath, 'caller args and raw policy matchers are preserved');
        assert.equal(session.cwd, outside);
        await assert.rejects(() => tools.callTool('read', { filePath: 'source.py' }, { sessionId: session.id, session }), /denies.*read/i);
      } finally {
        release();
        (checks as any).checkGenericToolAuthorizationForSession = originalGeneric;
        (checks as any).checkToolPermissionForSession = originalRead;
        await pending?.catch(() => {});
      }
    }
  } finally { await fs.remove(root); }
});

test('Worker other-CLI source preserves authoritative no-cwd through actual selection, approval and transfer', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'script-worker-cli-routing-'));
  const cliRoot = path.join(root, 'cli-agent'); const oldCwd = path.join(cliRoot, 'old-cwd');
  await fs.ensureDir(oldCwd);
  await fs.writeFile(path.join(cliRoot, 'source.py'), 'return "NODE_DEFAULT_SOURCE"');
  await fs.writeFile(path.join(oldCwd, 'source.py'), 'return "STALE_MAIN_SOURCE"');
  const originalAgentDir = process.env.FOXWARM_AGENT_DIR;
  process.env.FOXWARM_AGENT_DIR = cliRoot;
  const nodeId = id(); const calls: any[] = []; const responses: any[] = []; const approvals: any[] = [];
  let legacy = false;
  const cli = new NodeClient({ host: 'http://fixture.invalid', nodeId, authToken: 'fixture-token', localTrigger: false,
    credentialsFile: path.join(root, 'credentials.json'),
    toolCallInterceptor: async (tool, args) => { approvals.push({ tool, args }); return true; },
  });
  (cli as any).send = (message: any) => {
    if (message.type === 'tool_call_response') {
      if (legacy) delete message.result[RESOLVED_PATH_SIDECAR];
      responses.push(structuredClone(message));
      nodesManager.handleToolResponse(message.callId, message.result, nodeId);
    } else if (message.type === 'tool_call_error') nodesManager.handleToolError(message.callId, message.error, undefined, nodeId);
    else if (message.type === 'file_read_response') {
      responses.push(structuredClone(message));
      nodesManager.handleFileReadResponse(message.transferId, message.file);
    } else if (message.type === 'file_transfer_error') nodesManager.handleFileTransferError(message.transferId, message.error);
  };
  const socket: any = { send: (raw: string) => {
    const message = JSON.parse(raw);
    if (message.type === 'registered') return;
    calls.push(message); void (cli as any).handleMessage(message);
  }, close: () => {} };
  const register = () => nodesManager.registerNodeWithTools(socket, {} as any, 'cli-node', {
    tools: [{ name: 'read', description: 'Fixture read' }], ...(!legacy ? { features: { programmaticToolData: true } } : {}),
  }, nodeId, negotiateNodeProtocol({ min: 1, max: 1 }, undefined, true));
  register();
  const other: NodeProviderDescriptor = { id: id(), kind: 'sandbox', provider: 'fixture', type: 'fixture', availability: 'ready', defaultCwd: 'fixture://default', primitiveBackends: { filesystem: 'read' } };
  const main = await sessionManager.getSession(id());
  await sessionRuntime.updateSettings(main.id, { currentNode: nodeId, cwd: oldCwd });
  const registry = new RpcServiceRegistry();
  registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({
    providerRegistry: new NodeProviderRegistry([new MasterNodeProvider(), new AuthenticatedRemoteNodeProvider(), {
      id: 'fixture', listNodes: () => [other], getNode: candidate => candidate === other.id ? other : undefined,
      invokeFilesystem: async () => { throw new Error('No filesystem operation expected on the selected other Node'); },
    }]), expectedSourceSessionId: main.id,
  }));
  const transport = new LocalRpcTransport(registry);
  await nodeExecution.initializeNodeExecution({ transport, placement: 'child-reverse' });
  const store = new SessionWorkerStore(path.join(root, 'worker.sqlite')); store.open();
  const incarnationId = id(); const ownership = store.beginGeneration(main.id, incarnationId);
  store.registerCandidate(main.id, ownership.generation, incarnationId, process.pid, 'fixture-process');
  store.activateCandidate(main.id, ownership.generation, incarnationId, process.pid, 'fixture-process');
  let durable = structuredClone(serializeSessionHistoryPayload(main)); let owner: any; let effects: any;
  const projections: any[] = [];
  const host = new SessionWorkerHost({ sessionId: main.id, generation: ownership.generation, incarnationId, pid: process.pid, processIdentity: 'fixture-process' }, store, {
    initialize: async () => {},
    persistence: { readState: async () => structuredClone(durable), writeState: async session => { durable = structuredClone(serializeSessionHistoryPayload(session)); } },
    publishCommitted: async projection => { projections.push(structuredClone(projection)); },
    createTurnHost: (currentEffects, session) => { effects = currentEffects; owner = session; return new LocalSessionTurnHost(currentEffects, session); },
  });
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes('version: 1\ndefaultAction: allow\nrules: []\n'));
  try {
    await host.loadProjection();
    const modern = await executeTools([
      { id: id(), name: 'node', args: { action: 'select', nodeId: other.id } },
      { id: id(), name: 'run_script', args: { node: nodeId, filePath: 'source.py' } },
    ], { sessionId: main.id }, owner, { currentSessionEffects: effects });
    const results = modern.parts.filter(part => part.functionResponse).map(part => part.functionResponse!.response);
    assert.equal(results[1].result, 'NODE_DEFAULT_SOURCE');
    assert.equal(owner.currentNode, other.id); assert.equal(owner.cwd, undefined);
    assert.equal(main.currentNode, nodeId); assert.equal(main.cwd, oldCwd, 'Main projection is legitimately stale while the Worker owns the Session');
    assert.equal(projections.at(-1).currentNode, other.id);
    assert.equal(durable.currentNode, other.id);
    assert.equal(Object.prototype.hasOwnProperty.call(calls.find(message => message.type === 'tool_call'), 'sessionCwd'), false);
    assert.equal(calls.some(message => message.type === 'file_read_request'), false, 'modern complete content needs no transfer');
    legacy = true; register();
    const callStart = calls.length; const responseStart = responses.length;
    const oldPeer = await executeTools([{ id: id(), name: 'run_script', args: { node: nodeId, filePath: 'source.py' } }], { sessionId: main.id }, owner, { currentSessionEffects: effects });
    assert.equal(oldPeer.parts.find(part => part.functionResponse)!.functionResponse!.response.result, 'NODE_DEFAULT_SOURCE');
    const oldCalls = calls.slice(callStart);
    assert.equal(oldCalls[0].type, 'tool_call'); assert.equal(oldCalls[0].args.filePath, 'source.py');
    assert.equal(Object.prototype.hasOwnProperty.call(oldCalls[0], 'sessionCwd'), false);
    assert.equal(oldCalls[1].type, 'file_read_request'); assert.equal(oldCalls[1].filePath, 'source.py');
    const oldResponses = responses.slice(responseStart);
    assert.match(oldResponses[0].result.output, /NODE_DEFAULT_SOURCE/);
    assert.doesNotMatch(oldResponses[0].result.output, /STALE_MAIN_SOURCE/);
    assert.match(Buffer.from(oldResponses[1].file.dataBase64, 'base64').toString('utf8'), /NODE_DEFAULT_SOURCE/);
    assert.equal(approvals.length, 2); assert.ok(approvals.every(item => item.tool === 'read' && item.args.filePath === 'source.py'));
  } finally {
    store.close(); nodesManager.unregisterNode(nodeId); setNodeToolSessionEventDispatcher(undefined);
    await nodeExecution.shutdownNodeExecution(); await transport.drain(); transport.close();
    if (originalAgentDir === undefined) delete process.env.FOXWARM_AGENT_DIR; else process.env.FOXWARM_AGENT_DIR = originalAgentDir;
    await fs.remove(root);
  }
});
