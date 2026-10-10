import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as mcpClient from './mcpClient';
import { convertToOpenAIFormat, convertToOpenAIResponsesFormat } from './llmProviders/openai';

async function mainFixture(workers: boolean) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-mcp-notifications-'));
  await fs.outputFile(path.join(dir, 'state', 'config.yaml'), `bot:\n  enableWebUI: false\nvector: false\ndbWorkers: false\nsessionWorkers: ${workers}\nchannels: {}\n`);
  const child = fork(require.resolve('./mcpNotificationsTestMain'), [], {
    env: { ...process.env, FOXWARM_DATA_DIR: dir, FOXWARM_TEST_NOTIFICATION_WORKERS: workers ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let logs = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { logs = (logs + chunk.toString()).slice(-20000); });
  let sequence = 0;
  const requests = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const inputWaiters = new Map<string, () => void>();
  let ready!: (port: number) => void;
  let rejectReady!: (error: Error) => void;
  const readyPromise = new Promise<number>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  child.on('message', (message: any) => {
    if (message.event === 'ready') ready(message.port);
    inputWaiters.get(`${message.event}:${message.sessionId || ''}`)?.();
    const pending = requests.get(message.id);
    if (pending) {
      requests.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    }
  });
  child.on('exit', () => {
    const error = new Error(`Main fixture exited: ${logs}`);
    rejectReady(error);
    for (const pending of requests.values()) pending.reject(error);
  });
  async function command(action: string, args: Record<string, unknown> = {}): Promise<any> {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { requests.delete(id); reject(new Error(`Fixture ${action} timed out: ${logs}`)); }, 20000);
      requests.set(id, { resolve(value) { clearTimeout(timer); resolve(value); }, reject(error) { clearTimeout(timer); reject(error); } });
      child.send({ id, action, ...args });
    });
  }
  const startupTimer = setTimeout(() => rejectReady(new Error(`Main startup timeout: ${logs}`)), 20000);
  const port = await readyPromise.finally(() => clearTimeout(startupTimer));
  function nextEvent(event: string, sessionId = '') {
    const key = `${event}:${sessionId}`;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { inputWaiters.delete(key); reject(new Error(`No ${key}: ${logs}`)); }, 20000);
      inputWaiters.set(key, () => { clearTimeout(timer); inputWaiters.delete(key); resolve(); });
    });
  }
  return { dir, child, port, command, nextEvent,
    nextInput(sessionId: string) { return nextEvent('input', sessionId); },
    async close() {
      try { await command('stop'); }
      finally {
        await stopChild(child);
        await fs.remove(dir);
      }
    },
  };
}
async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  const deadline = setTimeout(() => child.kill('SIGKILL'), 10000);
  try { await exited; } finally { clearTimeout(deadline); }
}
const allowInbound = `version: 1\ndefaultAction: allow\nrules:\n- id: peer-input\n  match: { externalId: peer, tool: { source: builtin, name: send_to_session } }\n  action: allow\n`;
const allInputs = (history: any) => [...(history.messages || []), ...(history.queue || [])];

