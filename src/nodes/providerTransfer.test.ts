import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import * as fileDelivery from '../fileDelivery';
import { getImageWriteHandoffRoot } from '../imageWriteHandoff';
import { createHash } from 'node:crypto';
import * as sessionManager from '../sessionManager';
import { ExecutableNodeProvider, EXECUTABLE_NODE_PROVIDER_MAX_REQUEST_BYTES } from './executableProvider';
import { MasterNodeProvider, AuthenticatedRemoteNodeProvider, NodeProviderRegistry } from './providerRegistry';
import { nodeProviderRegistry } from './providers';
import * as nodeExecution from '../nodeExecution';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from '../nodeExecutionService';
import { createFileDeliveryServiceHandler, fileDeliveryServiceDescriptor } from '../fileDeliveryService';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from '../rpc';
import { callTool } from '../tools';
import { getAgentDir } from '../config';
import { parseToolAuthorizationPolicyBytes, setToolAuthorizationPolicyForTests } from '../toolAuthorization';
import { MAX_CORE_NODE_ID_LENGTH } from '../../packages/shared/dist/nodeIdentity';
import { NODE_TRANSFER_CHUNK_BYTES } from '../../packages/shared/dist/nodeFileTransfer';

async function fixture(run: (value: {
  root: string; main: string; left: string; right: string; readOnly: string; broken: string;
  roots: Record<string, string>; providers: NodeProviderRegistry; sourceId: string; session: any;
}) => Promise<void>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-transfer-'));
  const roots: Record<string, string> = {};
  const adapters = await Promise.all([
    ['machines', 'multi-node'], ['read-only', 'read-only'], ['broken', 'fail-append'],
  ].map(async ([name, mode]) => {
    roots[name] = path.join(root, name);
    await fs.ensureDir(path.join(roots[name], 'cwd'));
    return new ExecutableNodeProvider({ id: `transfer-${name}`, type: 'executable', command: process.execPath,
      args: [path.join(__dirname, 'primitiveExecTestFixture.js'), roots[name], mode, `${name}-local`], timeoutMs: 5000 });
  }));
  roots.left = path.join(roots.machines, 'left-local');
  roots.right = path.join(roots.machines, 'right-local');
  await fs.ensureDir(path.join(roots.left, 'cwd'));
  await fs.ensureDir(path.join(roots.right, 'cwd'));
  const providers = new NodeProviderRegistry([new MasterNodeProvider(), new AuthenticatedRemoteNodeProvider(), ...adapters]);
  const topology = await providers.listNodes();
  const id = (name: string) => topology.find(node => ['left', 'right'].includes(name) ? node.label === `${name}-local` : node.provider === `transfer-${name}`)!.id;
  const sourceId = `provider-transfer-source-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const session = await sessionManager.getSession(sourceId);
  session.currentNode = id('left');
  session.cwd = 'fixture://elsewhere';
  await sessionManager.saveSession(sourceId);
  const main = path.join(getAgentDir(session.agent), `transfer-${path.basename(root)}`);
  await fs.ensureDir(main);
  const originals = { read: nodeProviderRegistry.readTransferFile, write: nodeProviderRegistry.writeTransferFile };
  nodeProviderRegistry.readTransferFile = request => providers.readTransferFile(request);
  nodeProviderRegistry.writeTransferFile = request => providers.writeTransferFile(request);
  const services = new RpcServiceRegistry();
  services.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ expectedSourceSessionId: sourceId, providerRegistry: providers }));
  await nodeExecution.initializeNodeExecution({ transport: new LocalRpcTransport(services) });
  try {
    await run({ root, main, roots, providers, sourceId, session, left: id('left'), right: id('right'), readOnly: id('read-only'), broken: id('broken') });
  } finally {
    setToolAuthorizationPolicyForTests(undefined);
    nodeProviderRegistry.readTransferFile = originals.read;
    nodeProviderRegistry.writeTransferFile = originals.write;
    await nodeExecution.shutdownNodeExecution();
    nodeExecution.resetNodeExecutionForTests();
    await providers.shutdown();
    await sessionManager.deleteSession(sourceId).catch(() => false);
    await fs.remove(root);
    await fs.remove(main);
  }
}

async function requests(root: string): Promise<any[]> {
  const file = path.join(root, 'requests.jsonl');
  return await fs.pathExists(file) ? (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}
const bytes = Buffer.from([0, 255, 0xc3, 0x28, 13, 10, 0, 128, 240, 159, 166, 138]);
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');

// Real executable providers own separate roots. No fixture imports private Core code.
test('canonical copy supports Main and both primitive endpoints, preserving binary/empty bytes, defaults and overwrite refusal', async () => fixture(async f => {
  const source = path.join(f.main, 'source.bin');
  await fs.writeFile(source, bytes);
  const mainRelative = path.relative(getAgentDir(f.session.agent), source);
  const ctx = { sessionId: f.sourceId, session: f.session };
  const first: any = await callTool('copy_between_nodes', {
    sourceNode: 'master', sourcePath: mainRelative, targetNode: f.left, targetPath: 'nested/source.bin',
  }, ctx);
  assert.match(String(first), new RegExp(digest(bytes)));
  assert.deepEqual(await fs.readFile(path.join(f.roots.left, 'cwd/nested/source.bin')), bytes);
  await assert.rejects(() => callTool('copy_between_nodes', {
    sourceNode: 'master', sourcePath: mainRelative, targetNode: f.left, targetPath: 'nested/source.bin',
  }, ctx), /already exists/);
  assert.deepEqual(await fs.readFile(path.join(f.roots.left, 'cwd/nested/source.bin')), bytes);
  await fs.ensureDir(path.join(f.roots.left, 'elsewhere/nested'));
  await fs.writeFile(path.join(f.roots.left, 'elsewhere/nested/source.bin'), 'wrong Session cwd');
  const across = await nodeExecution.copyBetweenNodes(f.sourceId, {
    sourceNode: f.left, sourcePath: 'nested/source.bin', targetNode: f.right, targetPath: 'binary.bin',
  });
  assert.equal(across.sha256, digest(bytes));
  assert.equal(across.sizeBytes, bytes.length);
  assert.equal(across.absolutePath, undefined, 'Core does not fabricate a native path for an opaque namespace');
  assert.deepEqual(await fs.readFile(path.join(f.roots.right, 'cwd/binary.bin')), bytes);
  const back = await nodeExecution.copyBetweenNodes(f.sourceId, {
    sourceNode: f.right, sourcePath: 'binary.bin', targetNode: 'master', targetPath: `${path.relative(getAgentDir(f.session.agent), f.main)}/returned.bin`,
  });
  assert.equal(back.absolutePath, path.join(f.main, 'returned.bin'));
  assert.deepEqual(await fs.readFile(back.absolutePath!), bytes);
  await nodeExecution.copyBetweenNodes(f.sourceId, { sourceNode: f.left, sourcePath: 'nested/source.bin', targetNode: f.broken, targetPath: 'cross-provider.bin' });
  assert.deepEqual(await fs.readFile(path.join(f.roots.broken, 'cwd/cross-provider.bin')), bytes);
  await fs.writeFile(path.join(f.roots.left, 'cwd/empty.bin'), Buffer.alloc(0));
  const empty = await nodeExecution.copyBetweenNodes(f.sourceId, {
    sourceNode: f.left, sourcePath: 'empty.bin', targetNode: f.right, targetPath: 'binary.bin', overwrite: true,
  });
  assert.equal(empty.overwritten, true);
  assert.equal(empty.sizeBytes, 0);
  assert.equal(empty.sha256, digest(Buffer.alloc(0)));
  assert.deepEqual(await fs.readFile(path.join(f.roots.right, 'cwd/binary.bin')), Buffer.alloc(0));
  for (const name of ['left', 'right']) {
    const calls = (await requests(f.roots[name])).filter(call => call.operation === 'filesystem');
    assert.ok(calls.length > 0);
    for (const call of calls) {
      assert.equal(call.request.nodeId, `${name}-local`, 'the adapter receives its local ID, even with qualified public IDs');
      assert.equal('cwd' in call.request, false, 'transfers use the environment default, not Session or other-Node cwd');
      assert.equal('sourceSessionId' in call.request, false);
      assert.equal('agent' in call.request, false);
    }
  }
}));

test('12 MiB primitive copying uses bounded read/write chunks rather than a new whole-file envelope limit', async () => fixture(async f => {
  const large = Buffer.alloc(12 * 1024 * 1024 + 7);
  for (let i = 0; i < large.length; i += 1) large[i] = (i * 31) & 255;
  await fs.writeFile(path.join(f.main, 'large.bin'), large);
  const input = path.relative(getAgentDir(f.session.agent), path.join(f.main, 'large.bin'));
  await nodeExecution.copyBetweenNodes(f.sourceId, { sourceNode: 'master', sourcePath: input, targetNode: f.left, targetPath: 'large.bin' });
  const copied = await nodeExecution.copyBetweenNodes(f.sourceId, { sourceNode: f.left, sourcePath: 'large.bin', targetNode: f.right, targetPath: 'large.bin' });
  assert.equal(copied.sizeBytes, large.length);
  assert.equal(copied.sha256, digest(large));
  assert.deepEqual(await fs.readFile(path.join(f.roots.right, 'cwd/large.bin')), large);
  const readCalls = (await requests(f.roots.left)).filter(call => call.operation === 'filesystem' && call.request.operation === 'read');
  assert.ok(readCalls.length >= 12);
  assert.ok(readCalls.every(call => call.request.count <= NODE_TRANSFER_CHUNK_BYTES));
  const writeCalls = (await requests(f.roots.right)).filter(call => call.operation === 'filesystem' && call.request.operation === 'write');
  assert.equal(writeCalls[0].request.flag, 'wx');
  assert.ok(writeCalls.length >= 12);
  assert.ok(writeCalls.slice(1).every(call => call.request.flag === 'a'));
  assert.ok(writeCalls.every(call => Buffer.from(call.request.contentBase64, 'base64').length <= NODE_TRANSFER_CHUNK_BYTES));
  assert.ok(writeCalls.every(call => Buffer.byteLength(JSON.stringify(call)) < EXECUTABLE_NODE_PROVIDER_MAX_REQUEST_BYTES));
  assert.equal('dataBase64' in copied, false, 'the fixed copy reply remains a bounded receipt, not file bytes');
}));

test('primitive read-only targets reject copy and later append failures retain only the normal written prefix', async () => fixture(async f => {
  const content = Buffer.alloc(NODE_TRANSFER_CHUNK_BYTES + 23, 0xfa);
  await fs.writeFile(path.join(f.roots.left, 'cwd/source.bin'), content);
  await assert.rejects(() => nodeExecution.copyBetweenNodes(f.sourceId, {
    sourceNode: f.left, sourcePath: 'source.bin', targetNode: f.readOnly, targetPath: 'refused.bin',
  }), /not available/);
  assert.equal(await fs.pathExists(path.join(f.roots['read-only'], 'cwd/refused.bin')), false);
  await assert.rejects(() => nodeExecution.copyBetweenNodes(f.sourceId, {
    sourceNode: f.left, sourcePath: 'source.bin', targetNode: f.broken, targetPath: 'partial.bin',
  }), /Controlled append failure/);
  assert.deepEqual(await fs.readFile(path.join(f.roots.broken, 'cwd/partial.bin')), content.subarray(0, NODE_TRANSFER_CHUNK_BYTES));
  const writes = (await requests(f.roots.broken)).filter(call => call.operation === 'filesystem' && call.request.operation === 'write');
  assert.deepEqual(writes.map(call => call.request.flag), ['wx', 'a'], 'no retry, replay, rollback or fabricated successful receipt');
}));

test('copy effect fences exact source and either denied endpoint before any provider file IO', async () => fixture(async f => {
  const services = new RpcServiceRegistry();
  services.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ expectedSourceSessionId: f.sourceId, providerRegistry: f.providers }));
  const transport = new LocalRpcTransport(services);
  const client = new RpcClient(nodeExecutionServiceDescriptor, transport);
  try {
    await assert.rejects(() => client.call('copy', { sourceSessionId: 'another-source', sourceNode: f.left, sourcePath: 'a', targetNode: f.right, targetPath: 'b' }), { code: 'NODE_EXECUTION_SOURCE_MISMATCH' });
    for (const endpoint of ['sourceNode', 'targetNode']) {
      setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`version: 1\ndefaultAction: allow\nrules:\n- id: denied-endpoint\n  match:\n    tool: { source: builtin, name: copy_between_nodes }\n    args: { ${endpoint}: { equals: master } }\n  action: deny\n`));
      await assert.rejects(() => client.call('copy', { sourceSessionId: f.sourceId,
        sourceNode: endpoint === 'sourceNode' ? 'master' : f.left, sourcePath: 'a',
        targetNode: endpoint === 'targetNode' ? 'master' : f.right, targetPath: 'b' }), /denies builtin capability/);
    }
    for (const name of ['left', 'right']) assert.deepEqual((await requests(f.roots[name])).filter(call => call.operation === 'filesystem'), []);
  } finally { await transport.drain(); transport.close(); }
}));

test('Provider delivery reads the same binary path on Main, keeps its cache/receipt and sends only intent over reverse RPC', async () => fixture(async f => {
  await fs.writeFile(path.join(f.roots.right, 'cwd/delivery.bin'), bytes);
  const original = nodeProviderRegistry.readTransferFile;
  nodeProviderRegistry.readTransferFile = request => f.providers.readTransferFile(request);
  const services = new RpcServiceRegistry();
  services.register(fileDeliveryServiceDescriptor, createFileDeliveryServiceHandler({ expectedSourceSessionId: f.sourceId }));
  const transport = new LocalRpcTransport(services);
  const client = new RpcClient(fileDeliveryServiceDescriptor, transport);
  const cached: string[] = [];
  try {
    const result: any = await callTool('send_file', { node: f.right, filePath: 'delivery.bin', channelTargetId: 'webui:transfer' }, { sessionId: f.sourceId, session: f.session });
    cached.push(result.fullPath);
    assert.deepEqual(await fs.readFile(result.fullPath), bytes);
    assert.equal(result.fileDelivery.sourceNodeId, f.right);
    assert.equal(result.fileDelivery.downloadNodeId, 'master');
    const intent = { sourceSessionId: f.sourceId, intent: { filePath: 'delivery.bin', channelTargetId: 'webui:transfer' },
      routing: { runtimeNodeId: f.right, currentNode: f.left, cwd: 'fixture://elsewhere' } };
    assert.ok(Buffer.byteLength(JSON.stringify(intent)) < 4096);
    assert.equal(JSON.stringify(intent).includes(bytes.toString('base64')), false);
    const reverse = await client.call('deliver', intent);
    cached.push(reverse.fullPath);
    assert.deepEqual(await fs.readFile(reverse.fullPath), bytes);
    assert.equal(reverse.fileDelivery?.sourceNodeId, f.right);
    assert.equal(reverse.fileDelivery?.downloadPath, reverse.fullPath);
    assert.equal(reverse.fileDelivery?.sizeBytes, bytes.length);
    await assert.rejects(() => client.call('deliver', { ...intent, sourceSessionId: 'another-source' }), { code: 'FILE_DELIVERY_SOURCE_MISMATCH' });
  } finally {
    nodeProviderRegistry.readTransferFile = original;
    await transport.drain(); transport.close();
    for (const file of cached) await fs.remove(file);
  }
}));


test('Main and Worker write the same owned image under image-target authorization without arbitrary Main copy privilege', async () => fixture(async f => {
  const image = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#ff00ff' } }).png().toBuffer();
  f.session.history.push({ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: image.toString('base64') },
    imageMeta: { imageId: 'owned-transfer-image', mimeType: 'image/png' } }] });
  await sessionManager.saveSession(f.session);
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`version: 1\ndefaultAction: deny\nrules:\n- id: owned-image-write\n  match:\n    tool: { source: builtin, name: image_write_to_file }\n    args: { overwrite: { exists: false } }\n  action: allow\n`));
  const services = new RpcServiceRegistry();
  services.register(fileDeliveryServiceDescriptor, createFileDeliveryServiceHandler({ expectedSourceSessionId: f.sourceId }));
  const transport = new LocalRpcTransport(services);
  const client = new RpcClient(fileDeliveryServiceDescriptor, transport);
  await fileDelivery.initializeFileDelivery({ transport, placement: 'child-reverse' });
  const originalWrite = fileDelivery.writeImageArtifact;
  const originalLookup = sessionManager.getExistingSession;
  let captured: any;
  (fileDelivery as any).writeImageArtifact = async (request: any) => { captured = request; return originalWrite(request); };
  (sessionManager as any).getExistingSession = async () => { throw new Error('Main must not hydrate Worker authority for an image artifact.'); };
  const ownerRoot = getImageWriteHandoffRoot(f.session.agent, f.sourceId);
  const otherRoot = getImageWriteHandoffRoot(f.session.agent, `${f.sourceId}-other`);
  try {
    const ctx: any = { sessionId: f.sourceId, session: f.session, persistCurrentSession: async () => sessionManager.saveSession(f.session) };
    const target = 'photo.version\\backup';
    const destination = path.join(f.roots.right, 'cwd', target);
    await callTool('image_write_to_file', { id: 'owned-transfer-image', filePath: target, node: f.right }, ctx);
    assert.deepEqual(await fs.readFile(destination), image);
    await fs.remove(destination);
    await callTool('image_write_to_file', { id: 'owned-transfer-image', filePath: target, node: f.right }, { ...ctx, sessionPlacement: 'session-worker' });
    assert.deepEqual(await fs.readFile(destination), image);
    assert.equal(captured.intent.filePath, target, 'opaque target paths reach the Provider unchanged in either placement');
    assert.equal(path.basename(captured.artifactPath), 'image', 'private staging names do not inherit target path syntax');
    assert.equal(captured.routing.runtimeNodeId, f.right);
    assert.equal(captured.routing.currentNode, f.left);
    assert.equal(captured.intent.id, 'owned-transfer-image');
    assert.equal('overwrite' in captured.intent, false, 'effect authorization preserves an omitted original argument');
    assert.equal('sourceNode' in captured, false);
    assert.equal(JSON.stringify(captured).includes(image.toString('base64')), false, 'reverse image writing sends intent/artifact location, not bytes');
    assert.equal(await fs.pathExists(captured.artifactPath), false, 'the Worker removes its owned handoff file after completion');
    await assert.rejects(() => nodeExecution.copyBetweenNodes(f.sourceId, { sourceNode: 'master', sourcePath: 'arbitrary', targetNode: f.right, targetPath: 'forbidden.bin' }), /denies builtin capability/);
    const bad = { ...captured, intent: { ...captured.intent, filePath: 'must-not-exist.png' } };
    await assert.rejects(() => client.call('writeImageArtifact', { ...bad, sourceSessionId: 'another-source' }), { code: 'FILE_DELIVERY_SOURCE_MISMATCH' });
    const outside = path.join(f.main, 'not-an-image-artifact.bin');
    await fs.writeFile(outside, 'not an owned image');
    await assert.rejects(() => client.call('writeImageArtifact', { ...bad, artifactPath: outside }), /outside this Session-owned operation/);
    await fs.ensureDir(path.join(otherRoot, 'operation-other'));
    const otherFile = path.join(otherRoot, 'operation-other/image');
    await fs.writeFile(otherFile, 'another Session artifact');
    await assert.rejects(() => client.call('writeImageArtifact', { ...bad, artifactPath: otherFile }), /outside this Session-owned operation/);
    const operation = path.join(ownerRoot, 'operation-linked');
    await fs.ensureDir(operation);
    await fs.symlink(outside, path.join(operation, 'image'));
    await assert.rejects(() => client.call('writeImageArtifact', { ...bad, artifactPath: path.join(operation, 'image') }), /real directories\/files/);
    await fs.remove(operation);
    const directory = path.join(f.main, 'outside-operation');
    await fs.ensureDir(directory); await fs.writeFile(path.join(directory, 'image'), 'outside');
    await fs.symlink(directory, operation, 'dir');
    await assert.rejects(() => client.call('writeImageArtifact', { ...bad, artifactPath: path.join(operation, 'image') }), /real directories\/files/);
    assert.equal(await fs.pathExists(path.join(f.roots.right, 'cwd/must-not-exist.png')), false);
  } finally {
    (fileDelivery as any).writeImageArtifact = originalWrite;
    (sessionManager as any).getExistingSession = originalLookup;
    await fileDelivery.shutdownFileDelivery(); fileDelivery.resetFileDeliveryForTests();
    await transport.drain(); transport.close();
    await fs.remove(ownerRoot); await fs.remove(otherRoot);
  }
}));


test('Provider-only policy checks real copy effects on every endpoint and preserves Worker caller-current facts', async () => fixture(async f => {
  const providerId = (await f.providers.resolveNode(f.left))!.provider.id;
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`version: 1\ndefaultAction: deny\nrules:\n- session: ${JSON.stringify(f.sourceId)}\n  node: { provider: ${JSON.stringify(providerId)} }\n  action: allow\n`));
  await fs.writeFile(path.join(f.roots.left, 'cwd/allowed.bin'), bytes);
  const masterSource = path.join(f.main, 'master-source.bin');
  await fs.writeFile(masterSource, 'Main must not become a permitted leg');
  const ctx: any = { sessionId: f.sourceId, session: f.session };
  await callTool('copy_between_nodes', { sourceNode: f.left, sourcePath: 'allowed.bin', targetNode: f.right, targetPath: 'allowed.bin' }, ctx);
  assert.deepEqual(await fs.readFile(path.join(f.roots.right, 'cwd/allowed.bin')), bytes);
  for (const intent of [
    { sourceNode: 'master', sourcePath: masterSource, targetNode: f.right, targetPath: 'forbidden-master-source.bin' },
    { sourceNode: f.left, sourcePath: 'allowed.bin', targetNode: 'master', targetPath: path.join(f.main, 'forbidden-master-target.bin') },
    { sourceNode: f.left, sourcePath: 'allowed.bin', targetNode: f.broken, targetPath: 'forbidden-provider.bin' },
  ]) await assert.rejects(() => callTool('copy_between_nodes', intent, ctx), /denies builtin capability/);
  assert.equal(await fs.pathExists(path.join(f.roots.right, 'cwd/forbidden-master-source.bin')), false);
  assert.equal(await fs.pathExists(path.join(f.main, 'forbidden-master-target.bin')), false);
  assert.equal(await fs.pathExists(path.join(f.roots.broken, 'cwd/forbidden-provider.bin')), false);
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`version: 1\ndefaultAction: deny\nrules:\n- session: ${JSON.stringify(f.sourceId)}\n  node: { current: true }\n  action: allow\n`));
  const hot = { ...f.session, currentNode: f.right };
  await callTool('copy_between_nodes', { sourceNode: f.right, sourcePath: 'allowed.bin', targetNode: f.right, targetPath: 'worker-current.bin' }, {
    sessionId: f.sourceId, session: hot, sessionPlacement: 'session-worker', persistCurrentSession: async () => {},
  });
  assert.deepEqual(await fs.readFile(path.join(f.roots.right, 'cwd/worker-current.bin')), bytes);
  assert.equal(f.session.currentNode, f.left, 'trusted Worker caller-current facts do not mutate Main catalog authority');
}));

test('Provider-only image permission is target-local for both Main and the private Worker handoff', async () => fixture(async f => {
  const providerId = (await f.providers.resolveNode(f.left))!.provider.id;
  setToolAuthorizationPolicyForTests(parseToolAuthorizationPolicyBytes(`version: 1\ndefaultAction: deny\nrules:\n- session: ${JSON.stringify(f.sourceId)}\n  node: { provider: ${JSON.stringify(providerId)} }\n  action: allow\n`));
  const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#112233' } }).png().toBuffer();
  f.session.history.push({ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: image.toString('base64') }, imageMeta: { imageId: 'provider-only-image', mimeType: 'image/png' } }] });
  await sessionManager.saveSession(f.session);
  const services = new RpcServiceRegistry();
  services.register(fileDeliveryServiceDescriptor, createFileDeliveryServiceHandler({ expectedSourceSessionId: f.sourceId }));
  const transport = new LocalRpcTransport(services);
  await fileDelivery.initializeFileDelivery({ transport, placement: 'child-reverse' });
  try {
    const ctx: any = { sessionId: f.sourceId, session: f.session, persistCurrentSession: async () => sessionManager.saveSession(f.session) };
    await callTool('image_write_to_file', { id: 'provider-only-image', node: f.right, filePath: 'provider-main.png' }, ctx);
    await callTool('image_write_to_file', { id: 'provider-only-image', node: f.right, filePath: 'provider-worker.png' }, { ...ctx, sessionPlacement: 'session-worker' });
    assert.deepEqual(await fs.readFile(path.join(f.roots.right, 'cwd/provider-main.png')), image);
    assert.deepEqual(await fs.readFile(path.join(f.roots.right, 'cwd/provider-worker.png')), image);
    await assert.rejects(() => nodeExecution.copyBetweenNodes(f.sourceId, { sourceNode: 'master', sourcePath: 'not-an-image-source', targetNode: f.right, targetPath: 'forbidden-copy' }), /denies builtin capability/);
  } finally {
    await fileDelivery.shutdownFileDelivery(); fileDelivery.resetFileDeliveryForTests();
    await transport.drain(); transport.close();
    await fs.remove(getImageWriteHandoffRoot(f.session.agent, f.sourceId));
  }
}));

test('maximum qualified IDs survive Provider delivery receipts and Worker image routing without leaking bytes', async () => fixture(async f => {
  const root = path.join(f.root, 'maximum-id');
  await fs.ensureDir(path.join(root, 'cwd'));
  await fs.writeFile(path.join(root, 'cwd/source.bin'), bytes);
  const provider = new ExecutableNodeProvider({ id: 'p'.repeat(64), type: 'executable', command: process.execPath,
    args: [path.join(__dirname, 'primitiveExecTestFixture.js'), root, 'normal', 'n'.repeat(128)], timeoutMs: 5000 });
  const registry = new NodeProviderRegistry([provider]);
  const id = (await registry.listNodes())[0].id;
  assert.equal(id.length, MAX_CORE_NODE_ID_LENGTH);
  const originalRead = nodeProviderRegistry.readTransferFile;
  const originalWrite = nodeProviderRegistry.writeTransferFile;
  nodeProviderRegistry.readTransferFile = request => registry.readTransferFile(request);
  nodeProviderRegistry.writeTransferFile = request => registry.writeTransferFile(request);
  const services = new RpcServiceRegistry();
  services.register(fileDeliveryServiceDescriptor, createFileDeliveryServiceHandler({ expectedSourceSessionId: f.sourceId }));
  const transport = new LocalRpcTransport(services);
  const client = new RpcClient(fileDeliveryServiceDescriptor, transport);
  const cached: string[] = [];
  await fileDelivery.initializeFileDelivery({ transport, placement: 'child-reverse' });
  try {
    const main: any = await callTool('send_file', { node: id, filePath: 'source.bin', channelTargetId: 'webui:maximum-node' }, { sessionId: f.sourceId, session: f.session });
    cached.push(main.fullPath);
    assert.equal(main.fileDelivery.sourceNodeId, id);
    assert.deepEqual(await fs.readFile(main.fullPath), bytes);
    const reverse = await client.call('deliver', { sourceSessionId: f.sourceId, intent: { filePath: 'source.bin', channelTargetId: 'webui:maximum-node' }, routing: { runtimeNodeId: id, currentNode: id } });
    cached.push(reverse.fullPath);
    assert.equal(reverse.fileDelivery?.sourceNodeId, id);
    assert.deepEqual(await fs.readFile(reverse.fullPath), bytes);
    const image = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#123456' } }).png().toBuffer();
    f.session.history.push({ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: image.toString('base64') }, imageMeta: { imageId: 'maximum-node-image', mimeType: 'image/png' } }] });
    await sessionManager.saveSession(f.session);
    await callTool('image_write_to_file', { id: 'maximum-node-image', filePath: 'maximum.png' }, {
      sessionId: f.sourceId, session: { ...f.session, currentNode: id }, sessionPlacement: 'session-worker', persistCurrentSession: async () => {},
    });
    assert.deepEqual(await fs.readFile(path.join(root, 'cwd/maximum.png')), image);
  } finally {
    nodeProviderRegistry.readTransferFile = originalRead;
    nodeProviderRegistry.writeTransferFile = originalWrite;
    await fileDelivery.shutdownFileDelivery(); fileDelivery.resetFileDeliveryForTests();
    await transport.drain(); transport.close(); await registry.shutdown();
    for (const file of cached) await fs.remove(file);
    await fs.remove(getImageWriteHandoffRoot(f.session.agent, f.sourceId));
  }
}));
