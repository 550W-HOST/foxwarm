import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';
import { createFileDeliveryServiceHandler, fileDeliveryServiceDescriptor } from './fileDeliveryService';
import * as sessionManager from './sessionManager';
import { nodesManager } from './nodes/manager';

function client(expected?: string) {
  const registry = new RpcServiceRegistry(); registry.register(fileDeliveryServiceDescriptor, createFileDeliveryServiceHandler({ expectedSourceSessionId: expected }));
  const transport = new LocalRpcTransport(registry); return { client: new RpcClient(fileDeliveryServiceDescriptor, transport), transport };
}

const baseIntent = { filePath: 'demo.txt' };
const baseRouting = { runtimeNodeId: 'master', currentNode: 'master' };

test('file delivery exact source fence precedes lookup', async () => {
  const rpc = client('owned'); const original = sessionManager.getExistingSession; let lookups = 0;
  (sessionManager as any).getExistingSession = async (): Promise<null> => { lookups += 1; return null; };
  try {
    await assert.rejects(() => rpc.client.call('deliver', { sourceSessionId: 'wrong', intent: baseIntent, routing: baseRouting }),
      { code: 'FILE_DELIVERY_SOURCE_MISMATCH' });
    assert.equal(lookups, 0);
  } finally { (sessionManager as any).getExistingSession = original; await rpc.transport.drain(); rpc.transport.close(); }
});

test('file delivery preserves Main preparation, target routing, WebUI fallback, and bounded errors', async () => {
  const sourceId = 'file-delivery-source'; const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'file-delivery-'));
  await fs.writeFile(path.join(dir, 'demo.txt'), 'master-file');
  const source: any = { id: sourceId, agent: 'main', currentNode: 'master', cwd: dir, history: [], queue: [], meta: {}, stats: {} };
  const originals = { get: sessionManager.getExistingSession, session: sessionManager.sendFileToSession,
    channel: sessionManager.sendFileToChannelTargetId, read: nodesManager.readFileFromNode };
  const sessionFiles: any[] = []; const channelFiles: any[] = [];
  (sessionManager as any).getExistingSession = async (id: string) => id === sourceId ? source : null;
  (sessionManager as any).sendFileToSession = async (...args: any[]) => { sessionFiles.push(args); return {
    deliveredChannels: ['telegram:x'], skippedChannels: [] as any[], failedChannels: [] as any[],
  }; };
  (sessionManager as any).sendFileToChannelTargetId = async (...args: any[]) => { channelFiles.push(args); };
  (nodesManager as any).readFileFromNode = async () => ({ dataBase64: Buffer.from('remote-file').toString('base64'), name: 'remote.txt', mimeType: 'text/plain', sizeBytes: 11, isImage: false });
  const rpc = client(sourceId);
  try {
    const sessionResult = await rpc.client.call('deliver', { sourceSessionId: sourceId,
      intent: { filePath: 'demo.txt', sessionId: 'target-session', caption: 'caption' }, routing: { ...baseRouting, cwd: dir } });
    assert.match(sessionResult.output, /Delivered: 1/); assert.equal(sessionFiles[0][0], 'target-session');
    assert.equal(await fs.readFile(sessionFiles[0][1].path, 'utf8'), 'master-file');

    const channelResult = await rpc.client.call('deliver', { sourceSessionId: sourceId,
      intent: { filePath: 'demo.txt', channelTargetId: 'telegram:room', text: 'alias' }, routing: { ...baseRouting, cwd: dir } });
    assert.match(channelResult.output, /telegram:room/); assert.equal(channelFiles[0][0], 'telegram:room'); assert.equal(channelFiles[0][2].caption, 'alias');

    const webui = await rpc.client.call('deliver', { sourceSessionId: sourceId,
      intent: { filePath: 'demo.txt', channelTargetId: 'webui:room' }, routing: { ...baseRouting, cwd: dir } });
    assert.match(webui.output, /ready for WebUI/); assert.equal(channelFiles.length, 1);

    const remote = await rpc.client.call('deliver', { sourceSessionId: sourceId,
      intent: { filePath: 'remote.txt', sessionId: 'target-session' },
      routing: { runtimeNodeId: 'remote-a', currentNode: 'remote-a', cwd: '/exact/remote' } });
    assert.equal(await fs.readFile(remote.fullPath, 'utf8'), 'remote-file');

    (sessionManager as any).sendFileToChannelTargetId = async () => { throw new Error(`channel failed ${'x'.repeat(20_000)}`); };
    await assert.rejects(() => rpc.client.call('deliver', { sourceSessionId: sourceId,
      intent: { filePath: 'demo.txt', channelTargetId: 'telegram:room' }, routing: { ...baseRouting, cwd: dir } }),
      (error: any) => error?.code === 'FILE_DELIVERY_FAILED' && error.message.length <= 16 * 1024);
  } finally {
    (sessionManager as any).getExistingSession = originals.get; (sessionManager as any).sendFileToSession = originals.session;
    (sessionManager as any).sendFileToChannelTargetId = originals.channel; (nodesManager as any).readFileFromNode = originals.read;
    await rpc.transport.drain(); rpc.transport.close(); await fs.remove(dir);
  }
});
