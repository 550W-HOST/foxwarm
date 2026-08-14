import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type http from 'node:http';
import { WebSocket } from 'ws';
import { handleTerminalStreamWebSocket } from './webuiChannel';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  pings = 0;
  sent: any[] = [];
  closes: Array<{ code?: number; reason?: string }> = [];

  ping() {
    this.pings += 1;
  }

  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }

  close(code?: number, reason?: string) {
    this.closes.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
  }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function request(terminalId = 'term_test'): http.IncomingMessage {
  return { url: `/api/terminals/stream?terminalId=${terminalId}` } as http.IncomingMessage;
}

function dependencies(overrides: Record<string, any> = {}) {
  return {
    checkIncomingToken: () => true,
    attachClient: async (terminalId: string) => ({
      terminal: { id: terminalId, nodeId: 'master', shell: '/bin/bash', cwd: '/tmp', cols: 80, rows: 24, createdAt: 1, pid: 2 },
      backlog: '',
    }),
    detachClient: () => {},
    close: async () => {},
    resize: () => {},
    resolveControlRequest: () => {},
    writeInput: () => {},
    keepaliveIntervalMs: 5,
    ...overrides,
  };
}

test('terminal stream starts protocol pings only after authentication and successful attach', async () => {
  const unauthorized = new FakeSocket();
  let unauthorizedAttachCalls = 0;
  await handleTerminalStreamWebSocket(unauthorized as any, request(), dependencies({
    checkIncomingToken: () => false,
    attachClient: async () => {
      unauthorizedAttachCalls += 1;
      throw new Error('must not attach');
    },
  }));
  await wait(12);
  assert.equal(unauthorizedAttachCalls, 0);
  assert.equal(unauthorized.pings, 0);
  assert.deepEqual(unauthorized.closes, [{ code: 1008, reason: 'Unauthorized' }]);

  const failedAttach = new FakeSocket();
  await handleTerminalStreamWebSocket(failedAttach as any, request(), dependencies({
    attachClient: async () => { throw new Error('missing terminal'); },
  }));
  await wait(12);
  assert.equal(failedAttach.pings, 0);
  assert.deepEqual(failedAttach.closes, [{ code: 1008, reason: 'missing terminal' }]);

  const delayedAttach = new FakeSocket();
  let finishAttach!: (value: any) => void;
  const attachResult = new Promise((resolve) => { finishAttach = resolve; });
  const handling = handleTerminalStreamWebSocket(delayedAttach as any, request(), dependencies({
    attachClient: () => attachResult,
  }));
  await wait(12);
  assert.equal(delayedAttach.pings, 0, 'keepalive must wait for successful attachment');
  finishAttach({
    terminal: { id: 'term_test', nodeId: 'master', shell: '/bin/bash', cwd: '/tmp', cols: 80, rows: 24, createdAt: 1, pid: 2 },
    backlog: '',
  });
  await handling;
  await wait(12);
  assert.ok(delayedAttach.pings >= 1);
  delayedAttach.emit('close');

  const closedDuringAttach = new FakeSocket();
  let detachCalls = 0;
  let finishClosedAttach!: (value: any) => void;
  const closedAttachResult = new Promise((resolve) => { finishClosedAttach = resolve; });
  const closedHandling = handleTerminalStreamWebSocket(closedDuringAttach as any, request(), dependencies({
    attachClient: () => closedAttachResult,
    detachClient: () => { detachCalls += 1; },
  }));
  closedDuringAttach.readyState = WebSocket.CLOSED;
  closedDuringAttach.emit('close');
  finishClosedAttach({
    terminal: { id: 'term_test', nodeId: 'master', shell: '/bin/bash', cwd: '/tmp', cols: 80, rows: 24, createdAt: 1, pid: 2 },
    backlog: '',
  });
  await closedHandling;
  await wait(12);
  assert.equal(closedDuringAttach.pings, 0);
  assert.equal(detachCalls, 1, 'a socket closed during attach detaches after attach completes');
});

test('terminal stream periodically pings an open socket and close detaches without killing the PTY', async () => {
  const socket = new FakeSocket();
  let detachCalls = 0;
  let closeCalls = 0;
  await handleTerminalStreamWebSocket(socket as any, request(), dependencies({
    detachClient: (terminalId: string, client: unknown) => {
      assert.equal(terminalId, 'term_test');
      assert.equal(client, socket);
      detachCalls += 1;
    },
    close: async () => { closeCalls += 1; },
  }));

  assert.equal(socket.sent[0].type, 'ready');
  await wait(18);
  assert.ok(socket.pings >= 2, `expected periodic protocol pings, received ${socket.pings}`);

  socket.emit('close');
  socket.emit('error', new Error('late duplicate event'));
  const pingsAtClose = socket.pings;
  await wait(12);
  assert.equal(socket.pings, pingsAtClose);
  assert.equal(detachCalls, 1);
  assert.equal(closeCalls, 0, 'transport close must not kill the backend PTY');
});

test('terminal stream error stops keepalive, closed sockets are skipped, and explicit close keeps kill semantics', async () => {
  const closedSocket = new FakeSocket();
  let detachCalls = 0;
  await handleTerminalStreamWebSocket(closedSocket as any, request(), dependencies({
    detachClient: () => { detachCalls += 1; },
  }));

  closedSocket.readyState = WebSocket.CLOSED;
  await wait(12);
  assert.equal(closedSocket.pings, 0, 'a closed socket must not be pinged');
  closedSocket.emit('close');

  const socket = new FakeSocket();
  const closeReasons: string[] = [];
  await handleTerminalStreamWebSocket(socket as any, request(), dependencies({
    detachClient: () => { detachCalls += 1; },
    close: async (_terminalId: string, reason: string) => { closeReasons.push(reason); },
  }));

  socket.emit('message', Buffer.from(JSON.stringify({ type: 'close' })));
  await wait(0);
  assert.deepEqual(closeReasons, ['ws-close-message']);

  socket.emit('error', new Error('transport failed'));
  const pingsAtError = socket.pings;
  await wait(12);
  assert.equal(socket.pings, pingsAtError);
  assert.equal(detachCalls, 2, 'each attached socket detaches exactly once');
});