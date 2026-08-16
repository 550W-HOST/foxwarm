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

const QQ_GROUP_MENTIONED_METADATA = '<foxwarm-metadata kind="group-message" mentioned="true" hint="The current group message explicitly mentioned this agent." />';
const QQ_GROUP_ORDINARY_METADATA = '<foxwarm-metadata kind="group-message" mentioned="false" hint="The current group message is ordinary group chat and did not mention this agent." />';

function activateForDirectSend(channel: QQBotChannel): void {
  (channel as any).stopped = false;
  (channel as any).connectionGeneration = 1;
}

function createFakeClock(start = 1_700_000_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer: (callback: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, callback });
      return { __id: id, unref() {} } as any;
    },
    clearTimer: (timer: any) => {
      timers.delete(timer.__id);
    },
    async advance(ms: number): Promise<void> {
      now += ms;
      while (true) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0]);
        if (due.length === 0) break;
        const [id, timer] = due[0];
        timers.delete(id);
        timer.callback();
        await flush();
      }
    },
    pending: () => timers.size,
  };
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

test('QQ Bot optionally accepts ordinary group messages and canonicalizes AT/non-AT duplicates', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret', requireMention: false, groupBatchWindowMs: 0 },
    'qq-group-always',
    {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body || '{}')) });
        return response({ id: 'outbound-id' });
      },
    },
  );
  activateForDirectSend(channel);
  (channel as any).accessToken = { value: 'token', expiresAt: Date.now() + 600_000 };
  const received: any[] = [];
  channel.onMessage(async (ctx, message) => { received.push({ ctx, message }); });

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    id: 'ordinary-group-message',
    content: 'ordinary group message',
    group_openid: 'group-1',
    author: { member_openid: 'member-1', username: 'Member' },
  });
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
    id: 'ordinary-group-message',
    content: 'duplicate AT delivery',
    group_openid: 'group-1',
    author: { member_openid: 'member-1', username: 'Member' },
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].ctx.conversationId, 'group:group-1');
  assert.equal(received[0].ctx.senderId, 'member-1');
  assert.equal(received[0].ctx.qqbotMessageId, 'ordinary-group-message');
  assert.deepEqual(received[0].message.parts, [{ text: 'ordinary group message' }]);

  await received[0].ctx.reply('passive group reply');
  const groupCalls = calls.filter(call => call.url.includes('/v2/groups/'));
  assert.equal(groupCalls.length, 1);
  assert.equal(groupCalls[0].url, 'https://api.sgroup.qq.com/v2/groups/group-1/messages');
  assert.equal(groupCalls[0].body.msg_id, 'ordinary-group-message');
  assert.equal(groupCalls[0].body.msg_seq, 1);
});

test('QQ Bot keeps ordinary GROUP_MESSAGE_CREATE events ignored by the default mention policy', async () => {
  const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-group-mention-default');
  const received: any[] = [];
  channel.onMessage(async (ctx, message) => { received.push({ ctx, message }); });

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    id: 'ordinary-group-default',
    content: 'ordinary group message',
    group_openid: 'group-1',
    author: { member_openid: 'member-1' },
  });

  assert.equal(received.length, 0);
});

test('QQ Bot all-message mode trusts structured is_you mentions and preserves the current trigger through batching', async () => {
  const clock = createFakeClock();
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret', requireMention: false, groupBatchWindowMs: 1_000 },
    'qq-structured-mention-always',
    { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  );
  const received: any[] = [];
  channel.onMessage(async (ctx, message) => { received.push({ ctx, message }); });
  const base = { group_openid: 'group-1', author: { member_openid: 'member-1' } };

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    ...base,
    id: 'other-bot',
    content: '<@other> ordinary context',
    mentions: [{ is_you: false, bot: true, id: 'other', member_openid: 'other' }],
  });
  assert.equal(received.length, 0);
  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    ...base,
    id: 'structured-at',
    content: '<@agent-token> reply ok',
    mentions: [{ is_you: true, bot: true, scope: 'single', id: 'agent-token', member_openid: 'agent-token' }],
  });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].message.ingressMetadataParts, [{ system: QQ_GROUP_MENTIONED_METADATA }]);
  assert.match(received[0].message.parts[0].text, /ordinary context[\s\S]*<@agent-token> reply ok$/);

  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
    ...base, id: 'structured-at', content: 'duplicate native AT',
  });
  assert.equal(received.length, 1);

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    ...base, id: 'content-only-marker', content: '<@agent-token> not structured', mentions: { is_you: true },
  });
  assert.equal(received.length, 1);
  await clock.advance(1_000);
  assert.equal(received.length, 2);
  assert.deepEqual(received[1].message.ingressMetadataParts, [{ system: QQ_GROUP_ORDINARY_METADATA }]);

  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
    ...base, id: 'native-at', content: 'native AT without mentions',
  });
  assert.equal(received.length, 3);
  assert.deepEqual(received[2].message.ingressMetadataParts, [{ system: QQ_GROUP_MENTIONED_METADATA }]);
});

