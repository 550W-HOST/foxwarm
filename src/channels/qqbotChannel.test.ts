import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import WebSocket from 'ws';
import { registerChannel, unregisterChannel } from '../channel';
import * as llm from '../llm';
import { MessageRouter } from '../messageRouter';
import * as sessionManager from '../sessionManager';
import type { MessagePart, Session } from '../types';
import { parseQQBotConversationId, QQBotChannel } from './qqbotChannel';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: string[] = [];
  closed = false;

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.closed = true;
    this.readyState = WebSocket.CLOSED;
    this.emit('close', 1000, Buffer.alloc(0));
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit('open');
  }

  closeWith(code: number, reason = ''): void {
    this.readyState = WebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function flush(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, timeoutMs = 250): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for QQ Bot test condition');
    }
    await new Promise(resolve => setTimeout(resolve, 2));
  }
}

function emitGateway(socket: FakeSocket, frame: object): void {
  socket.emit('message', Buffer.from(JSON.stringify(frame)));
}

function activateForDirectSend(channel: QQBotChannel): void {
  (channel as any).stopped = false;
  (channel as any).connectionGeneration = 1;
}

test('QQ Bot parses scoped conversation targets', () => {
  assert.deepEqual(parseQQBotConversationId('c2c:openid'), { kind: 'c2c', id: 'openid' });
  assert.deepEqual(parseQQBotConversationId('group:group:with:colon'), { kind: 'group', id: 'group:with:colon' });
  assert.throws(() => parseQQBotConversationId('openid'), /conversationId/);
  assert.throws(() => parseQQBotConversationId('unknown:target'), /conversationId/);
});

test('QQ Bot deduplicates by business message sequence/index, not gateway sequence', async () => {
  const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' });
  const received: string[] = [];
  channel.onMessage(async (_ctx, message) => { received.push(message.parts[0].text || ''); });
  const c2c = (msgSeq: string, content: string, ext?: unknown) => ({
    id: 'same-c2c-id', msg_seq: msgSeq, content, author: { user_openid: 'openid-1' }, ...(ext === undefined ? {} : { message_scene: { ext } }),
  });
  const group = (msgIdx: number, content: string) => ({
    id: 'same-group-id', content, group_openid: 'group-1', author: { member_openid: 'member-1' }, message_scene: { ext: ['ref_msg_idx=ignored', `msg_idx=${msgIdx}`] },
  });

  await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', c2c('10', 'c2c first'), 100);
  await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', c2c('10', 'c2c duplicate'), 101);
  await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', c2c('11', 'c2c next business message'), 100);
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', group(3, 'group first'), 200);
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', group(3, 'group duplicate'), 201);
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', group(4, 'group next business message'), 200);
  const oversizedExt = Array.from({ length: 33 }, () => 'ignored=value');
  await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', { ...c2c('20', 'malformed ext still uses msg seq', oversizedExt), id: 'malformed-ext-id' }, 300);
  await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', { ...c2c('20', 'malformed ext duplicate', oversizedExt), id: 'malformed-ext-id' }, 301);
  await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', { ...c2c('21', 'malformed ext next msg seq', oversizedExt), id: 'malformed-ext-id' }, 300);
  const ambiguousExt = ['msg_idx=1', 'msg_idx=2'];
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', { ...group(5, 'ambiguous ext id fallback'), id: 'ambiguous-ext-id', message_scene: { ext: ambiguousExt } }, 400);
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', { ...group(6, 'ambiguous ext duplicate'), id: 'ambiguous-ext-id', message_scene: { ext: ambiguousExt } }, 401);

  assert.deepEqual(received, ['c2c first', 'c2c next business message', 'group first', 'group next business message', 'malformed ext still uses msg seq', 'malformed ext next msg seq', 'ambiguous ext id fallback']);
});

