import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { HttpServer } from '../httpServer';
import { WebUiRealtimeHub, WEBUI_REALTIME_PATH } from './webuiRealtime';
import { WebUiLogFile, LOG_WINDOW_BYTES, LOG_CATCHUP_BYTES, LOG_SOCKET_BUFFER_BYTES, LogFileResetError, registerWebUiLogRoutes } from './webuiLogs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-log-view-'));
  const file = path.join(root, 'synthetic.log');
  const logs = new WebUiLogFile(file, 10);
  return { file, logs, async dispose() { logs.dispose(); await fs.rm(root, { recursive: true, force: true }); } };
}
async function until(predicate: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error('Timed out waiting for log event.'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('bounded reverse windows preserve raw offsets, UTF-8 and partial-line boundaries', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.logs.read()).missing, true);
    await fs.writeFile(f.file, '');
    const empty = await f.logs.read();
    assert.equal(empty.missing, false);
    assert.equal(empty.lineCount, 0);
    const text = ('synthetic 汉字 🦊 record\r\n').repeat(24000) + 'unfinished tail';
    const bytes = Buffer.from(text);
    await fs.writeFile(f.file, bytes);
    const pages = [];
    let page = await f.logs.read();
    assert.equal(page.endOffset, bytes.length);
    assert.equal(page.endsMidLine, true);
    while (true) {
      assert.ok(page.endOffset - page.startOffset <= LOG_WINDOW_BYTES);
      assert.equal(page.text, bytes.subarray(page.startOffset, page.endOffset).toString());
      assert.ok(!page.text.includes('\ufffd'));
      assert.equal(page.lineCount, page.text.split('\n').length - (page.text.endsWith('\n') ? 1 : 0));
      pages.unshift(page);
      if (!page.startOffset) break;
      const older = await f.logs.read({ direction: 'before', offset: page.startOffset, fileId: page.fileId! });
      assert.equal(older.endOffset, page.startOffset);
      const newer = await f.logs.read({ direction: 'after', offset: older.endOffset, fileId: older.fileId! });
      assert.equal(newer.startOffset, page.startOffset);
      page = older;
    }
    assert.equal(pages.map(window => window.text).join(''), text);
    await fs.writeFile(f.file, 'x'.repeat(LOG_WINDOW_BYTES * 4));
    const long = await f.logs.read();
    assert.equal(long.text.length, LOG_WINDOW_BYTES);
    assert.equal(long.startsMidLine, true);
    assert.equal(long.endsMidLine, true);
    assert.equal(long.lineCount, 1);
    await assert.rejects(f.logs.read({ direction: 'before', offset: pages[0].endOffset, fileId: pages[0].fileId! }), LogFileResetError);
    // A sparse file exercises the hundreds-of-megabytes path without a large fixture.
    await fs.truncate(f.file, 384 * 1024 * 1024);
    await fs.appendFile(f.file, 'synthetic sparse tail\n');
    const large = await f.logs.read();
    assert.ok(large.size > 384 * 1024 * 1024);
    assert.ok(large.endOffset - large.startOffset <= LOG_WINDOW_BYTES);
    assert.ok(large.text.endsWith('synthetic sparse tail\n'));
  } finally { await f.dispose(); }
});

test('an unfinished UTF-8 EOF is resumed at the same byte cursor without losing the last line', async () => {
  const f = await fixture();
  try {
    const character = Buffer.from('🦊');
    await fs.writeFile(f.file, Buffer.concat([Buffer.from('tail '), character.subarray(0, 2)]));
    const first = await f.logs.read();
    assert.equal(first.text, 'tail ');
    assert.equal(first.endOffset, 5);
    assert.equal(first.pendingBytes, 2);
    await fs.appendFile(f.file, Buffer.concat([character.subarray(2), Buffer.from(' continued\n')]));
    const next = await f.logs.read({ direction: 'after', fileId: first.fileId!, offset: first.endOffset });
    assert.equal(next.startOffset, first.endOffset);
    assert.equal(first.text + next.text, 'tail 🦊 continued\n');
    assert.equal(next.pendingBytes, 0);
  } finally { await f.dispose(); }
});