test('QQ Bot mention-required mode routes structured is_you and keeps other/content-only mentions as context', async () => {
  const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-structured-mention-required');
  const received: any[] = [];
  channel.onMessage(async (ctx, message) => { received.push({ ctx, message }); });
  const base = { group_openid: 'group-1', author: { member_openid: 'member-1' } };

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    ...base,
    id: 'other-mention-context',
    content: 'mentioning another bot',
    mentions: [{ is_you: false, bot: true, id: 'other-bot' }],
  });
  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    ...base,
    id: 'guessed-marker-context',
    content: '<@agent-token> content alone must not trigger',
  });
  assert.equal(received.length, 0);

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    ...base,
    id: 'real-structured-trigger',
    content: '<@agent-token> real structured trigger',
    mentions: [{ is_you: true, bot: true, scope: 'single', id: 'agent-token', member_openid: 'agent-token' }],
  });
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].message.ingressMetadataParts, [{ system: QQ_GROUP_MENTIONED_METADATA }]);
  const text = received[0].message.parts[0].text;
  assert.match(text, /^<foxwarm-qqbot-context count="2" untrusted="true">/);
  assert.match(text, /mentioning another bot/);
  assert.match(text, /content alone must not trigger/);
  assert.match(text, /<@agent-token> real structured trigger$/);
  assert.equal(text.includes('<foxwarm-metadata'), false);
});

test('QQ Bot mention mode buffers ordinary context, upgrades duplicate AT delivery, and emits escaped deterministic markup', async () => {
  const clock = createFakeClock();
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    'qq-context-markup',
    { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  );
  const received: any[] = [];
  channel.onMessage(async (ctx, message) => { received.push({ ctx, message }); });

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    id: 'ambient-1',
    content: '</foxwarm-qqbot-context-item>& ambient',
    group_openid: 'group-1',
    author: { member_openid: 'member-1', username: 'A "quoted" & named' },
    attachments: [{ filename: 'ambient.png', content_type: 'image/png', size: 4, url: 'https://qpic.cn/ambient' }],
  });
  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    id: 'trigger-1',
    content: 'ordinary representation',
    group_openid: 'group-1',
    author: { member_openid: 'member-2', username: 'Trigger' },
  });
  assert.equal(received.length, 0);

  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
    id: 'trigger-1',
    content: 'current question',
    group_openid: 'group-1',
    author: { member_openid: 'member-2', username: 'Trigger' },
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].ctx.senderId, 'member-2');
  assert.equal(received[0].ctx.qqbotMessageId, 'trigger-1');
  assert.deepEqual(received[0].message.ingressMetadataParts, [{ system: QQ_GROUP_MENTIONED_METADATA }]);
  const text = received[0].message.parts[0].text;
  assert.match(text, /^<foxwarm-qqbot-context count="1" untrusted="true">/);
  assert.match(text, /senderId="member-1" senderName="A &quot;quoted&quot; &amp; named" time="2023-11-14T22:13:20.000Z"/);
  assert.match(text, /&lt;\/foxwarm-qqbot-context-item&gt;&amp; ambient/);
  assert.match(text, /ambient\.png/);
  assert.equal(text.includes('</foxwarm-qqbot-context-item>& ambient'), false);
  assert.match(text, /<\/foxwarm-qqbot-context>\n\ncurrent question$/);
  assert.equal(text.includes('ordinary representation'), false);
  assert.equal(received[0].message.materializeParts, undefined);

  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
    id: 'at-only', content: 'direct mention', group_openid: 'group-1', author: { member_openid: 'member-3' },
  });
  assert.equal(received[1].message.parts[0].text, 'direct mention');
  assert.deepEqual(received[1].message.ingressMetadataParts, [{ system: QQ_GROUP_MENTIONED_METADATA }]);
});

