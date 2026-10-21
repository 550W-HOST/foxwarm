import '../testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as sessionManager from '../sessionManager';
import { artifact, call_tool } from '../tools';
import { tool_run_script } from '../toolscript';
import { createMainManagementToolServiceHandler } from '../mainManagementToolService';
import { shutdownMainManagementTools, resetMainManagementToolsForTests } from '../mainManagementTools';
import { artifactStore, tool_artifact } from './tool';
import * as nodeExecution from '../nodeExecution';
import fs from 'node:fs/promises';
const manifest = path.resolve('skills/data-visualization/examples/training-metrics.json');
test('direct, unified and ToolScript publication use Main authority and return persisted receipts', async () => {
  const id = `artifact_tool_${Date.now()}`, session = await sessionManager.getSession(id);
  const ctx: any = { sessionId: id, session, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  try {
    const a = await artifact({ action: 'publish', filePath: manifest }, ctx);
    const b: any = await call_tool({ toolId: 'builtin:artifact', args: { action: 'publish', filePath: manifest } }, ctx);
    const script = await tool_run_script({ code: 'return call_tool("builtin:artifact", {"action":"publish", "filePath":args["path"]})', args: { path: manifest } }, ctx);
    assert.equal(script.status, 'completed');
    const c: any = script.result;
    for (const result of [a, b, c]) {
      assert.equal(result.artifact.sessionId, id);
      assert.equal((await artifactStore.read(result.artifact.artifactId, 1, id)).document.title, 'Training success rate');
    }
    const prepared: any = await call_tool({ toolId: 'builtin:artifact', args: { action: 'prepare', filePath: manifest } }, ctx);
    assert.equal(prepared.artifact, undefined); assert.equal(prepared.preparedArtifact.sessionId, id);
    assert.match(prepared.marker, /^<foxwarm-artifact id="art_[a-f0-9]{32}" revision="1" \/>$/);
    const sharp = (await import('sharp')).default;
    const imagePath = path.join(process.env.FOXWARM_DATA_DIR!, 'test-artifact.png');
    const imageBytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#397eee' } }).png().toBuffer();
    await fs.writeFile(imagePath, imageBytes);
    const image: any = await call_tool({ toolId: 'builtin:artifact', args: { action: 'prepare', type: 'image', title: 'Figure', filePath: imagePath } }, ctx);
    assert.equal(image.artifact, undefined); assert.equal(image.preparedArtifact.type, 'image');
    await fs.rm(imagePath);
    assert.deepEqual((await artifactStore.resource(image.preparedArtifact.artifactId, 1, id, 'image')).bytes, imageBytes, 'snapshot survives source deletion');
    const got: any = await call_tool({ toolId: 'builtin:artifact', args: { action: 'get', artifactId: a.artifact.artifactId } }, ctx);
    assert.equal(JSON.parse(got.output).revision, 1); assert.equal(got.artifact, undefined);
    const revised = await artifact({ action: 'publish', filePath: manifest, artifactId: a.artifact.artifactId, expectedRevision: 1 }, ctx);
    assert.equal(revised.artifact.revision, 2);
    await assert.rejects(artifact({ action: 'publish', filePath: manifest, artifactId: a.artifact.artifactId, expectedRevision: 1 }, ctx), /Revision conflict/);
    const handler = createMainManagementToolServiceHandler({ expectedSourceSessionId: id });
    await assert.rejects((handler.execute as any)({ sourceSessionId: 'not-owner', operation: 'artifact', args: { action: 'publish', filePath: manifest } }), /source|Source/);
  } finally {
    await shutdownMainManagementTools(); resetMainManagementToolsForTests();
    await sessionManager.deleteSession(id);
  }
});
test('remote manifests use Node read facade with exact source cwd; explicit other Node does not inherit cwd', async () => {
  const original = nodeExecution.readNodeFile, calls: any[] = [];
  (nodeExecution as any).readNodeFile = async (...args: any[]) => { calls.push(args); return fs.readFile(manifest, 'utf8'); };
  try {
    const ctx: any = { sessionId: 'test-routing', session: { id: 'test-routing', agent: 'main', currentNode: 'remote-a', cwd: '/project' } };
    const a = await tool_artifact({ action: 'publish', filePath: 'plot.json' }, ctx);
    assert.equal(a.artifact.sessionId, 'test-routing');
    assert.deepEqual(calls[0].slice(0, 4), ['test-routing', 'remote-a', 'plot.json', { currentNode: 'remote-a', cwd: '/project' }]);
    await tool_artifact({ action: 'publish', node: 'remote-b', filePath: 'plot.json' }, ctx);
    assert.deepEqual(calls[1][3], { currentNode: 'remote-b' });
  } finally { (nodeExecution as any).readNodeFile = original; }
});

test('primitive artifact sources enforce byte bounds before reads, retain qualified routing and read policy', async () => {
  const { NodeProviderRegistry } = await import('../nodes/providerRegistry');
  const { nodeProviderRegistry } = await import('../nodes/providers');
  const { nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler } = await import('../nodeExecutionService');
  const { RpcServiceRegistry, LocalRpcTransport } = await import('../rpc');
  const { setToolAuthorizationPolicyForTests } = await import('../toolAuthorization');
  const providerId = 'p'.repeat(64), nodeId = `${providerId}/${'n'.repeat(128)}`;
  const id = `artifact_primitive_${Date.now()}`;
  const session = await sessionManager.getSession(id);
  session.currentNode = nodeId;
  session.cwd = 'urn:project';
  await sessionManager.saveSession(id);
  const document = await fs.readFile(manifest);
  let bytes: Buffer = document;
  let declaredSize = bytes.length;
  const calls: any[] = [];
  const descriptor: any = { id: nodeId, provider: providerId, kind: 'sandbox', type: 'memory', availability: 'ready', primitiveBackends: { filesystem: 'read' } };
  const providers = new NodeProviderRegistry([{
    id: providerId,
    listNodes: () => [descriptor],
    getNode: target => target === nodeId ? descriptor : undefined,
    async invokeFilesystem(request) {
      calls.push(request);
      if (request.operation === 'stat') return { kind: 'file', size: declaredSize, modifiedAtMs: 1 };
      if (request.operation === 'read') return { dataBase64: bytes.subarray(request.offset, request.offset! + request.count!).toString('base64') };
      throw new Error('Unexpected primitive');
    },
  }]);
  const registry = new RpcServiceRegistry();
  registry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ expectedSourceSessionId: id, providerRegistry: providers }));
  const transport = new LocalRpcTransport(registry);
  const originalRead = nodeProviderRegistry.readFile;
  nodeProviderRegistry.readFile = providers.readFile.bind(providers);
  await nodeExecution.initializeNodeExecution({ transport, placement: 'child-reverse' });
  const ctx: any = { sessionId: id, session, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  try {
    const prepared: any = await call_tool({ toolId: 'builtin:artifact', args: { action: 'prepare', node: nodeId, filePath: 'urn:plot' } }, ctx);
    assert.equal(prepared.preparedArtifact.type, 'chart');
    assert.equal(nodeId.length, 193);
    assert.ok(calls.every(call => call.nodeId === nodeId && call.sourceSessionId === id && call.context.cwd === 'urn:project'));
    bytes = Buffer.concat([document, Buffer.alloc(2 * 1024 * 1024 - document.length, ' ')]);
    declaredSize = bytes.length;
    const exact: any = await call_tool({ toolId: 'builtin:artifact', args: { action: 'prepare', filePath: 'urn:exact-limit' } }, ctx);
    assert.equal(exact.preparedArtifact.type, 'chart', 'a source exactly at the bound remains accepted');
    const sharp = (await import('sharp')).default;
    bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#397eee' } }).png().toBuffer();
    declaredSize = bytes.length;
    const image: any = await call_tool({ toolId: 'builtin:artifact', args: { action: 'prepare', type: 'image', filePath: 'urn:figure.png' } }, ctx);
    assert.deepEqual((await artifactStore.resource(image.preparedArtifact.artifactId, 1, id, 'image')).bytes, bytes);
    for (const [type, size] of [[undefined, 8 * 1024 * 1024], ['image', 16 * 1024 * 1024]] as const) {
      bytes = Buffer.alloc(size); declaredSize = bytes.length; calls.length = 0;
      await assert.rejects(call_tool({ toolId: 'builtin:artifact', args: { action: 'prepare', filePath: 'urn:oversized', ...(type ? { type } : {}) } }, ctx), /exceeds/);
      assert.deepEqual(calls.map(call => call.operation), ['stat'], 'honest oversized file is rejected without reading any bytes');
      console.log('oversized-source', JSON.stringify({ type: type || 'manifest', declaredSize, statCalls: calls.length, readCalls: 0, bytesRead: 0 }));
    }
    // A source growing after stat still cannot make Core consume its whole size.
    bytes = Buffer.alloc(8 * 1024 * 1024); declaredSize = document.length; calls.length = 0;
    await assert.rejects(call_tool({ toolId: 'builtin:artifact', args: { action: 'prepare', filePath: 'urn:growing' } }, ctx), /exceeds/);
    const consumed = calls.filter(call => call.operation === 'read').reduce((sum, call) => sum + call.count, 0);
    assert.equal(consumed, 2 * 1024 * 1024 + 1);
    console.log('growing-source', JSON.stringify({ declaredSize, actualSize: bytes.length, requestedBytes: consumed }));
    calls.length = 0;
    setToolAuthorizationPolicyForTests({ version: 1, defaultAction: 'allow', rules: [{ id: 'deny-source', enabled: true, match: { tool: { source: 'node', name: 'read' } }, action: 'deny' }] });
    await assert.rejects(call_tool({ toolId: 'builtin:artifact', args: { action: 'prepare', filePath: 'urn:denied' } }, ctx), /den(?:ied|ies)/i);
    assert.equal(calls.length, 0, 'read authorization rejects before provider lookup or reads');
  } finally {
    setToolAuthorizationPolicyForTests(undefined);
    nodeProviderRegistry.readFile = originalRead;
    await nodeExecution.shutdownNodeExecution(); nodeExecution.resetNodeExecutionForTests();
    await transport.drain(); transport.close();
    await shutdownMainManagementTools(); resetMainManagementToolsForTests();
    await sessionManager.deleteSession(id);
  }
});