test('QQ Bot accepts C2C/group attachment-only turns with safe metadata and keeps attachment order', async () => {
  const received: any[] = [];
  const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-media-preview');
  channel.onMessage(async (ctx, message) => { received.push({ ctx, message }); });

  await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
    id: 'c2c-media-only',
    content: '',
    author: { user_openid: 'openid-1' },
    attachments: [
      { filename: 'first.png', content_type: 'image/png', size: 10, url: 'https://qpic.cn/first' },
      { filename: 'second.txt', content_type: 'file', size: 20, url: 'https://qpic.cn/second' },
    ],
  });
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
    id: 'group-media-only',
    content: '',
    group_openid: 'group-1',
    author: { member_openid: 'member-1' },
    attachments: [{ filename: 'group.bin', content_type: 'file', url: 'https://qpic.cn/group' }],
  });

  assert.equal(received.length, 2);
  assert.equal(received[0].ctx.conversationId, 'c2c:openid-1');
  assert.match(received[0].message.parts[0].text || '', /first\.png/);
  assert.match(received[0].message.parts[1].text || '', /second\.txt/);
  assert.equal(typeof received[0].message.materializeParts, 'function');
  assert.equal(received[1].ctx.conversationId, 'group:group-1');
  assert.match(received[1].message.parts[0].text || '', /group\.bin/);
});

test('QQ Bot deduplication happens before media download and duplicate delivery materializes once', async () => {
  let fetchCount = 0;
  let saveCount = 0;
  let capturedMessage: any;
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    'qq-media-dedup',
    {
      fetch: async () => {
        fetchCount += 1;
        return new Response('file bytes', { status: 200 });
      },
      saveInboundSessionFileFromPath: async (options: any) => {
        saveCount += 1;
        return {
          agentName: 'main', nodeId: 'master', absolutePath: '/tmp/qq-file', promptPath: '/tmp/qq-file',
          fileName: options.fileName, mimeType: options.mimeType, sizeBytes: options.sizeBytes, isImage: false,
        };
      },
    },
  );
  channel.onMessage(async (_ctx, message) => { capturedMessage = message; });

  const event = {
    id: 'same-media-id',
    content: 'file',
    group_openid: 'group-1',
    author: { member_openid: 'member-1' },
    message_scene: { ext: ['msg_idx=media-1'] },
    attachments: [{ filename: 'file.txt', content_type: 'file', url: 'https://qpic.cn/file' }],
  };
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', event, 1);
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', { ...event, content: 'duplicate' }, 2);

  assert.equal(typeof capturedMessage.materializeParts, 'function');
  await capturedMessage.materializeParts('session-1');
  assert.equal(fetchCount, 1);
  assert.equal(saveCount, 1);
});

test('QQ Bot gateway identifies, resumes, reconnects, and fences stop races', async (t) => {
  const sockets: FakeSocket[] = [];
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    'qq-gateway',
    {
      fetch: async (url: string | URL | Request) => String(url).includes('getAppAccessToken')
        ? response({ access_token: 'token', expires_in: 7200 })
        : response({ url: 'wss://gateway.example.test' }),
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as any;
      },
      reconnectDelaysMs: [1],
      invalidSessionReconnectDelayMs: 1,
    },
  );
  t.after(async () => channel.stop());

  const starting = channel.start();
  await waitFor(() => sockets.length === 1);
  sockets[0].open();
  await starting;
  emitGateway(sockets[0], { op: 10, d: { heartbeat_interval: 5 } });
  await flush();
  assert.equal(JSON.parse(sockets[0].sent[0]).op, 2);
  emitGateway(sockets[0], { op: 0, s: 41, t: 'READY', d: { session_id: 'session-1' } });
  await new Promise(resolve => setTimeout(resolve, 6));
  assert.equal(JSON.parse(sockets[0].sent[sockets[0].sent.length - 1] || '{}').d, 41);
  emitGateway(sockets[0], { op: 11, d: null });

  sockets[0].closeWith(1006);
  await waitFor(() => sockets.length === 2);
  sockets[1].open();
  emitGateway(sockets[1], { op: 10, d: { heartbeat_interval: 0 } });
  await flush();
  const resume = JSON.parse(sockets[1].sent[0]);
  assert.deepEqual(resume, { op: 6, d: { token: 'QQBot token', session_id: 'session-1', seq: 41 } });
  emitGateway(sockets[1], { op: 0, s: 42, t: 'RESUMED', d: {} });
  emitGateway(sockets[1], { op: 11, d: null });
  await flush();
  assert.equal(typeof (channel as any).lastHeartbeatAckAt, 'number');

  emitGateway(sockets[1], { op: 7, d: null });
  await waitFor(() => sockets.length === 3);
  sockets[2].open();
  emitGateway(sockets[2], { op: 10, d: { heartbeat_interval: 0 } });
  await flush();
  assert.equal(JSON.parse(sockets[2].sent[0]).op, 6);

  emitGateway(sockets[2], { op: 9, d: true });
  await waitFor(() => sockets.length === 4);
  sockets[3].open();
  emitGateway(sockets[3], { op: 10, d: { heartbeat_interval: 0 } });
  await flush();
  assert.equal(JSON.parse(sockets[3].sent[0]).op, 6);

  emitGateway(sockets[3], { op: 9, d: false });
  await waitFor(() => sockets.length === 5);
  sockets[4].open();
  emitGateway(sockets[4], { op: 10, d: { heartbeat_interval: 0 } });
  await flush();
  assert.equal(JSON.parse(sockets[4].sent[0]).op, 2);

  sockets[4].closeWith(1006);
  await channel.stop();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(sockets.length, 5);
});