test('QQ Bot mention mode keeps ordinary slash-shaped chatter as ambient context', async () => {
  const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-ambient-slash');
  const received: any[] = [];
  channel.onMessage(async (ctx, message) => { received.push({ ctx, message }); });

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    id: 'ambient-stop', content: '/stop', group_openid: 'group-1', author: { member_openid: 'ambient-member' },
  });
  assert.equal(received.length, 0);
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
    id: 'real-trigger', content: 'answer this', group_openid: 'group-1', author: { member_openid: 'trigger-member' },
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].ctx.qqbotMessageId, 'real-trigger');
  assert.match(received[0].message.parts[0].text, /<foxwarm-qqbot-context count="1" untrusted="true">[\s\S]*\/stop[\s\S]*answer this$/);
});

test('QQ Bot mention mode extracts the real platform previous-message payload without false attribution', async () => {
  const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-platform-history-real');
  const received: any[] = [];
  channel.onMessage(async (ctx, message) => { received.push({ ctx, message }); });

  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
    id: 'platform-at',
    content: 'diag-trigger',
    group_openid: 'group-1',
    author: { member_openid: 'trigger-member', username: 'Trigger' },
    msg_elements: [{ content: [
      '=== 消息 1 ===',
      '[消息内容]  收到：`diag-trigger`',
      '',
      '=== 消息 2 ===',
      '[消息内容] body-a',
      '',
      '=== 消息 3 ===',
      '[消息内容] body-b',
    ].join('\n') }],
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].ctx.senderId, 'trigger-member');
  const text = received[0].message.parts[0].text;
  assert.match(text, /^<foxwarm-qqbot-context count="3" untrusted="true">/);
  assert.equal((text.match(/source="platform-history"/g) || []).length, 3);
  assert.equal(text.includes('senderId='), false);
  assert.equal(text.includes('senderName='), false);
  assert.equal(text.includes(' time='), false);
  assert.match(text, /收到：`diag-trigger`[\s\S]*body-a[\s\S]*body-b[\s\S]*\n\ndiag-trigger$/);
});

test('QQ Bot platform history preserves multiline escaped bodies, newest limits, trigger dedup, and limit zero', async () => {
  const body = [
    '=== 消息 1 ===',
    '[消息内容] old',
    '',
    '=== 消息 2 ===',
    '[消息内容] ask',
    '',
    '=== 消息 3 ===',
    '[消息内容] <tag>& first line',
    'second line',
    '',
    '=== 消息 4 ===',
    '[消息内容] newest',
    '',
    '=== 消息 5 ===',
    '[消息内容]   ask  ',
  ].join('\r\n');
  const event = {
    id: 'platform-bounded', content: 'ask', group_openid: 'group-1',
    author: { member_openid: 'member-1' }, msg_elements: [{ content: body }],
  };

  const limited = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret', groupContextLimit: 3 }, 'qq-platform-limit');
  const limitedMessages: any[] = [];
  limited.onMessage(async (_ctx, message) => { limitedMessages.push(message); });
  await (limited as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', event);
  const text = limitedMessages[0].parts[0].text;
  assert.match(text, /count="3"/);
  assert.equal(text.includes('old'), false);
  assert.match(text, />\nask\n<\/foxwarm-qqbot-context-item>/);
  assert.match(text, /&lt;tag&gt;&amp; first line\nsecond line/);
  assert.match(text, /newest/);
  assert.equal((text.match(/>\nask\n<\/foxwarm-qqbot-context-item>/g) || []).length, 1);
  assert.match(text, /\n\nask$/);

  const zero = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret', groupContextLimit: 0 }, 'qq-platform-zero');
  const zeroMessages: any[] = [];
  zero.onMessage(async (_ctx, message) => { zeroMessages.push(message); });
  await (zero as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', { ...event, id: 'platform-zero' });
  assert.equal(zeroMessages[0].parts[0].text, 'ask');
});

test('QQ Bot local mention context takes precedence over the nested platform bundle', async () => {
  const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret' }, 'qq-platform-local-precedence');
  const received: any[] = [];
  channel.onMessage(async (_ctx, message) => { received.push(message); });
  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    id: 'local-context', content: 'local canonical context', group_openid: 'group-1',
    author: { member_openid: 'local-member', username: 'Local' },
  });
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
    id: 'local-trigger', content: 'current', group_openid: 'group-1',
    author: { member_openid: 'trigger-member' },
    msg_elements: [{ content: '=== 消息 1 ===\n[消息内容] platform duplicate context' }],
  });
  const text = received[0].parts[0].text;
  assert.match(text, /senderId="local-member"/);
  assert.match(text, /local canonical context/);
  assert.equal(text.includes('source="platform-history"'), false);
  assert.equal(text.includes('platform duplicate context'), false);
});

