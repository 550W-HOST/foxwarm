import '../testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createExecRuntime } from '../execManager';
import { ExecutableNodeProvider } from './executableProvider';
import { NodeProviderRegistry } from './providerRegistry';
import * as sessionManager from '../sessionManager';
import * as nodeExecution from '../nodeExecution';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from '../nodeExecutionService';
import { LocalRpcTransport, RpcServiceRegistry } from '../rpc';
import { callTool } from '../tools';

const execute = promisify(execFile);
const enabled = process.env.FOXWARM_SSH_TEST === '1' && process.platform === 'linux';

const { sshFixture }: {
  sshFixture(root: string): Promise<{ target: string; sshArgs: string[]; close(): Promise<void> }>;
} = require('../../scripts/test/loopbackSshFixture.cjs');

test('external SSH adapter: canonical files, raw bytes, cwd, bounded output, background completion and cross-process restart reattachment', { skip: !enabled, timeout: 60000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.foxwarm-ssh-test-'));
  const connection = await sshFixture(root);
  const cwd = path.join(root, "target space ü 'quote");
  const stateDir = path.join(root, 'target-state');
  await fs.ensureDir(cwd);
  const configPath = path.join(root, 'provider.json');
  await fs.writeJson(configPath, { nodes: [{ id: 'ssh:fixture', label: 'SSH fixture', ...connection, cwd, stateDir }] });
  const config = { id: 'external-ssh', type: 'executable' as const, command: 'python3',
    args: [path.resolve('skills/node-setup/examples/linux-ssh/provider.py'), '--config', configPath], timeoutMs: 5000 };
  const provider = new ExecutableNodeProvider(config);
  const delivered: unknown[] = [];
  const runtime = createExecRuntime({ getDefaultCwd: () => root, getExecTempDir: () => root,
    registryPath: path.join(root, 'core-execs.json'), resolveBackend: (providerId, nodeId) => registry.execBackend(providerId, nodeId),
    completionDispatcher: async (entry, status) => { delivered.push({ sessionId: entry.sessionId, status }); },
  });
  const registry = new NodeProviderRegistry([provider], { getExecRuntime: () => runtime });
  const sessionId = `ssh-fixture-${Date.now()}`;
  const session = await sessionManager.getSession(sessionId);
  session.currentNode = 'external-ssh/ssh:fixture';
  session.cwd = cwd;
  await sessionManager.saveSession(sessionId);
  const service = new RpcServiceRegistry();
  service.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ expectedSourceSessionId: sessionId, providerRegistry: registry }));
  const transport = new LocalRpcTransport(service);
  await nodeExecution.initializeNodeExecution({ transport, placement: 'child-reverse' });
  const ctx: any = { sessionId, session, sessionPlacement: 'session-worker', programmatic: true,
    persistCurrentSession: async () => sessionManager.saveSession(sessionId) };
  try {
    const discovery: any = await callTool('node', { action: 'list' }, ctx);
    assert.equal(discovery.nodes[0].id, 'external-ssh/ssh:fixture');
    assert.deepEqual(discovery.providers[0].lifecycle, []);
    assert.equal(discovery.providers[0].label, 'Linux SSH');
    const inspection: any = await callTool('node', { action: 'inspect', providerId: 'external-ssh' }, ctx);
    assert.deepEqual(inspection.provider.lifecycle, []);
    await assert.rejects(() => callTool('node', { action: 'create', providerId: 'external-ssh' }, ctx), /does not support/);
    await callTool('write', { filePath: 'sample.txt', content: 'alpha\nβ\n' }, ctx);
    await callTool('edit', { filePath: 'sample.txt', oldText: 'alpha', newText: 'changed' }, ctx);
    await callTool('edit', { apply_patch: '*** Begin Patch\n*** Update File: sample.txt\n@@\n-β\n+gamma\n*** Add File: added.txt\n+new\n*** End Patch' }, ctx);
    assert.equal(await fs.readFile(path.join(cwd, 'sample.txt'), 'utf8'), 'changed\ngamma\n');
    assert.equal(await fs.readFile(path.join(cwd, 'added.txt'), 'utf8'), 'new');
    const read: any = await callTool('read', { filePath: 'sample.txt' }, ctx);
    assert.equal(read.content, 'changed\ngamma\n');
    const bytes = Buffer.from([0, 0xff, 0xc3, 0xa9, 13, 10, 32]);
    await provider.invokeFilesystem({ sourceSessionId: sessionId, nodeId: 'ssh:fixture', operation: 'write', path: 'bytes', flag: 'w', contentBase64: bytes.toString('base64'), context: { agent: 'main', currentNode: 'ssh:fixture', cwd } });
    const raw: any = await provider.invokeFilesystem({ sourceSessionId: sessionId, nodeId: 'ssh:fixture', operation: 'read', path: 'bytes', offset: 0, count: bytes.length, context: { agent: 'main', currentNode: 'ssh:fixture', cwd } });
    assert.deepEqual(Buffer.from(raw.dataBase64, 'base64'), bytes);
    await fs.ensureDir(path.join(cwd, ' sub '));
    const foreground: any = await callTool('exec', { command: "cd ' sub '; printf '  héllo\\n'; exit 7" }, ctx);
    assert.equal(foreground.exitCode, 7);
    assert.equal(foreground.content, '  héllo\n');
    assert.equal(session.cwd, path.join(cwd, ' sub '), 'the exact Worker owner applies cwd returned by the generic backend');
    const transferNodeId = (await registry.listNodes()).find(node => node.provider === provider.id)!.id;
    const transferBytes = Buffer.alloc(12 * 1024 * 1024 + 7, 0xc3);
    transferBytes[0] = 0;
    transferBytes[transferBytes.length - 1] = 0xff;
    const transferred = await registry.writeTransferFile({ sourceSessionId: sessionId, nodeId: transferNodeId,
      filePath: 'transfer-large.bin', dataBase64: transferBytes.toString('base64'), overwrite: false, context: { agent: 'main' } });
    assert.equal(transferred.sizeBytes, transferBytes.length);
    assert.deepEqual(await fs.readFile(path.join(cwd, 'transfer-large.bin')), transferBytes);
    const transferredBack = await registry.readTransferFile({ sourceSessionId: sessionId, nodeId: transferNodeId,
      filePath: 'transfer-large.bin', context: { agent: 'main' } });
    assert.equal(transferredBack.sha256, transferred.sha256);
    assert.deepEqual(Buffer.from(transferredBack.dataBase64, 'base64'), transferBytes);

    const shellEof: any = await callTool('exec', { command: "cat <<'END_OF_COMMAND'\nexact trailing newline\n" }, ctx);
    assert.ok(shellEof.content.endsWith('exact trailing newline\n'));
    assert.ok(!shellEof.content.endsWith('exact trailing newline\n\n'), 'the adapter does not append blank command source at shell EOF');
    const background: any = await callTool('exec', { command: 'sleep 1.4; printf survived', timeout: 1 }, ctx);
    assert.equal(background.status, 'running');
    assert.ok(runtime.listRunningExecs().some(entry => entry.id === background.execId));
    assert.equal((await runtime.waitForExecCompletion(background.execId, 5000))?.exitCode, 0);
    await runtime.reconcileNow();
    assert.deepEqual(delivered.map((item: any) => item.sessionId), [sessionId]);
    const large: any = await callTool('exec', { command: "head -c 1100000 /dev/zero | tr '\\0' x" }, ctx);
    assert.equal(large.truncated, true);
    assert.equal(large.sizeBytes, 1100000);
    assert.equal(large.content, undefined);
    assert.ok(large.logPath.startsWith(stateDir));
    assert.equal((await fs.stat(large.logPath)).size, large.sizeBytes);
    const workerConfig = path.join(root, 'restart-config.json');
    const workerRegistry = path.join(root, 'restart-execs.json');
    const startResult = path.join(root, 'started.json');
    const recoveredResult = path.join(root, 'recovered.json');
    await fs.writeJson(workerConfig, { provider: config, nodeId: 'external-ssh/ssh:fixture', command: 'sleep 1.4; printf restart' });
    const helper = path.join(__dirname, 'providerExecRestartTestFixture.js');
    await execute(process.execPath, [helper, 'start', workerConfig, workerRegistry, startResult]);
    const { entry } = await fs.readJson(startResult);
    const directoryCount = (await fs.readdir(stateDir)).length;
    assert.equal((await fs.readJson(workerRegistry)).execs[0].backend.ref, entry.backend.ref);
    await execute(process.execPath, [helper, 'recover', workerConfig, workerRegistry, recoveredResult]);
    const recovered = await fs.readJson(recoveredResult);
    assert.equal(recovered.completions.length, 1);
    assert.equal(recovered.completions[0].execId, entry.id);
    assert.equal(recovered.completions[0].sessionId, 'restart-owner');
    assert.equal(recovered.completions[0].status.exitCode, 0);
    assert.deepEqual(recovered.remaining, []);
    assert.equal((await fs.readdir(stateDir)).length, directoryCount, 'recovery never starts another command');
    assert.equal(await fs.readFile(entry.logPath, 'utf8'), 'restart');
    const fifo = path.join(cwd, 'blocked-read');
    await execute('mkfifo', [fifo]);
    const cancelled = new AbortController();
    const blockedRead = provider.invokeFilesystem({ sourceSessionId: sessionId, nodeId: 'ssh:fixture', operation: 'read', path: fifo, offset: 0, count: 1, context: { agent: 'main' } }, { signal: cancelled.signal });
    const rejectedRead = assert.rejects(() => blockedRead, (error: any) => error.code === 'NODE_PROVIDER_CANCELLED');
    await new Promise(resolve => setTimeout(resolve, 150));
    const processes = (await execute('ps', ['-eo', 'pid=,ppid=,args='])).stdout.split('\n').map(line => /^(?:\s*)(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean);
    const adapter = processes.find(row => row![3].startsWith('python3 ') && row![3].includes(configPath));
    assert.ok(adapter, 'the request has its own adapter process');
    const ssh = processes.find(row => row![2] === adapter[1] && row![3].startsWith('ssh '));
    assert.ok(ssh, 'the adapter owns the SSH transport process');
    cancelled.abort();
    await rejectedRead;
    assert.throws(() => process.kill(Number(ssh[1]), 0), { code: 'ESRCH' }, 'request cancellation reaps the owned SSH child');
    const trustedHosts = connection.sshArgs.find(arg => arg.startsWith('-oUserKnownHostsFile='))!.slice('-oUserKnownHostsFile='.length);
    await fs.writeFile(trustedHosts, '');
    assert.equal((await provider.listNodes())[0].availability, 'offline', 'an untrusted host is not silently accepted');
    await assert.rejects(() => registry.invokeTool({ sourceSessionId: sessionId, nodeId: 'ssh:fixture', toolName: 'exec', args: { command: 'touch must-not-run' }, context: { agent: 'main' } }), /not available/);
    assert.equal((await fs.readdir(stateDir)).length, directoryCount, 'host verification failure causes no command submission');

  } finally {
    await nodeExecution.shutdownNodeExecution();
    nodeExecution.resetNodeExecutionForTests();
    await runtime.shutdown();
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await connection.close();
    await fs.remove(root);
  }
});