test('QQ Bot routes C2C text and uses the latest conversation-local passive reply id', async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const socket = new FakeSocket();
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    'qq-primary',
    {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('getAppAccessToken')) return response({ access_token: 'token', expires_in: 7200 });
        if (String(url).endsWith('/gateway')) return response({ url: 'wss://gateway.example.test' });
        return response({ id: 'outbound-id' });
      },
      createWebSocket: () => socket as any,
    },
  );
  t.after(async () => channel.stop());

  const received: any[] = [];
  channel.onMessage(async (ctx, message) => {
    received.push({ ctx, message });
  });

  const starting = channel.start();
  await flush();
  socket.open();
  await starting;
  socket.emit('message', Buffer.from(JSON.stringify({ op: 10, d: { heartbeat_interval: 0 } })));
  await flush();
  assert.equal(JSON.parse(socket.sent[0]).d.intents, 1_174_409_216);

  socket.emit('message', Buffer.from(JSON.stringify({
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: { id: 'incoming-1', content: 'hello', author: { user_openid: 'openid-1' } },
  })));
  await flush();

  assert.equal(received[0].ctx.channelId, 'qq-primary');
  assert.equal(received[0].ctx.channelType, 'qqbot');
  assert.equal(received[0].ctx.conversationId, 'c2c:openid-1');
  assert.equal(received[0].ctx.senderId, 'openid-1');
  assert.equal(received[0].ctx.qqbotMessageId, 'incoming-1');
  assert.equal(received[0].ctx.preferDirectReply, true);
  assert.deepEqual(received[0].message.parts, [{ text: 'hello' }]);
  emitGateway(socket, { op: 0, s: 5, t: 'C2C_MESSAGE_CREATE', d: { id: 'incoming-1', content: 'duplicate', author: { user_openid: 'openid-1' } } });
  emitGateway(socket, { op: 0, s: 6, t: 'C2C_MESSAGE_CREATE', d: { id: 'incoming-2', content: 'new message', author: { user_openid: 'openid-1' } } });
  emitGateway(socket, { op: 0, s: 7, t: 'C2C_MESSAGE_CREATE', d: { id: 'incoming-3', content: 'newest message', author: { user_openid: 'openid-1' } } });
  await flush();
  assert.equal(received.length, 3);

  await received[0].ctx.sendTyping();
  await received[0].ctx.reply('reply text');
  await channel.sendMessage('c2c:openid-1', 'queued final', {
    qqbotMessageId: 'incoming-1',
    qqbotChannelId: 'qq-primary',
    qqbotConversationId: 'c2c:openid-1',
  });
  const typing = calls.find(call => String(call.init?.body).includes('input_notify'));
  const reply = calls.find(call => String(call.init?.body).includes('reply text'));
  assert.equal(typing?.url, 'https://api.sgroup.qq.com/v2/users/openid-1/messages');
  assert.match(String(typing?.init?.body), /"msg_id":"incoming-3"/);
  assert.match(String(typing?.init?.body), /"msg_seq":1/);
  assert.equal(reply?.url, 'https://api.sgroup.qq.com/v2/users/openid-1/messages');
  assert.match(String(reply?.init?.body), /"msg_id":"incoming-1"/);
  assert.match(String(reply?.init?.body), /"msg_seq":1/);
  const queuedFinal = calls.find(call => String(call.init?.body).includes('queued final'));
  assert.match(String(queuedFinal?.init?.body), /"msg_id":"incoming-3"/);
  assert.match(String(queuedFinal?.init?.body), /"msg_seq":2/);
  await channel.sendMessage('c2c:openid-1', 'second-message reply', { replyToId: 'incoming-2' });
  const secondMessageReply = calls.find(call => String(call.init?.body).includes('second-message reply'));
  assert.match(String(secondMessageReply?.init?.body), /"msg_seq":1/);

  await channel.stop();
  assert.equal(socket.closed, true);
});