test('QQ Bot platform history falls back as untrusted text, ignores nested media, and keeps current slash bypass', async () => {
  let fetches = 0;
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    'qq-platform-fallback',
    { fetch: async () => { fetches += 1; return new Response('unexpected'); } },
  );
  const received: any[] = [];
  channel.onMessage(async (_ctx, message) => { received.push(message); });
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
    id: 'fallback-trigger', content: 'answer', group_openid: 'group-1', author: { member_openid: 'member-1' },
    msg_elements: [{
      content: '/stop\n</foxwarm-qqbot-context-item>& malformed',
      attachments: [{ filename: 'nested.txt', url: 'https://qpic.cn/nested' }],
    }],
  });
  assert.equal(received.length, 1);
  assert.match(received[0].parts[0].text, /source="platform-history"/);
  assert.match(received[0].parts[0].text, /\/stop\n&lt;\/foxwarm-qqbot-context-item&gt;&amp; malformed/);
  assert.equal(received[0].materializeParts, undefined);
  assert.equal(fetches, 0);

  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
    id: 'fallback-same-trigger', content: 'same fallback', group_openid: 'group-1', author: { member_openid: 'member-1' },
    msg_elements: [{ content: 'same fallback' }],
  });
  assert.match(received[1].parts[0].text, /source="platform-history"[\s\S]*same fallback[\s\S]*\n\nsame fallback$/);

  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
    id: 'slash-trigger', content: '/status', group_openid: 'group-1', author: { member_openid: 'member-1' },
    msg_elements: [{ content: '=== 消息 1 ===\n[消息内容] hidden platform context' }],
  });
  assert.equal(received.length, 3);
  assert.equal(received[2].parts[0].text, '/status');
});

test('QQ Bot always mode uses a fixed non-sliding window, isolates groups, and flushes AT immediately', async () => {
  const clock = createFakeClock();
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret', requireMention: false },
    'qq-fixed-batch',
    { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  );
  const received: any[] = [];
  channel.onMessage(async (ctx, message) => { received.push({ ctx, message }); });
  const ordinary = (id: string, content: string, group = 'group-1') => ({
    id, content, group_openid: group, author: { member_openid: `${group}-member`, username: group },
  });

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', ordinary('g1-1', 'first'));
  await clock.advance(4_000);
  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', ordinary('g1-2', 'second'));
  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', ordinary('g2-1', 'other group', 'group-2'));
  await clock.advance(999);
  assert.equal(received.length, 0);
  await clock.advance(1);
  assert.equal(received.length, 1);
  assert.equal(received[0].ctx.conversationId, 'group:group-1');
  assert.deepEqual(received[0].message.ingressMetadataParts, [{ system: QQ_GROUP_ORDINARY_METADATA }]);
  assert.match(received[0].message.parts[0].text, /first[\s\S]*second$/);

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', ordinary('g1-3', 'before at'));
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', ordinary('g1-at', 'urgent at'));
  assert.equal(received.length, 2);
  assert.equal(received[1].ctx.qqbotMessageId, 'g1-at');
  assert.deepEqual(received[1].message.ingressMetadataParts, [{ system: QQ_GROUP_MENTIONED_METADATA }]);
  assert.match(received[1].message.parts[0].text, /before at[\s\S]*urgent at$/);
  await clock.advance(4_000);
  assert.equal(received.length, 3);
  assert.equal(received[2].ctx.conversationId, 'group:group-2');
  assert.equal(received[2].message.parts[0].text, 'other group');
  assert.deepEqual(received[2].message.ingressMetadataParts, [{ system: QQ_GROUP_ORDINARY_METADATA }]);
});

