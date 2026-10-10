import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';

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
      const firstTarget = first.structuredContent.channelTargetId;
      const secondTarget = second.structuredContent.channelTargetId;
      assert.match(firstTarget, /^mcp-[\w-]+:reply$/);
      assert.notEqual(firstTarget, secondTarget);
      assert.equal(allInputs(await a.command('history', { sessionId: 'receive-one' })).length, 0,
        'ordinary remote output is not subscribed or broadcast to the receiver');
      assert.equal((await a.command('call', { sessionId: 'unsubscribed', args: { action: 'send', sessionId: 'remote-target', message: 'no reply receiver', reply: true } })).isError, true);
      const bHistory = await b.command('history', { sessionId: 'remote-target' });
      assert.ok(JSON.stringify(allInputs(bHistory)).includes(firstTarget), 'server-owned reply address enters external-input metadata');
      if (workers) assert.ok(!JSON.stringify(bHistory.mainHistory).includes(firstTarget), 'Main does not hydrate Worker history');

      await b.command('isolated', { sessionId: 'isolated-sender' });
      await assert.rejects(b.command('send', { sessionId: 'isolated-sender', target: firstTarget, message: 'denied isolated send' }), /own attached channel/);
      await b.command('policy', { policy: `version: 1\ndefaultAction: allow\nrules:\n- id: deny-manual-send\n  match: { tool: { source: builtin, name: send_to_channel } }\n  action: deny\n` });
      await assert.rejects(b.command('send', { sessionId: 'other-sender', target: firstTarget, message: 'denied by policy' }), /denies builtin|authorization/i);
      await b.command('policy', { policy: allowInbound });
      await b.command('notify', { target: firstTarget, method: 'notifications/foxwarm/other', params: { message: 'not a Session message', endpoint: firstTarget } });
      await b.command('notify', { target: firstTarget, method: 'notifications/foxwarm/session_message', params: { message: 'remote target spoof', endpoint: firstTarget, sessionId: 'receive-two' } });
      const received = a.nextInput('receive-one');
      await b.command(workers ? 'workerReply' : 'send', { sessionId: 'other-sender', target: firstTarget, message: 'explicit after-POST reply' });
      await received;
      const aHistory = await a.command('history', { sessionId: 'receive-one' });
      const reply = allInputs(aHistory).find((item: any) => item.parts?.some((part: any) => part.text === 'explicit after-POST reply'));
      assert.ok(reply);
      assert.equal(reply.sourceSessionId, undefined);
      assert.match(reply.parts[0].system, /kind="external-input"/);
      assert.match(reply.parts[0].system, /server="peer"/);
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
      await assert.rejects(b.command('send', { sessionId: 'other-sender', target: deleted.structuredContent.channelTargetId, message: 'deleted receiver' }), /not found|unavailable/);
      await a.command('fenceReceivers');
      await assert.rejects(a.command('notifications', { sessionId: 'receive-one', operation: 'start' }), /not permitted/);
    } finally { await a.close(); await b?.close(); }
  });
}