for (const workers of [false, true]) {
  test(`independent Main instances explicitly reply after POST completion (${workers ? 'Worker' : 'local'} owners)`, { timeout: 60000 }, async () => {
    const a = await mainFixture(workers);
    let b: Awaited<ReturnType<typeof mainFixture>> | undefined;
    try {
      b = await mainFixture(workers);
      assert.notEqual(a.child.pid, b.child.pid);
      assert.notEqual(a.dir, b.dir);
      for (const sessionId of ['receive-one', 'receive-two', 'unsubscribed']) await a.command('create', { sessionId });
      for (const sessionId of ['remote-target', 'other-sender', 'isolated-sender']) await b.command('create', { sessionId });
      await b.command('policy', { policy: allowInbound });
      await a.command('config', { sessionId: 'receive-one', config: { transport: 'streamable-http', url: `http://127.0.0.1:${b.port}/mcp`, token: 'synthetic-peer-token' } });
      await b.command('holdGet');
      const getBlocked = b.nextEvent('get-blocked');
      let startCompleted = false;
      const started = a.command('notifications', { sessionId: 'receive-one', operation: 'start' }).then(result => { startCompleted = true; return result; });
      await getBlocked;
      assert.equal((await a.command('notifications', { sessionId: 'receive-one', operation: 'status' })).state, 'disconnected');
      assert.equal(startCompleted, false, 'initialize completion is not GET readiness');
      await b.command('releaseGet');
      assert.equal((await started).state, 'receiving');
      assert.equal((await a.command('notifications', { sessionId: 'receive-two', operation: 'start' })).state, 'receiving');
      const first = await a.command('call', { sessionId: 'receive-one', args: { action: 'send', sessionId: 'remote-target', message: 'first input', reply: true } });
      const second = await a.command('call', { sessionId: 'receive-two', args: { action: 'send', sessionId: 'remote-target', message: 'second input', reply: true } });
      // Both JSON POST results have completed before any explicit response.
      const firstTarget = first.channelTargetId;
      const secondTarget = second.channelTargetId;
      assert.match(firstTarget, /^mcp-[\w-]+:reply$/);
      assert.notEqual(firstTarget, secondTarget);
      assert.equal(allInputs(await a.command('history', { sessionId: 'receive-one' })).length, 0,
        'ordinary remote output is not subscribed or broadcast to the receiver');
      await assert.rejects(a.command('call', { sessionId: 'unsubscribed', args: { action: 'send', sessionId: 'remote-target', message: 'no reply receiver', reply: true } }), /No tool call was sent/);
      const bHistory = await b.command('history', { sessionId: 'remote-target' });
      assert.ok(JSON.stringify(allInputs(bHistory)).includes(firstTarget), 'server-owned reply address enters external-input metadata');
      const firstInput = allInputs(bHistory).find((item: any) => item.parts?.some((part: any) => part.text === 'first input'));
      assert.ok(firstInput);
      assert.equal(firstInput.role || firstInput.type, 'user');
      const firstParts = firstInput.parts.slice(firstInput.parts.findIndex((part: any) => part.system?.includes('kind="external-input"')));
      assert.ok(firstParts[0].system.endsWith('>') && !firstParts[0].system.endsWith('/>'));
      assert.deepEqual(firstParts[2], { system: '</foxwarm-system>' });
      if (workers) assert.ok(!JSON.stringify(bHistory.mainHistory).includes(firstTarget), 'Main does not hydrate Worker history');

      await b.command('isolated', { sessionId: 'isolated-sender' });
      await assert.rejects(b.command('send', { sessionId: 'isolated-sender', target: firstTarget, message: 'denied isolated send' }), /own attached channel/);
      await b.command('policy', { policy: `version: 1\ndefaultAction: allow\nrules:\n- id: deny-manual-send\n  match: { tool: { source: builtin, name: send_to_channel } }\n  action: deny\n` });
      await assert.rejects(b.command('send', { sessionId: 'other-sender', target: firstTarget, message: 'denied by policy' }), /denies builtin|authorization/i);
      await b.command('policy', { policy: allowInbound });
      await b.command('notify', { target: firstTarget, method: 'notifications/foxwarm/other', params: { message: 'not a Session message', endpoint: firstTarget } });
      await b.command('notify', { target: firstTarget, method: 'notifications/foxwarm/session_message', params: { message: 'remote target spoof', endpoint: firstTarget, sessionId: 'receive-two' } });
      const received = a.nextInput('receive-one');
      const replyText = ' \nexplicit after-POST reply\n  ';
      await b.command(workers ? 'workerReply' : 'send', { sessionId: 'other-sender', target: firstTarget, message: replyText });
      await received;
      const aHistory = await a.command('history', { sessionId: 'receive-one' });
      const reply = allInputs(aHistory).find((item: any) => item.parts?.some((part: any) => part.text === replyText));
      assert.ok(reply);
      assert.equal(reply.sourceSessionId, undefined);
      const replyParts = reply.parts.slice(reply.parts.findIndex((part: any) => part.system?.includes('kind="external-input"')));
      assert.match(replyParts[0].system, /server="peer"/);
      assert.equal(reply.role || reply.type, 'user');
      assert.equal(reply.source, undefined);
      assert.equal(reply.sourceSessionRelation, undefined);
      assert.ok(!replyParts[0].system.endsWith('/>'));
      assert.deepEqual(replyParts[1], { text: replyText });
      assert.deepEqual(replyParts[2], { system: '</foxwarm-system>' });
      const canonical = { role: 'user' as const, parts: reply.parts };
      const expectedText = `${replyParts[0].system}\n${replyText}\n</foxwarm-system>`;
      const chat = convertToOpenAIFormat([canonical]);
      assert.equal(chat[0].role, 'user');
      assert.ok(chat[0].content.endsWith(expectedText));
      const responses = convertToOpenAIResponsesFormat([canonical]);
      assert.equal(responses[0].role, 'user');
      assert.ok(responses[0].content.map((part: any) => part.text).join('\n').endsWith(expectedText));
      if (workers) {
        assert.equal(aHistory.worker.ready, true);
        assert.ok(!JSON.stringify(aHistory.mainHistory).includes('explicit after-POST reply'));
        const sender = await b.command('history', { sessionId: 'other-sender' });
        assert.ok(JSON.stringify(sender.messages).includes('Message sent to channel target'), 'explicit tool executes through exact Worker reverse Main Management');
      }
      const otherHistory = await a.command('history', { sessionId: 'receive-two' });
      assert.ok(!JSON.stringify(otherHistory).includes('explicit after-POST reply'));
      assert.ok(!JSON.stringify([aHistory, otherHistory]).includes('remote target spoof'));
      assert.ok(!JSON.stringify([aHistory, otherHistory]).includes('not a Session message'));
      const receivedTwo = a.nextInput('receive-two');
      await b.command('send', { sessionId: 'remote-target', target: secondTarget, message: 'separate receiver' });
      await receivedTwo;
      assert.ok(!JSON.stringify(await a.command('history', { sessionId: 'receive-one' })).includes('separate receiver'));
      await a.command('notifications', { sessionId: 'receive-one', operation: 'stop' });
      assert.equal((await a.command('notifications', { sessionId: 'receive-one', operation: 'status' })).state, 'stopped');
      await assert.rejects(b.command('send', { sessionId: 'other-sender', target: firstTarget, message: 'stale destination' }), /not found|unavailable/);
      await a.command('config', { sessionId: 'receive-two', config: { enable: false } });
      assert.equal((await a.command('notifications', { sessionId: 'receive-two', operation: 'status' })).state, 'stopped');
      await assert.rejects(b.command('send', { sessionId: 'other-sender', target: secondTarget, message: 'disabled destination' }), /not found|unavailable/);
      await a.command('config', { sessionId: 'unsubscribed', config: { enable: true } });
      await a.command('notifications', { sessionId: 'unsubscribed', operation: 'start' });
      const deleted = await a.command('call', { sessionId: 'unsubscribed', args: { action: 'send', sessionId: 'remote-target', message: 'delete receiver next', reply: true } });
      await a.command('delete', { sessionId: 'unsubscribed' });
      await assert.rejects(b.command('send', { sessionId: 'other-sender', target: deleted.channelTargetId, message: 'deleted receiver' }), /not found|unavailable/);
      await a.command('fenceReceivers');
      await assert.rejects(a.command('notifications', { sessionId: 'receive-one', operation: 'start' }), /not permitted/);
    } finally { await a.close(); await b?.close(); }
  });
}