test('QQ Bot group context applies bounds, while slash and current media are immediate boundaries', async () => {
  const clock = createFakeClock();
  let fetches = 0;
  let saves = 0;
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret', requireMention: false, groupContextLimit: 2 },
    'qq-context-boundaries',
    {
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      fetch: async () => { fetches += 1; return new Response('current file bytes', { status: 200 }); },
      saveInboundSessionFileFromPath: async (options: any) => {
        saves += 1;
        return {
          agentName: 'main', nodeId: 'master', absolutePath: '/tmp/current-file', promptPath: '/tmp/current-file',
          fileName: options.fileName, mimeType: options.mimeType, sizeBytes: options.sizeBytes, isImage: false,
        };
      },
    },
  );
  const received: any[] = [];
  channel.onMessage(async (ctx, message) => { received.push({ ctx, message }); });
  const event = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
    id, content, group_openid: 'group-1', author: { member_openid: id, username: id }, ...extra,
  });

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', event('one', 'one'));
  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', event('two', 'two'));
  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', event('three', 'three'));
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', event('at', 'ask'));
  assert.equal(received.length, 1);
  const bounded = received[0].message.parts[0].text;
  assert.match(bounded, /count="2"/);
  assert.equal(bounded.includes('one'), false);
  assert.match(bounded, /two[\s\S]*three[\s\S]*ask$/);

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', event('pending', 'discard me'));
  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', event('slash', '/status'));
  assert.equal(received.at(-1).message.parts[0].text, '/status');
  assert.equal((channel as any).groupAccumulators.size, 0);

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', event('ambient', 'before image'));
  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', event('image', '', {
    attachments: [{ filename: 'current.txt', content_type: 'file', size: 18, url: 'https://qpic.cn/current' }],
  }));
  const media = received.at(-1);
  assert.equal(fetches, 0);
  assert.equal(typeof media.message.materializeParts, 'function');
  assert.deepEqual(media.message.ingressMetadataParts, [{ system: QQ_GROUP_ORDINARY_METADATA }]);
  assert.match(media.message.parts.map((part: any) => part.text || '').join('\n'), /before image[\s\S]*current\.txt/);
  const materialized = await media.message.materializeParts('session-current-media');
  assert.equal(fetches, 1);
  assert.equal(saves, 1);
  const materializedText = materialized.map((part: any) => part.text || '').join('\n');
  assert.match(materializedText, /^<foxwarm-qqbot-context count="1" untrusted="true">/);
  assert.match(materializedText, /before image[\s\S]*<foxwarm-file name="current\.txt"/);
});

test('QQ Bot mention context expires by local arrival time and the group accumulator map is bounded', async () => {
  const clock = createFakeClock();
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret', groupContextLimit: 10 },
    'qq-context-ttl',
    { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  );
  const received: any[] = [];
  channel.onMessage(async (_ctx, message) => { received.push(message); });
  const event = (id: string, content: string, group = 'group-1') => ({
    id, content, group_openid: group, author: { member_openid: id },
  });

  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', event('stale', 'stale context'));
  await clock.advance(5 * 60 * 1_000 + 1);
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', event('trigger', 'fresh trigger'));
  assert.equal(received[0].parts[0].text, 'fresh trigger');

  for (let index = 0; index < 1_001; index += 1) {
    await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', event(`id-${index}`, `text-${index}`, `group-${index}`));
  }
  assert.equal((channel as any).groupAccumulators.size, 1_000);
  assert.equal((channel as any).groupAccumulators.has('group:group-0'), false);
  assert.equal((channel as any).groupAccumulators.has('group:group-1000'), true);
});

test('QQ Bot group batch timers are stopped by channel stop but survive gateway connection-generation changes', async () => {
  const clock = createFakeClock();
  const makeChannel = (name: string) => new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret', requireMention: false },
    name,
    { now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  );
  const stopped = makeChannel('qq-stop-batch');
  const stoppedMessages: any[] = [];
  stopped.onMessage(async (_ctx, message) => { stoppedMessages.push(message); });
  await (stopped as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    id: 'stop-1', content: 'stop', group_openid: 'group-1', author: { member_openid: 'member-1' },
  });
  assert.equal(clock.pending(), 1);
  await stopped.stop();
  assert.equal(clock.pending(), 0);
  await clock.advance(5_000);
  assert.equal(stoppedMessages.length, 0);

  const reconnecting = makeChannel('qq-reconnect-batch');
  const reconnectMessages: any[] = [];
  reconnecting.onMessage(async (_ctx, message) => { reconnectMessages.push(message); });
  await (reconnecting as any).routeInboundMessage('GROUP_MESSAGE_CREATE', {
    id: 'resume-1', content: 'resume', group_openid: 'group-1', author: { member_openid: 'member-1' },
  });
  (reconnecting as any).connectionGeneration += 1;
  await clock.advance(5_000);
  assert.equal(reconnectMessages.length, 1);
  assert.equal(reconnectMessages[0].parts[0].text, 'resume');
});