test('QQ Bot busy follow-up joins the active tool loop and one final uses its latest message id', async () => {
  const channelId = `qq-latest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `session-${channelId}`;
  const outbound: Array<{ url: string; body: any }> = [];
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    channelId,
    {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        const resolvedUrl = String(url);
        if (resolvedUrl.includes('getAppAccessToken')) {
          return response({ access_token: 'token', expires_in: 7200 });
        }
        outbound.push({ url: resolvedUrl, body: JSON.parse(String(init?.body || '{}')) });
        return response({ id: `outbound-${outbound.length}` });
      },
    },
  );
  const router = new MessageRouter([{ platform: 'qqbot', userId: 'openid-1' }]);
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  let toolStarted!: () => void;
  let releaseTool!: () => void;
  const toolStartedPromise = new Promise<void>(resolve => { toolStarted = resolve; });
  const releaseToolPromise = new Promise<void>(resolve => { releaseTool = resolve; });
  let chatCalls = 0;

  activateForDirectSend(channel);
  registerChannel(channelId, channel);
  channel.onMessage((ctx, message) => router.handleMessage(ctx, message));

  try {
    const session = await sessionManager.getSession(sessionId);
    sessionManager.attachChannel(channelId, 'c2c:openid-1', sessionId);

    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
      chatCalls += 1;
      if (parts) {
        await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
      }
      if (chatCalls === 1) {
        const toolCall = { id: 'call-1', name: 'read', args: { filePath: 'README.md' } };
        await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ functionCall: toolCall }] });
        return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
      }
      await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ text: 'combined final' }] });
      return { text: 'combined final', allParts: [{ text: 'combined final' }] };
    };
    (llm as any).executeTools = async () => {
      toolStarted();
      await releaseToolPromise;
      return {
        role: 'tool',
        parts: [{ functionResponse: { tool_use_id: 'call-1', name: 'read', response: { output: 'ok' } } }],
      };
    };

    const firstRun = (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
      id: 'qq-1', content: 'first input', author: { user_openid: 'openid-1' },
    }, 1);
    await toolStartedPromise;
    await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
      id: 'qq-2', content: 'second steering', author: { user_openid: 'openid-1' },
    }, 2);

    assert.equal(session.queue.length, 1);
    releaseTool();
    await firstRun;
    await waitFor(() => outbound.some(call => call.body.content === 'combined final'));

    assert.equal(chatCalls, 2);
    assert.equal(session.queue.length, 0);
    const userMessages = session.history.filter(message => message.role === 'user');
    assert.equal(userMessages.length, 2);
    assert.equal(userMessages.some(message => message.parts.some(part => part.system?.includes('second steering'))), true);
    const finals = outbound.filter(call => call.body.content === 'combined final');
    assert.equal(finals.length, 1);
    assert.equal(finals[0].body.msg_id, 'qq-2');
    assert.equal((channel as any).latestMessageIds.size, 1);
    await channel.stop();
    assert.equal((channel as any).latestMessageIds.size, 0);
  } finally {
    releaseTool?.();
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    unregisterChannel(channelId);
    await channel.stop();
    const cleanupSession = await sessionManager.getSession(sessionId).catch((): null => null);
    if (cleanupSession) {
      cleanupSession.busy = false;
      await sessionManager.saveSession(sessionId).catch(() => {});
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }
  }
});

test('QQ Bot follow-up arriving during the final provider request is absorbed before delivery', async () => {
  const channelId = `qq-final-safe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sessionId = `session-${channelId}`;
  const outbound: any[] = [];
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    channelId,
    {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('getAppAccessToken')) {
          return response({ access_token: 'token', expires_in: 7200 });
        }
        outbound.push(JSON.parse(String(init?.body || '{}')));
        return response({ id: `outbound-${outbound.length}` });
      },
    },
  );
  const router = new MessageRouter([{ platform: 'qqbot', userId: 'openid-1' }]);
  const originalChat = llm.chat;
  let firstRequestStarted!: () => void;
  let releaseFirstRequest!: () => void;
  const firstRequestStartedPromise = new Promise<void>(resolve => { firstRequestStarted = resolve; });
  const releaseFirstRequestPromise = new Promise<void>(resolve => { releaseFirstRequest = resolve; });
  let chatCalls = 0;

  activateForDirectSend(channel);
  registerChannel(channelId, channel);
  channel.onMessage((ctx, message) => router.handleMessage(ctx, message));

  try {
    const session = await sessionManager.getSession(sessionId);
    sessionManager.attachChannel(channelId, 'c2c:openid-1', sessionId);
    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
      chatCalls += 1;
      if (parts) {
        await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
      }
      if (chatCalls === 1) {
        firstRequestStarted();
        await releaseFirstRequestPromise;
        await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ text: 'intermediate answer' }] });
        return { text: 'intermediate answer', allParts: [{ text: 'intermediate answer' }] };
      }
      assert.equal(activeSession.history.some(message => message.parts.some(part => part.system?.includes('late steering'))), true);
      await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ text: 'answer to late steering' }] });
      return { text: 'answer to late steering', allParts: [{ text: 'answer to late steering' }] };
    };

    const firstRun = (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
      id: 'qq-final-1', content: 'first input', author: { user_openid: 'openid-1' },
    }, 1);
    await firstRequestStartedPromise;
    await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
      id: 'qq-final-2', content: 'late steering', author: { user_openid: 'openid-1' },
    }, 2);
    assert.equal(session.queue.length, 1);

    releaseFirstRequest();
    await firstRun;
    await waitFor(() => outbound.some(body => body.content === 'answer to late steering'));

    assert.equal(chatCalls, 2);
    assert.equal(session.history.filter(message => message.role === 'user').length, 2);
    assert.equal(outbound.some(body => body.content === 'intermediate answer'), false);
    const finals = outbound.filter(body => body.content === 'answer to late steering');
    assert.equal(finals.length, 1);
    assert.equal(finals[0].msg_id, 'qq-final-2');
  } finally {
    releaseFirstRequest?.();
    (llm as any).chat = originalChat;
    unregisterChannel(channelId);
    await channel.stop();
    const cleanupSession = await sessionManager.getSession(sessionId).catch((): null => null);
    if (cleanupSession) {
      cleanupSession.busy = false;
      await sessionManager.saveSession(sessionId).catch(() => {});
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }
  }
});