test('near-time lookup uses full dates and raw byte positions, with bounded old/unknown and out-of-range failures', async () => {
  const f = await fixture();
  try {
    const start = Date.parse('2026-01-02T00:00:00Z');
    const lines = Array.from({ length: 18000 }, (_, index) => {
      const time = new Date(start + (index % 101 === 0 ? Math.max(0, index - 2) : index) * 1000);
      return `[${time.toISOString().replace('T', ' ').replace('Z', ' +0000')}] INFO: synthetic ${index} 汉字\n`;
    });
    const old = '[01:02:03.004] INFO: old date unknown\n'.repeat(7000);
    await fs.writeFile(f.file, old + lines.join(''));
    const latest = await f.logs.read();
    const target = start + 8000 * 1000;
    const result = await f.logs.seek(target, latest.fileId!);
    assert.ok(Math.abs(Date.parse(result.locatedTime) - target) <= 3000);
    assert.match(result.window.text, /^\[2026-01-02 /);
    const raw = await fs.readFile(f.file);
    assert.equal(result.window.text, raw.subarray(result.window.startOffset, result.window.endOffset).toString());
    await assert.rejects(f.logs.seek(start - 86_400_000, latest.fileId!), /outside the dated logs/);
    await fs.writeFile(f.file, old);
    const onlyOld = await f.logs.read();
    await assert.rejects(f.logs.seek(target, onlyOld.fileId!), /No full date/);
    const ansi = '\u001b[32m';
    const json = JSON.stringify({ time: start + 1000, msg: 'synthetic JSON' }) + '\n';
    await fs.writeFile(f.file, `${ansi}[2026-01-02 00:00:00.000 +0000] INFO: first\u001b[0m\n${json}`);
    const mixed = await f.logs.read();
    const found = await f.logs.seek(start + 1000, mixed.fileId!);
    assert.equal(found.window.startOffset, Buffer.byteLength(`${ansi}[2026-01-02 00:00:00.000 +0000] INFO: first\u001b[0m\n`));
    assert.equal(found.window.text, json);
  } finally { await f.dispose(); }
});

function hubFor(logs: WebUiLogFile, authorized = true) {
  return new WebUiRealtimeHub({
    checkToken: req => authorized && req.headers.authorization === 'Bearer synthetic-log-token',
    resolveIds: ids => ({ canonicalIds: ids, missingIds: [], requestedToCanonical: Object.fromEntries(ids.map(id => [id, id])) }),
    loadSessionState: async sessionId => ({ type: 'session-state', sessionId }),
    loadSessionList: async () => ({ type: 'session-list-delta', sessions: [] }),
    subscribeLogs: (request, emit, canSend) => logs.subscribe(request, emit, canSend),
  });
}
const subscriptions = (revision: number, logs: unknown) => ({ type: 'set-subscriptions', revision, sessionListActive: true, sessionListIds: ['main'], sessionIds: ['main'], logs });

async function connect(url: string) {
  const socket = new WebSocket(url, { headers: { Authorization: 'Bearer synthetic-log-token' } });
  const messages: any[] = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return { socket, messages };
}

test('real authenticated HTTP/WS history and live cursors coexist with Chat/list, reconnect, gaps and observed resets', async () => {
  const f = await fixture();
  const server = new HttpServer(0, 'synthetic-log-token');
  const hub = hubFor(f.logs);
  const sockets: WebSocket[] = [];
  try {
    await fs.writeFile(f.file, 'initial synthetic\n');
    registerWebUiLogRoutes(server, f.logs);
    server.addWebSocket(WEBUI_REALTIME_PATH, (socket, req) => hub.handleConnection(socket, req));
    await server.start();
    const address = (server as any).httpServer.address();
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${base}/api/webui/logs`)).status, 401);
    const headers = { Authorization: 'Bearer synthetic-log-token' };
    assert.equal((await fetch(`${base}/api/webui/logs?path=other`, { headers })).status, 400);
    const history: any = await fetch(`${base}/api/webui/logs`, { headers }).then(response => response.json());
    assert.equal(history.window.text, 'initial synthetic\n');
    const first = await connect(base.replace('http:', 'ws:') + WEBUI_REALTIME_PATH); sockets.push(first.socket);
    first.socket.send(JSON.stringify(subscriptions(1, { id: 'logs:first' })));
    await until(() => first.messages.some(message => message.type === 'logs-snapshot'));
    await fs.appendFile(f.file, 'next synthetic\n');
    await until(() => first.messages.some(message => message.type === 'logs-delta'));
    const delta = first.messages.find(message => message.type === 'logs-delta').window;
    assert.equal(delta.startOffset, history.window.endOffset);
    assert.equal(delta.text, 'next synthetic\n');
    first.socket.send(JSON.stringify(subscriptions(2, { id: 'logs:first', cursor: { fileId: delta.fileId, offset: delta.endOffset } })));
    hub.broadcastSession('main', { type: 'typing' });
    hub.broadcastSessionListInvalidation({ type: 'sessions-updated' });
    await until(() => first.messages.some(message => message.type === 'subscriptions-applied' && message.revision === 2));
    assert.equal(first.messages.filter(message => message.type === 'logs-snapshot').length, 1);
    assert.ok(first.messages.some(message => message.type === 'typing'));
    assert.ok(first.messages.some(message => message.type === 'sessions-updated'));
    first.socket.close(); await until(() => f.logs.getSubscriberCount() === 0);
    await fs.appendFile(f.file, 'disconnected synthetic\n');
    const resumed = await connect(base.replace('http:', 'ws:') + WEBUI_REALTIME_PATH); sockets.push(resumed.socket);
    resumed.socket.send(JSON.stringify(subscriptions(1, { id: 'logs:resume', cursor: { fileId: delta.fileId, offset: delta.endOffset } })));
    await until(() => resumed.messages.some(message => message.type === 'logs-delta'));
    assert.equal(resumed.messages.find(message => message.type === 'logs-delta').window.text, 'disconnected synthetic\n');
    const resumedWindow = resumed.messages.find(message => message.type === 'logs-delta').window;
    // Establish the catch-up gap before subscribing, independent of polling/write timing.
    resumed.socket.send(JSON.stringify(subscriptions(2, null)));
    await until(() => resumed.messages.some(message => message.type === 'subscriptions-applied' && message.revision === 2));
    await until(() => f.logs.getSubscriberCount() === 0);
    await fs.appendFile(f.file, 'x'.repeat(LOG_CATCHUP_BYTES + 1));
    resumed.socket.send(JSON.stringify(subscriptions(3, { id: 'logs:gap', cursor: { fileId: resumedWindow.fileId, offset: resumedWindow.endOffset } })));
    await until(() => resumed.messages.some(message => message.type === 'logs-gap'));
    assert.equal(resumed.messages.filter(message => message.type === 'logs-delta').length, 1);
    hub.broadcastSession('main', { type: 'typing', afterGap: true });
    await until(() => resumed.messages.some(message => message.afterGap));
    resumed.socket.send(JSON.stringify(subscriptions(4, { id: 'logs:fresh' })));
    await until(() => resumed.messages.some(message => message.type === 'logs-snapshot'));
    await fs.rename(f.file, `${f.file}.previous`);
    await fs.writeFile(f.file, 'replacement synthetic\n');
    await until(() => resumed.messages.some(message => message.type === 'logs-reset'));
    const stale = await fetch(`${base}/api/webui/logs?direction=after&offset=0&fileId=${encodeURIComponent(delta.fileId)}`, { headers });
    assert.equal(stale.status, 409);
    resumed.socket.send(JSON.stringify(subscriptions(5, { id: 'logs:truncate' })));
    await until(() => resumed.messages.some(message => message.type === 'logs-snapshot' && message.logsId === 'logs:truncate'));
    await fs.truncate(f.file, 0);
    await until(() => resumed.messages.some(message => message.type === 'logs-reset' && message.logsId === 'logs:truncate'));
    resumed.socket.close(); await until(() => f.logs.getSubscriberCount() === 0);
  } finally { for (const socket of sockets) socket.terminate(); hub.dispose(); await server.stop(); await f.dispose(); }
});

class SlowSocket extends EventEmitter {
  readyState: 0 | 1 | 2 | 3 = 1;
  bufferedAmount = 0;
  sent: any[] = [];
  send(text: string) { this.sent.push(JSON.parse(text)); }
  close() { this.readyState = 3; this.emit('close'); }
  ping() {}
}

test('slow clients pause only logs, signal one gap, and dispose all tail ownership', async () => {
  const f = await fixture();
  const hub = hubFor(f.logs);
  const socket = new SlowSocket();
  try {
    await fs.writeFile(f.file, 'synthetic\n');
    await hub.handleConnection(socket as unknown as WebSocket, { headers: { authorization: 'Bearer synthetic-log-token' } } as any);
    socket.emit('message', Buffer.from(JSON.stringify(subscriptions(1, { id: 'slow' }))));
    await until(() => socket.sent.some(message => message.type === 'logs-snapshot'));
    socket.bufferedAmount = LOG_SOCKET_BUFFER_BYTES;
    await fs.appendFile(f.file, 'not queued\n');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(socket.sent.filter(message => message.type === 'logs-delta').length, 0);
    socket.bufferedAmount = 0;
    await until(() => socket.sent.some(message => message.type === 'logs-gap'));
    assert.equal(socket.readyState, 1);
    hub.broadcastSession('main', { type: 'typing' });
    assert.ok(socket.sent.some(message => message.type === 'typing'));
    hub.dispose(); f.logs.dispose();
    assert.equal(f.logs.getSubscriberCount(), 0);
    const count = socket.sent.length;
    await fs.appendFile(f.file, 'after disposal\n');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(socket.sent.length, count);
  } finally { hub.dispose(); await f.dispose(); }
});