test('caller-owned HTTP contexts survive repeated discovery, notification opt-in and external forwarding, then release', { timeout: 60000 }, async () => {
  const a = await mainFixture(false);
  const b = await mainFixture(false);
  const external: { client: Client; transport: StreamableHTTPClientTransport }[] = [];
  let aClosed = false;
  const probe = (sessionId: string, args: Record<string, unknown> = {}) => a.command('call', { sessionId, tool: 'fixture_context', args });
  try {
    for (const sessionId of ['owner-one', 'owner-two']) await a.command('create', { sessionId });
    await b.command('create', { sessionId: 'target' });
    await b.command('policy', { policy: allowInbound });
    const config = { transport: 'streamable-http', url: `http://127.0.0.1:${b.port}/mcp`, token: 'synthetic-peer-token' };
    await a.command('config', { sessionId: 'owner-one', config });
    const initial = (await probe('owner-one', { nodeId: 'fake-node-one', cwd: '/workspace/one', execId: 'one' }));
    for (let i = 0; i < 40; i++) {
      await a.command('discover', { sessionId: 'owner-one' });
      assert.deepEqual((await probe('owner-one')), initial);
    }
    assert.equal((await b.command('contexts')).length, 1, 'more than 32 calls and discoveries use one transport context');
    const other = (await probe('owner-two'));
    assert.notEqual(other.contextId, initial.contextId);
    assert.equal(other.currentNode, 'master');
    assert.equal(other.cwd, null);
    assert.deepEqual(other.execIds, []);
    await assert.rejects(a.command('call', { sessionId: 'owner-one', args: { action: 'send', sessionId: 'target', message: 'must not enqueue', reply: true } }), /No tool call was sent/);
    assert.equal((await b.command('history', { sessionId: 'target' })).queue.length, 0);
    await a.command('notifications', { sessionId: 'owner-one', operation: 'start' });
    assert.deepEqual((await probe('owner-one')), initial, 'start does not rebuild or lose Node/cwd/exec context');
    await a.command('policy', { policy: `version: 1\ndefaultAction: allow\nrules:\n- id: revoke-reception\n  match: { tool: { source: builtin, name: mcp_notifications } }\n  action: deny\n` });
    await assert.rejects(a.command('call', { sessionId: 'owner-one', args: { action: 'send', sessionId: 'target', message: 'reception denied', reply: true } }), /not permitted/);
    assert.equal((await b.command('history', { sessionId: 'target' })).queue.length, 0);
    await a.command('policy', { policy: 'version: 1\ndefaultAction: allow\nrules: []\n' });
    const accepted = await a.command('call', { sessionId: 'owner-one', args: { action: 'send', sessionId: 'target', message: 'now reply explicitly', reply: true } });
    const received = a.nextInput('owner-one');
    await b.command('send', { sessionId: 'target', target: accepted.channelTargetId, message: 'same-context reply' });
    await received;
    assert.equal((await b.command('contexts')).length, 2);
    await a.command('notifications', { sessionId: 'owner-one', operation: 'stop' });
    assert.equal((await b.command('contexts')).length, 1, 'stop deletes the remote context, not just the GET stream');
    const replacement = (await probe('owner-one'));
    assert.notEqual(replacement.contextId, initial.contextId);
    assert.equal(replacement.cwd, null);
    const failure = await probe('owner-one', { effect: true, fail: true });
    assert.equal(failure.isError, true);
    assert.equal(await b.command('effects'), 1, 'reported tool failure does not repeat its effect');
    await b.command('dropContexts');
    await assert.rejects(probe('owner-one', { effect: true }));
    assert.equal(await b.command('effects'), 1, '404 does not replay a tool invocation');
    assert.notEqual((await probe('owner-one')).contextId, replacement.contextId);
    await a.command('config', { sessionId: 'owner-one', config: { timeoutSeconds: 12 } });
    assert.equal((await b.command('contexts')).length, 0, 'successful config update releases ordinary contexts');
    await probe('owner-two');
    await a.command('delete', { sessionId: 'owner-one' });
    await a.command('delete', { sessionId: 'owner-two' });
    assert.equal((await b.command('contexts')).length, 0);

    await a.command('create', { sessionId: 'config-owner' });
    await a.command('policy', { policy: `version: 1\ndefaultAction: allow\nrules:\n- id: forward\n  match: { externalId: peer, tool: { source: mcp, server: peer, name: fixture_context } }\n  action: allow\n` });
    for (let i = 0; i < 2; i++) {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${a.port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer synthetic-peer-token' } } });
      const client = new Client({ name: 'synthetic-external', version: '1' });
      await client.connect(transport);
      external.push({ client, transport });
    }
    const forward = async (index: number, args: Record<string, unknown> = {}) => external[index].client.callTool({ name: 'foxwarm_call', arguments: { toolId: 'mcp:peer/fixture_context', args } });
    const forwarded: any = (await forward(0, { cwd: '/workspace/external', execId: 'external' })).structuredContent;
    for (let i = 0; i < 35; i++) assert.deepEqual((await forward(0)).structuredContent, forwarded);
    assert.notEqual(((await forward(1)).structuredContent as any).contextId, forwarded.contextId);
    assert.equal((await b.command('contexts')).length, 2, 'external contexts are distinct owners and reuse discovery plus call');
    await external[0].transport.terminateSession(); await external[0].client.close();
    assert.equal((await b.command('contexts')).length, 1, 'disposing inbound external context deletes its outbound context');
    await external[1].transport.terminateSession(); await external[1].client.close();
    assert.equal((await b.command('contexts')).length, 0);

    mcpClient.setMcpConfigStoreForTests(mcpClient.createMcpConfigStore(path.join(a.dir, 'anonymous-config.json')));
    await mcpClient.upsertServer('anonymous', config as mcpClient.McpServerConfig);
    for (let i = 0; i < 35; i++) await mcpClient.callTool('anonymous', 'fixture_context', {});
    assert.equal((await b.command('contexts')).length, 0, 'unowned short-lived calls DELETE rather than leak 32 slots');
    await probe('config-owner');
    aClosed = true;
    await a.close();
    assert.equal((await b.command('contexts')).length, 0, 'Main shutdown releases ordinary outbound contexts');
  } finally {
    for (const peer of external) await peer.client.close();
    await mcpClient.resetMcpConnectionsForTests();
    mcpClient.setMcpConfigStoreForTests(null);
    if (!aClosed) await a.close();
    await b.close();
  }
});


test('notification authorization, exact server names and moved owners retain their supported fences', { timeout: 60000 }, async () => {
  const a = await mainFixture(false);
  const b = await mainFixture(false);
  const management = (tool: string, args: Record<string, unknown>) => a.command('management', { sessionId: 'admin', descriptor: { toolId: `builtin:${tool}`, args } });
  const notify = (sessionId: string, operation: string, server = 'peer') => a.command('notifications', { sessionId, operation, server });
  try {
    await a.command('create', { sessionId: 'admin' });
    await a.command('create', { sessionId: 'before' });
    await b.command('create', { sessionId: 'target' });
    await b.command('policy', { policy: allowInbound });
    await a.command('config', { sessionId: 'admin', config: { transport: 'streamable-http', url: `http://127.0.0.1:${b.port}/mcp`, token: 'synthetic-peer-token' } });
    await a.command('policy', { policy: `version: 1\ndefaultAction: allow\nrules:\n- id: deny-peer\n  match: { tool: { source: builtin, name: mcp_notifications }, args: { action: start, server: peer } }\n  action: deny\n` });
    await assert.rejects(notify('admin', 'start'), /denies|not permitted/);
    await assert.rejects(notify('admin', 'start', 'missing-name'), /not found/);
    assert.equal((await notify('admin', 'status', 'missing-name')).state, 'stopped');
    assert.equal((await b.command('contexts')).length, 0);
    await a.command('policy', { policy: 'version: 1\ndefaultAction: allow\nrules: []\n' });
    await a.command('config', { sessionId: 'admin', config: { enable: false } });
    await assert.rejects(notify('admin', 'start'), /disabled/);
    await a.command('config', { sessionId: 'admin', config: { enable: true } });

    const toolRules = [{ effect: 'allow', source: 'builtin', tool: 'mcp_notifications' }, { effect: 'allow', source: 'mcp', server: 'peer', tool: 'foxwarm_session' }];
    await management('create_agent', { agentName: 'receiver', isolatedNode: 'synthetic-node', toolRules });
    await notify('receiver/main', 'start');
    await management('set_agent_isolated', { agentName: 'receiver', toolRules: toolRules.map(rule => rule.tool === 'mcp_notifications' ? { ...rule, effect: 'deny' } : rule) });
    await assert.rejects(notify('receiver/main', 'start'), /denies/);
    await assert.rejects(a.command('call', { sessionId: 'receiver/main', args: { action: 'send', sessionId: 'target', message: 'revoked receiver', reply: true } }), /denies/);
    assert.equal((await b.command('history', { sessionId: 'target' })).queue.length, 0, 'legacy revocation is checked before remote side effect');
    // Stop uses the same policy; restore permission before explicit cleanup.
    await management('set_agent_isolated', { agentName: 'receiver', toolRules });
    await notify('receiver/main', 'stop');
    await a.command('mockPing');
    await notify('before', 'start');
    const previousId = (await b.command('contexts'))[0].id;
    await management('move_session', { sessionId: 'before', newSessionId: 'after' });
    const released = b.nextEvent('context-released', previousId);
    await a.command('advancePing');
    await released;
    assert.equal((await b.command('contexts')).length, 0, 'next ping DELETEs the inactive pre-move owner');
    await notify('after', 'start');
    assert.equal((await b.command('contexts')).length, 1);
    await notify('after', 'stop');
    assert.equal((await b.command('contexts')).length, 0);
  } finally { await a.close(); await b.close(); }
});