test('QQ Bot uses the persisted bound message id when no live conversation context exists', async () => {
  const outbound: any[] = [];
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    'qq-restart-fallback',
    {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('getAppAccessToken')) {
          return response({ access_token: 'token', expires_in: 7200 });
        }
        outbound.push(JSON.parse(String(init?.body || '{}')));
        return response({ id: 'outbound-1' });
      },
    },
  );
  activateForDirectSend(channel);

  await channel.sendMessage('group:group-1', 'restart fallback', {
    qqbotMessageId: 'persisted-msg-id',
    qqbotChannelId: 'qq-restart-fallback',
    qqbotConversationId: 'group:group-1',
  });

  assert.equal(outbound[0].msg_id, 'persisted-msg-id');
  await channel.stop();
});

test('QQ Bot uses the bounded local passive-reply policy without inferring server errors', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let failPassive = false;
  let failProactive = false;
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    'qq-limiter',
    {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('getAppAccessToken')) return response({ access_token: 'token', expires_in: 7200 });
        const body = JSON.parse(String(init?.body || '{}'));
        if (failPassive && body.msg_id === 'unknown-failure') return response({ code: 999999, message: 'unknown' }, 400);
        if (failProactive && !body.msg_id) return response({ code: 999998, message: 'proactive failed' }, 400);
        return response({ id: 'outbound-id' });
      },
    },
  );
  activateForDirectSend(channel);
  const sendBound = (messageId: string, text: string, turnFinal = false) => channel.sendMessage('c2c:openid-1', text, {
    replyToId: messageId,
    qqbotSourceBound: true,
    turnFinal,
  });

  await Promise.all([1, 2, 3, 4].map(index => sendBound('limit-id', `passive-${index}`)));
  await sendBound('limit-id', 'proactive-after-four', true);
  const limitBodies = calls
    .filter(call => String(call.url).includes('/v2/users/'))
    .map(call => JSON.parse(String(call.init?.body || '{}')));
  assert.equal(limitBodies.filter(body => body.msg_id === 'limit-id').length, 4);
  assert.equal(limitBodies[4].msg_id, undefined);

  await sendBound('independent-id', 'independent', true);
  const independent = calls.find(call => String(call.init?.body).includes('independent'));
  assert.equal(JSON.parse(String(independent?.init?.body)).msg_id, 'independent-id');

  const contexts = (channel as any).passiveReplyContexts as Map<string, { firstSeenAt: number; successfulTextReplies: number }>;
  contexts.set('expired-id', { firstSeenAt: Date.now() - 3_600_001, successfulTextReplies: 0 });
  await sendBound('expired-id', 'expired proactive', true);
  const expired = calls.find(call => String(call.init?.body).includes('expired proactive'));
  assert.equal(JSON.parse(String(expired?.init?.body)).msg_id, undefined);

  failPassive = true;
  const beforeUnknownFailure = calls.length;
  await sendBound('unknown-failure', 'unknown passive failure', true);
  assert.equal(calls.length, beforeUnknownFailure + 1);
  assert.equal(JSON.parse(String(calls[calls.length - 1].init?.body)).msg_id, 'unknown-failure');

  contexts.set('proactive-failure', { firstSeenAt: Date.now(), successfulTextReplies: 4 });
  failPassive = false;
  failProactive = true;
  const beforeProactiveFailure = calls.length;
  await sendBound('proactive-failure', 'proactive failure', true);
  assert.equal(calls.length, beforeProactiveFailure + 1);
  assert.equal(JSON.parse(String(calls[calls.length - 1].init?.body)).msg_id, undefined);

  failPassive = true;
  await assert.rejects(
    channel.sendMessage('c2c:openid-1', 'ordinary direct failure', { replyToId: 'unknown-failure' }),
    /QQ Bot API POST/,
  );
});