test('QQ Bot validates group context and batch configuration ranges', () => {
  assert.doesNotThrow(() => new QQBotChannel({ appId: 'app-id', clientSecret: 'secret', groupContextLimit: 0, groupBatchWindowMs: 0 }));
  assert.doesNotThrow(() => new QQBotChannel({ appId: 'app-id', clientSecret: 'secret', groupContextLimit: 50, groupBatchWindowMs: 30_000 }));
  assert.throws(() => new QQBotChannel({ appId: 'app-id', clientSecret: 'secret', groupContextLimit: 51 }), /groupContextLimit/);
  assert.throws(() => new QQBotChannel({ appId: 'app-id', clientSecret: 'secret', groupBatchWindowMs: 249 }), /groupBatchWindowMs/);
  assert.throws(() => new QQBotChannel({ appId: 'app-id', clientSecret: 'secret', groupBatchWindowMs: 30_001 }), /groupBatchWindowMs/);
});

test('QQ Bot zero context limit still upgrades an ordinary representation into its AT trigger', async () => {
  const channel = new QQBotChannel({ appId: 'app-id', clientSecret: 'secret', groupContextLimit: 0 });
  const received: any[] = [];
  channel.onMessage(async (ctx, message) => { received.push({ ctx, message }); });
  const base = { id: 'same-zero', group_openid: 'group-1', author: { member_openid: 'member-1' } };
  await (channel as any).routeInboundMessage('GROUP_MESSAGE_CREATE', { ...base, content: 'ordinary form' });
  await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', { ...base, content: 'AT form' });
  assert.equal(received.length, 1);
  assert.equal(received[0].ctx.qqbotMessageId, 'same-zero');
  assert.equal(received[0].message.parts[0].text, 'AT form');
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
  assert.equal(received[0].message.ingressMetadataParts, undefined);
  assert.match(received[0].message.parts[0].text || '', /first\.png/);
  assert.match(received[0].message.parts[1].text || '', /second\.txt/);
  assert.equal(typeof received[0].message.materializeParts, 'function');
  assert.equal(received[1].ctx.conversationId, 'group:group-1');
  assert.deepEqual(received[1].message.ingressMetadataParts, [{ system: QQ_GROUP_MENTIONED_METADATA }]);
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
  emitGateway(sockets[0], { op: 11 });
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

test('QQ Bot group busy follow-up joins the active tool loop and one final uses its latest trigger id', async () => {
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
  const router = new MessageRouter([{ platform: 'qqbot', userId: 'member-1' }]);
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
    sessionManager.attachChannel(channelId, 'group:group-1', sessionId);

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

    const firstRun = (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
      id: 'qq-1', content: 'first input', group_openid: 'group-1', author: { member_openid: 'member-1' },
    }, 1);
    await toolStartedPromise;
    await (channel as any).routeInboundMessage('GROUP_AT_MESSAGE_CREATE', {
      id: 'qq-2', content: 'second steering', group_openid: 'group-1', author: { member_openid: 'member-1' },
    }, 2);

    assert.equal(session.queue.length, 1);
    releaseTool();
    await firstRun;
    await waitFor(() => outbound.some(call => call.body.content === 'combined final'));

    assert.equal(chatCalls, 2);
    assert.equal(session.queue.length, 0);
    const userMessages = session.history.filter(message => message.role === 'user');
    assert.equal(userMessages.length, 2);
    assert.equal(userMessages.some(message => message.parts.some(part => part.text === 'second steering')), true);
    assert.equal(userMessages.every(message => message.parts.some(part => part.system === QQ_GROUP_MENTIONED_METADATA)), true);
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

test('QQ Bot delivers a no-tool result before continuing a late compatible follow-up', async () => {
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
  const sends: Array<{ conversationId: string; text: string; options?: any }> = [];
  const originalSendMessage = channel.sendMessage.bind(channel);
  let firstRequestStarted!: () => void;
  let releaseFirstRequest!: () => void;
  const firstRequestStartedPromise = new Promise<void>(resolve => { firstRequestStarted = resolve; });
  const releaseFirstRequestPromise = new Promise<void>(resolve => { releaseFirstRequest = resolve; });
  let chatCalls = 0;

  activateForDirectSend(channel);
  (channel as any).sendMessage = async (conversationId: string, text: string, options?: any) => {
    sends.push({ conversationId, text, options });
    await originalSendMessage(conversationId, text, options);
  };
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
      const intermediateSends = sends.filter(send => send.text === 'intermediate answer');
      assert.equal(intermediateSends.length, 1, 'call one text must be sent before provider call two');
      assert.equal(intermediateSends[0].conversationId, 'c2c:openid-1');
      assert.equal(intermediateSends[0].options?.parse_mode, 'Markdown');
      assert.equal(intermediateSends[0].options?.excludePlatforms?.includes('webui'), true);
      assert.notEqual(intermediateSends[0].options?.turnFinal, true);
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
    assert.deepEqual(
      session.history
        .filter(message => message.role === 'model')
        .map(message => message.parts.find(part => part.text)?.text),
      ['intermediate answer', 'answer to late steering'],
    );
    const intermediate = outbound.filter(body => body.content === 'intermediate answer');
    assert.equal(intermediate.length, 1);
    assert.equal(intermediate[0].msg_id, 'qq-final-2');
    assert.equal(sends.filter(send => send.text === 'intermediate answer').length, 1);
    const finals = outbound.filter(body => body.content === 'answer to late steering');
    assert.equal(finals.length, 1);
    assert.equal(finals[0].msg_id, 'qq-final-2');
    const finalSends = sends.filter(send => send.text === 'answer to late steering');
    assert.equal(finalSends.length, 1);
    assert.equal(finalSends[0].options?.turnFinal, true);
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
        if (body.msg_id === 'expired-server') return response({ code: 40034005, message: '回复消息msg_id已过期' }, 400);
        if (body.content === 'expired-proactive-failure') {
          return response(body.msg_id
            ? { err_code: 40034005, message: '回复消息msg_id已过期' }
            : { code: 40034105, message: '主动消息失败, 无权限' }, 400);
        }
        if (failPassive && body.msg_id === 'unknown-failure') return response({ code: 999999, message: 'unrelated text mentions 40034005 only' }, 400);
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

  const contexts = (channel as any).passiveReplyContexts as Map<string, { firstSeenAt: number; successfulReplies: number; expired?: boolean }>;
  contexts.set('within-three-minutes', { firstSeenAt: Date.now() - (3 * 60 * 1_000 - 1_000), successfulReplies: 0 });
  await sendBound('within-three-minutes', 'within three minute boundary', true);
  const withinBoundary = calls.find(call => String(call.init?.body).includes('within three minute boundary'));
  assert.equal(JSON.parse(String(withinBoundary?.init?.body)).msg_id, 'within-three-minutes');

  contexts.set('expired-id', { firstSeenAt: Date.now() - (3 * 60 * 1_000 + 1_000), successfulReplies: 0 });
  await sendBound('expired-id', 'expired proactive', true);
  const expired = calls.find(call => String(call.init?.body).includes('expired proactive'));
  assert.equal(JSON.parse(String(expired?.init?.body)).msg_id, undefined);

  const beforeServerExpired = calls.length;
  await sendBound('expired-server', 'expired server fallback', true);
  const serverExpiredBodies = calls
    .slice(beforeServerExpired)
    .filter(call => String(call.url).includes('/v2/users/'))
    .map(call => JSON.parse(String(call.init?.body || '{}')));
  assert.deepEqual(serverExpiredBodies, [
    { content: 'expired server fallback', msg_type: 0, msg_id: 'expired-server', msg_seq: 1 },
    { content: 'expired server fallback', msg_type: 0 },
  ]);
  const beforeFutureExpired = calls.length;
  await sendBound('expired-server', 'future expired server fallback', true);
  const futureExpiredBodies = calls
    .slice(beforeFutureExpired)
    .filter(call => String(call.url).includes('/v2/users/'))
    .map(call => JSON.parse(String(call.init?.body || '{}')));
  assert.deepEqual(futureExpiredBodies, [{ content: 'future expired server fallback', msg_type: 0 }]);

  const beforeProactiveKnownFailure = calls.length;
  await sendBound('expired-proactive-failure', 'expired-proactive-failure', true);
  const proactiveKnownFailureBodies = calls
    .slice(beforeProactiveKnownFailure)
    .filter(call => String(call.url).includes('/v2/users/'))
    .map(call => JSON.parse(String(call.init?.body || '{}')));
  assert.deepEqual(proactiveKnownFailureBodies, [
    { content: 'expired-proactive-failure', msg_type: 0, msg_id: 'expired-proactive-failure', msg_seq: 1 },
    { content: 'expired-proactive-failure', msg_type: 0 },
  ]);

  failPassive = true;
  const beforeUnknownFailure = calls.length;
  await sendBound('unknown-failure', 'unknown passive failure', true);
  assert.equal(calls.length, beforeUnknownFailure + 1);
  assert.equal(JSON.parse(String(calls[calls.length - 1].init?.body)).msg_id, 'unknown-failure');

  contexts.set('proactive-failure', { firstSeenAt: Date.now(), successfulReplies: 4 });
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

test('QQ Bot keeps aged and server-expired passive contexts through unrelated inbound contexts', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret' },
    'qq-passive-context-retention',
    {
      fetch: async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        if (String(url).includes('getAppAccessToken')) return response({ access_token: 'token', expires_in: 7200 });
        return response({ id: 'outbound-id' });
      },
    },
  );
  activateForDirectSend(channel);
  const contexts = (channel as any).passiveReplyContexts as Map<string, { firstSeenAt: number; successfulReplies: number; expired?: boolean }>;
  contexts.set('aged-id', { firstSeenAt: Date.now() - (6 * 60 * 1_000 + 1_000), successfulReplies: 0 });
  contexts.set('server-expired-id', { firstSeenAt: Date.now(), successfulReplies: 0, expired: true });

  await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
    id: 'unrelated-inbound-one',
    content: 'unrelated one',
    author: { user_openid: 'openid-1' },
  });
  await (channel as any).routeInboundMessage('C2C_MESSAGE_CREATE', {
    id: 'unrelated-inbound-two',
    content: 'unrelated two',
    author: { user_openid: 'openid-1' },
  });

  await channel.sendMessage('c2c:openid-1', 'aged stays proactive', { replyToId: 'aged-id', qqbotSourceBound: true });
  await channel.sendMessage('c2c:openid-1', 'expired stays proactive', { replyToId: 'server-expired-id', qqbotSourceBound: true });

  const bodies = calls
    .filter(call => String(call.url).includes('/v2/users/'))
    .map(call => JSON.parse(String(call.init?.body || '{}')));
  assert.deepEqual(bodies, [
    { content: 'aged stays proactive', msg_type: 0 },
    { content: 'expired stays proactive', msg_type: 0 },
  ]);
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
  const runner = router.turnRunner as any;
  const source = runner.snapshotSource(sourceCtx);
  const session = { broadcast: () => {} };
  await runner.deliverProviderResultText(
    session, sourceCtx, source, 'model final', false, session.broadcast,
    runner.getTurnChannelOptions(sourceCtx, source),
  );
  const outbound = calls.filter(call => String(call.url).includes('/v2/users/'));
  assert.equal(outbound.length, 1);
  assert.equal(JSON.parse(String(outbound[0].init?.body)).msg_id, 'router-failure-id');
});

test('QQ Bot maps group, guild, and guild-DM sends while keeping guild media unsupported', async (t) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const socket = new FakeSocket();
  const channel = new QQBotChannel(
    { appId: 'app-id', clientSecret: 'secret', requireMention: false, groupBatchWindowMs: 0 },
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
  socket.emit('message', Buffer.from(JSON.stringify({ op: 0, t: 'GROUP_MESSAGE_CREATE', d: { id: 'group-ordinary', content: 'ordinary group hello', group_openid: 'group-1', author: { member_openid: 'member-2', username: 'Member 2' } } })));
  await flush();
  assert.equal(received[1].ctx.conversationId, 'group:group-1');
  assert.equal(received[1].ctx.qqbotMessageId, 'group-ordinary');

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