test('QQ Bot serializes concurrent source-bound replies per inbound message ID', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const release: Array<() => void> = [];
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    'qq-concurrent-limiter',
    {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('getAppAccessToken')) return response({ access_token: 'token', expires_in: 7200 });
        await new Promise<void>(resolve => release.push(resolve));
        return response({ id: 'outbound-id' });
      },
    },
  );
  activateForDirectSend(channel);
  const sends = Array.from({ length: 5 }, (_, index) => channel.sendMessage('c2c:openid-1', `concurrent-${index}`, {
    replyToId: 'concurrent-id',
    qqbotSourceBound: true,
  }));

  await waitFor(() => release.length === 1);
  const bodies = () => calls
    .filter(call => String(call.url).includes('/v2/users/'))
    .map(call => JSON.parse(String(call.init?.body || '{}')));
  assert.equal(bodies().length, 1);
  assert.equal(bodies()[0].msg_id, 'concurrent-id');
  for (let index = 0; index < 4; index += 1) {
    release.shift()?.();
    await waitFor(() => release.length === 1 || bodies().length === 5);
  }
  assert.equal(bodies().length, 5);
  assert.equal(bodies().filter(body => body.msg_id === 'concurrent-id').length, 4);
  assert.equal(bodies()[4].msg_id, undefined);
  release.shift()?.();
  await Promise.all(sends);
});

test('QQ Bot fences queued source-bound replies across stop and a new generation', async () => {
  const release: Array<() => void> = [];
  const outboundBodies: any[] = [];
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    'qq-generation-fence',
    {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('getAppAccessToken')) return response({ access_token: 'token', expires_in: 7200 });
        outboundBodies.push(JSON.parse(String(init?.body || '{}')));
        await new Promise<void>(resolve => release.push(resolve));
        return response({ id: 'outbound-id' });
      },
    },
  );
  activateForDirectSend(channel);
  const oldFirst = channel.sendMessage('c2c:openid-1', 'old first', { replyToId: 'generation-id', qqbotSourceBound: true });
  const oldQueuedDirect = channel.sendMessage('c2c:openid-1', 'old queued direct', { replyToId: 'generation-id', qqbotSourceBound: true });
  const oldQueuedFinal = channel.sendMessage('c2c:openid-1', 'old queued final', { replyToId: 'generation-id', qqbotSourceBound: true, turnFinal: true });
  await waitFor(() => release.length === 1);

  await channel.stop();
  assert.equal((channel as any).passiveReplyChains.size, 0);
  assert.equal((channel as any).passiveReplyContexts.size, 0);
  (channel as any).stopped = false;
  (channel as any).connectionGeneration += 1;
  const newGeneration = channel.sendMessage('c2c:openid-1', 'new generation', { replyToId: 'generation-id', qqbotSourceBound: true });
  await waitFor(() => release.length === 2);

  release.shift()?.();
  await oldFirst;
  await assert.rejects(oldQueuedDirect, /invalidated before delivery/);
  await oldQueuedFinal;
  assert.equal(outboundBodies.length, 2);
  assert.equal(outboundBodies.some(body => body.content === 'old queued direct' || body.content === 'old queued final'), false);

  release.shift()?.();
  await newGeneration;
  assert.equal((channel as any).passiveReplyChains.size, 0);
});

test('QQ Bot source-bound final failure completes through MessageRouter without a second reply', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    'qq-router-failure',
    {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('getAppAccessToken')) return response({ access_token: 'token', expires_in: 7200 });
        return response({ code: 999999, message: 'unknown passive error' }, 400);
      },
    },
  );
  activateForDirectSend(channel);
  let sourceCtx: any;
  channel.onMessage(async (ctx) => { sourceCtx = ctx; });
  await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
    id: 'router-failure-id', content: 'inbound', author: { user_openid: 'openid-1' },
  });

  const router = new MessageRouter() as any;
  await router.sendFinalResponse({ broadcast: () => {} }, sourceCtx, 'model final', false);
  const outbound = calls.filter(call => String(call.url).includes('/v2/users/'));
  assert.equal(outbound.length, 1);
  assert.equal(JSON.parse(String(outbound[0].init?.body)).msg_id, 'router-failure-id');
});

test('QQ Bot maps group, guild, and guild-DM sends while keeping guild media unsupported', async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const socket = new FakeSocket();
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    'qq-secondary',
    {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('getAppAccessToken')) return response({ access_token: 'token', expires_in: 7200 });
        if (String(url).endsWith('/gateway')) return response({ url: 'wss://gateway.example.test' });
        return response({ id: 'outbound-id' });
      },
      createWebSocket: () => socket as any,
    },
  );
  t.after(async () => channel.stop());
  const received: any[] = [];
  channel.onMessage(async (ctx, message) => { received.push({ ctx, message }); });

  const starting = channel.start();
  await flush();
  socket.open();
  await starting;
  socket.emit('message', Buffer.from(JSON.stringify({ op: 0, t: 'AT_MESSAGE_CREATE', d: { id: 'guild-media-only', content: '', channel_id: 'channel-1', guild_id: 'guild-1', author: { id: 'member-1' }, attachments: [{ url: 'https://qpic.cn/image', content_type: 'image/png' }] } })));
  await flush();
  assert.equal(received.length, 0);
  socket.emit('message', Buffer.from(JSON.stringify({ op: 0, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'group-incoming', content: 'group hello', group_openid: 'group-1', author: { member_openid: 'member-1', username: 'Member' } } })));
  await flush();
  assert.equal(received[0].ctx.conversationId, 'group:group-1');
  assert.equal(received[0].ctx.senderId, 'member-1');

  await channel.sendMessage('group:group-1', 'group reply', { replyToId: 'group-incoming' });
  await channel.sendMessage('guild:channel-1', 'guild reply', { replyToId: 'guild-incoming' });
  await channel.sendMessage('dm:guild-1', 'dm reply', { replyToId: 'dm-incoming' });

  const outbound = calls.filter(call => call.init?.method === 'POST' && String(call.url).includes('api.sgroup.qq.com'));
  assert.equal(outbound[0].url, 'https://api.sgroup.qq.com/v2/groups/group-1/messages');
  assert.match(String(outbound[0].init?.body), /"msg_id":"group-incoming"/);
  assert.equal(outbound[1].url, 'https://api.sgroup.qq.com/channels/channel-1/messages');
  assert.match(String(outbound[1].init?.body), /"msg_id":"guild-incoming"/);
  assert.equal(outbound[2].url, 'https://api.sgroup.qq.com/dms/guild-1/messages');
  assert.match(String(outbound[2].init?.body), /"msg_id":"dm-incoming"/);

  await channel.stop();
});
