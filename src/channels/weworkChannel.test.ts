import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { registerChannel, unregisterChannel } from '../channel';
import { MessageRouter } from '../messageRouter';
import * as llm from '../llm';
import * as sessionManager from '../sessionManager';
import type { MessagePart, Session } from '../types';
import { isWeWorkChannelConfigReady, WeWorkWebhookChannel } from './weworkChannel';

const aibotTextBody = {
  msgid: 'msg-1',
  aibotid: 'bot-1',
  chatid: 'chat-1',
  chattype: 'group',
  from: { userid: 'user-1' },
  response_url: 'https://example.test/response',
  msgtype: 'text',
  text: { content: '@Robot hello' },
};

function cloneBody(msgid: string) {
  return { ...aibotTextBody, msgid };
}

function makeTestId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('timed out waiting for condition');
}

test('WeWork channel only enables passive stream aggregation when configured', async () => {
  const disabled = new WeWorkWebhookChannel({ name: 'wework-test', webhookUrl: 'https://example.test/webhook' });
  disabled.onMessage(async () => {});

  const disabledResult = await (disabled as any).processInboundBody(aibotTextBody, {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);

  assert.equal(disabledResult.handled, true);
  assert.equal(disabledResult.passiveResponse, undefined);

  const enabled = new WeWorkWebhookChannel({
    name: 'wework-test',
    webhookUrl: 'https://example.test/webhook',
    aibot: { stream: true },
  });
  enabled.onMessage(async () => {});

  const enabledResult = await (enabled as any).processInboundBody(aibotTextBody, {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);

  assert.equal(enabledResult.handled, true);
  assert.deepEqual(enabledResult.passiveResponse, {
    msgtype: 'stream',
    stream: {
      id: enabledResult.passiveResponse.stream.id,
      finish: false,
      content: '> 🤔 thinking',
    },
  });
});

test('WeWork channel config readiness supports pure callback and websocket modes', () => {
  assert.equal(isWeWorkChannelConfigReady({ webhookUrl: 'https://example.test/webhook' }), true);
  assert.equal(isWeWorkChannelConfigReady({
    listenPort: 3003,
    listenPath: '/wework/aibot',
    token: 'token',
    encodingAESKey: 'encoding-key',
  }), true);
  assert.equal(isWeWorkChannelConfigReady({
    aibot: { websocket: { enabled: true, botId: 'bot', secret: 'secret' } },
  }), true);
  assert.equal(isWeWorkChannelConfigReady({ listenPort: 3003, listenPath: '/missing-crypto' }), false);
});

test('WeWork channel deduplicates repeated callback msgid', async () => {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    aibot: { stream: true },
  });
  let handled = 0;
  channel.onMessage(async () => { handled++; });

  const first = await (channel as any).processInboundBody(cloneBody('dup-msg'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);
  const second = await (channel as any).processInboundBody(cloneBody('dup-msg'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);

  assert.equal(handled, 1);
  assert.equal(second.passiveResponse.stream.id, first.passiveResponse.stream.id);
});

test('WeWork channel can start a passive stream for pure short-callback AIBot messages without response_url', async () => {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    aibot: { stream: true },
  });
  channel.onMessage(async () => {});

  const { response_url: _responseUrl, ...body } = cloneBody('pure-callback');
  const result = await (channel as any).processInboundBody(body, { mode: 'webhook' }, true);

  assert.equal(result.handled, true);
  assert.equal(result.passiveResponse.msgtype, 'stream');
  assert.equal(result.passiveResponse.stream.finish, false);
  assert.equal(result.passiveResponse.stream.content, '> 🤔 thinking');
});

test('WeWork channel passes configured selfName on inbound context', async () => {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    selfName: '企业微信机器人',
    aibot: { stream: true },
  });
  let observedSelfName: string | undefined;
  channel.onMessage(async (ctx) => { observedSelfName = ctx.selfName; });

  await (channel as any).processInboundBody(cloneBody('self-name-context'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);

  assert.equal(observedSelfName, '企业微信机器人');
});

test('WeWork channel skips stream-bound broadcasts for non-matching conversations instead of falling back to webhook send', async () => {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    webhookUrl: 'https://example.invalid/webhook',
    aibot: { stream: true },
  });
  channel.onMessage(async () => {});

  const first = await (channel as any).processInboundBody(cloneBody('skip-turn-1'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);

  await channel.sendMessage('other-chat', 'must not be posted to webhook', { weworkStreamId: first.passiveResponse.stream.id });

  const refresh = await (channel as any).processInboundBody({ msgtype: 'stream', stream: { id: first.passiveResponse.stream.id } }, { mode: 'webhook' }, true);
  assert.equal(refresh.passiveResponse.stream.content, '> 🤔 thinking');
  assert.equal(refresh.passiveResponse.stream.finish, false);
});

test('WeWork channel supersedes the old webhook card and routes old turn options to the latest card', async () => {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    aibot: { stream: true },
  });
  channel.onMessage(async () => {});

  const first = await (channel as any).processInboundBody(cloneBody('turn-1'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);
  await channel.sendMessage('chat-1', 'model text before tools', { weworkStreamId: first.passiveResponse.stream.id });
  await channel.sendMessage('chat-1', '', {
    weworkStreamId: first.passiveResponse.stream.id,
    channelTurnProgress: { type: 'tool-calls-start', calls: [{ id: 'call-1', name: 'read' }] },
  });
  const second = await (channel as any).processInboundBody(cloneBody('turn-2'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);

  await channel.sendMessage('chat-1', 'latest final', { weworkStreamId: first.passiveResponse.stream.id, turnFinal: true });
  await channel.sendMessage('chat-1', 'must not resurrect old card', { weworkStreamId: first.passiveResponse.stream.id });

  const firstRefresh = await (channel as any).processInboundBody({ msgtype: 'stream', stream: { id: first.passiveResponse.stream.id } }, { mode: 'webhook' }, true);
  const secondRefresh = await (channel as any).processInboundBody({ msgtype: 'stream', stream: { id: second.passiveResponse.stream.id } }, { mode: 'webhook' }, true);

  assert.equal(firstRefresh.passiveResponse.stream.content, 'model text before tools');
  assert.equal(firstRefresh.passiveResponse.stream.finish, true);
  assert.equal(firstRefresh.passiveResponse.stream.content.includes('read'), false);
  assert.equal(firstRefresh.passiveResponse.stream.content.includes('thinking'), false);
  assert.equal(secondRefresh.passiveResponse.stream.content, 'latest final');
  assert.equal(secondRefresh.passiveResponse.stream.finish, true);
});

test('WeWork channel best-effort pushes a clean old WebSocket final and continues on the latest card', async () => {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    aibot: { stream: true },
  });
  const pushed: any[] = [];
  (channel as any).pushWebSocketStream = async (snapshot: any) => {
    pushed.push(structuredClone(snapshot));
  };
  channel.onMessage(async () => {});

  await (channel as any).processInboundBody(cloneBody('ws-turn-1'), { mode: 'websocket', reqId: 'req-1' }, true);
  const first = pushed.find(snapshot => snapshot.delivery.reqId === 'req-1');
  await (channel as any).processInboundBody(cloneBody('ws-turn-2'), { mode: 'websocket', reqId: 'req-2' }, true);
  await new Promise(resolve => setImmediate(resolve));

  const oldFinal = [...pushed].reverse().find(snapshot => snapshot.streamId === first.streamId && snapshot.finish);
  const latest = [...pushed].reverse().find(snapshot => snapshot.delivery.reqId === 'req-2');
  assert.equal(oldFinal.content, '处理完成。');
  assert.equal(oldFinal.finish, true);

  await channel.sendMessage('chat-1', '', {
    weworkStreamId: first.streamId,
    channelTurnProgress: { type: 'tool-calls-start', calls: [{ id: 'call-1', name: 'read' }] },
  });
  await channel.sendMessage('chat-1', 'latest answer', {
    weworkStreamId: first.streamId,
    turnFinal: true,
  });

  const latestPushes = pushed.filter(snapshot => snapshot.streamId === latest.streamId);
  assert.equal(latestPushes.some(snapshot => snapshot.content.includes('read') && !snapshot.finish), true);
  assert.equal(latestPushes.at(-1).content.endsWith('latest answer'), true);
  assert.equal(latestPushes.at(-1).finish, true);
  assert.equal(pushed.filter(snapshot => snapshot.streamId === first.streamId && snapshot.content.includes('read')).length, 0);
});

test('WeWork channel applies structured turn progress to the bound stream card', async () => {
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    aibot: { stream: true },
  });
  channel.onMessage(async () => {});

  const first = await (channel as any).processInboundBody(cloneBody('progress-turn-1'), {
    mode: 'webhook',
    responseUrl: aibotTextBody.response_url,
  }, true);
  const streamId = first.passiveResponse.stream.id;

  await channel.sendMessage('chat-1', 'model 文本消息 1', { weworkStreamId: streamId });
  await channel.sendMessage('chat-1', '', {
    weworkStreamId: streamId,
    channelTurnProgress: {
      type: 'tool-calls-start',
      calls: [
        { id: 'call-1', name: 'exec' },
        { id: 'call-2', name: 'read' },
      ],
    },
  });
  await channel.sendMessage('chat-1', '', {
    weworkStreamId: streamId,
    channelTurnProgress: {
      type: 'tool-calls-finish',
      results: [
        { id: 'call-1', name: 'exec', status: 'success' },
        { id: 'call-2', name: 'read', status: 'success' },
      ],
    },
  });
  await channel.sendMessage('chat-1', '', {
    weworkStreamId: streamId,
    channelTurnProgress: { type: 'llm-start' },
  });

  const refresh = await (channel as any).processInboundBody({ msgtype: 'stream', stream: { id: streamId } }, { mode: 'webhook' }, true);
  assert.equal(refresh.passiveResponse.stream.content, 'model 文本消息 1\n\n> ☑️ exec | ☑️ read | 🤔 thinking');
});

test('WeWork stream card shows model text and running tools before tools finish', async () => {
  const channelId = makeTestId('wework-tool-start');
  const sessionId = makeTestId('session-wework-tool-start');
  const channel = new WeWorkWebhookChannel({
    name: channelId,
    aibot: { stream: true },
  });
  const router = new MessageRouter([{ platform: 'wework', userId: 'user-1' }]);
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  let releaseTool!: () => void;
  let toolStarted!: () => void;
  const releaseToolPromise = new Promise<void>(resolve => { releaseTool = resolve; });
  const toolStartedPromise = new Promise<void>(resolve => { toolStarted = resolve; });
  const handlerRuns: Array<Promise<void>> = [];
  let chatCalls = 0;

  registerChannel(channelId, channel);
  channel.onMessage((ctx, message) => {
    const run = router.handleMessage(ctx, message);
    handlerRuns.push(run);
    return run;
  });

  try {
    await sessionManager.getSession(sessionId);
    sessionManager.attachChannel(channelId, 'chat-1', sessionId);
    const toolCall = { id: 'call-1', name: 'read', args: { filePath: 'README.md' } };

    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
      assert.equal(activeSession.id, sessionId);
      chatCalls += 1;
      if (parts?.length) {
        await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
      }
      if (chatCalls === 1) {
        await sessionManager.appendSessionMessage(activeSession, {
          role: 'model',
          parts: [{ text: 'I will inspect it now.' }, { functionCall: toolCall }],
        });
        return { text: 'I will inspect it now.', toolCalls: [toolCall], allParts: [{ text: 'I will inspect it now.' }, { functionCall: toolCall }] };
      }
      await sessionManager.appendSessionMessage(activeSession, {
        role: 'model',
        parts: [{ text: 'done' }],
      });
      return { text: 'done', allParts: [{ text: 'done' }] };
    };

    (llm as any).executeTools = async () => {
      toolStarted();
      await releaseToolPromise;
      return {
        role: 'tool',
        parts: [{ functionResponse: { tool_use_id: 'call-1', name: 'read', response: { output: 'ok' } } }],
      };
    };

    const inbound = await (channel as any).processInboundBody(cloneBody('tool-start-turn'), {
      mode: 'webhook',
      responseUrl: aibotTextBody.response_url,
    }, true);
    const streamId = inbound.passiveResponse.stream.id;

    await toolStartedPromise;

    const runningRefresh = await (channel as any).processInboundBody({ msgtype: 'stream', stream: { id: streamId } }, { mode: 'webhook' }, true);
    assert.equal(runningRefresh.passiveResponse.stream.finish, false);
    assert.equal(runningRefresh.passiveResponse.stream.content, 'I will inspect it now.\n\n> ⌛️ read');

    releaseTool();
    await handlerRuns[0];
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    unregisterChannel(channelId);
    const cleanupSession = await sessionManager.getSession(sessionId).catch((_err: unknown): null => null);
    if (cleanupSession) {
      cleanupSession.busy = false;
      await sessionManager.saveSession(sessionId).catch(() => {});
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }
  }
});

test('busy queued WeWork stream card is updated when its queued turn runs', async () => {
  const channelId = makeTestId('wework-busy-stream');
  const sessionId = makeTestId('session-wework-busy-stream');
  const channel = new WeWorkWebhookChannel({
    name: channelId,
    aibot: { stream: true },
  });
  const router = new MessageRouter([{ platform: 'wework', userId: 'user-1' }]);
  const originalChat = llm.chat;

  registerChannel(channelId, channel);
  channel.onMessage(async (ctx, message) => {
    await router.handleMessage(ctx, message);
  });

  try {
    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
      assert.equal(activeSession.id, sessionId);
      await sessionManager.appendSessionMessage(activeSession, {
        role: 'user',
        parts: parts || [],
      });
      await sessionManager.appendSessionMessage(activeSession, {
        role: 'model',
        parts: [{ text: 'queued answer' }],
      });
      return { text: 'queued answer' };
    };

    const session = await sessionManager.getSession(sessionId);
    session.busy = true;
    await sessionManager.saveSession(sessionId);
    sessionManager.attachChannel(channelId, 'chat-1', sessionId);

    const queuedInbound = await (channel as any).processInboundBody(cloneBody('busy-queued-turn'), {
      mode: 'webhook',
      responseUrl: aibotTextBody.response_url,
    }, true);
    const streamId = queuedInbound.passiveResponse.stream.id;
    assert.equal(queuedInbound.passiveResponse.stream.content, '> 🤔 thinking');
    assert.equal(queuedInbound.passiveResponse.stream.finish, false);

    await waitFor(async () => {
      const queuedSession = await sessionManager.getSession(sessionId);
      return queuedSession.queue.length === 1;
    });

    const busyQueuedSession = await sessionManager.getSession(sessionId);
    assert.equal(busyQueuedSession.queue[0]?.source?.weworkStreamId, streamId);
    busyQueuedSession.busy = false;
    busyQueuedSession.busyStartedAt = undefined;
    await sessionManager.saveSession(sessionId);

    await router.processSessionQueue(sessionId);

    let refreshed: any;
    await waitFor(async () => {
      refreshed = await (channel as any).processInboundBody({ msgtype: 'stream', stream: { id: streamId } }, { mode: 'webhook' }, true);
      return refreshed.passiveResponse.stream.content === 'queued answer' && refreshed.passiveResponse.stream.finish === true;
    });

    assert.equal(refreshed.passiveResponse.stream.content, 'queued answer');
    assert.equal(refreshed.passiveResponse.stream.finish, true);
  } finally {
    (llm as any).chat = originalChat;
    unregisterChannel(channelId);
    const cleanupSession = await sessionManager.getSession(sessionId).catch((_err: unknown): null => null);
    if (cleanupSession) {
      cleanupSession.busy = false;
      await sessionManager.saveSession(sessionId).catch(() => {});
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }
  }
});

test('busy WeWork follow-up joins the active tool loop and moves delivery to the latest card', async () => {
  const channelId = makeTestId('wework-card-switch');
  const sessionId = makeTestId('session-wework-card-switch');
  const channel = new WeWorkWebhookChannel({
    name: channelId,
    aibot: { stream: true },
  });
  const router = new MessageRouter([{ platform: 'wework', userId: 'user-1' }]);
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  let toolStarted!: () => void;
  let releaseTool!: () => void;
  const toolStartedPromise = new Promise<void>(resolve => { toolStarted = resolve; });
  const releaseToolPromise = new Promise<void>(resolve => { releaseTool = resolve; });
  let callIndex = 0;
  const handlerRuns: Array<Promise<void>> = [];

  registerChannel(channelId, channel);
  channel.onMessage((ctx, message) => {
    const run = router.handleMessage(ctx, message);
    handlerRuns.push(run);
    return run;
  });

  try {
    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
      assert.equal(activeSession.id, sessionId);
      callIndex += 1;
      if (parts) {
        await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
      }
      if (callIndex === 1) {
        const toolCall = { id: 'call-1', name: 'read', args: { filePath: 'README.md' } };
        await sessionManager.appendSessionMessage(activeSession, {
          role: 'model',
          parts: [{ functionCall: toolCall }],
        });
        return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
      }
      await sessionManager.appendSessionMessage(activeSession, {
        role: 'model',
        parts: [{ text: 'combined answer' }],
      });
      return { text: 'combined answer' };
    };
    (llm as any).executeTools = async () => {
      toolStarted();
      await releaseToolPromise;
      return {
        role: 'tool',
        parts: [{ functionResponse: { tool_use_id: 'call-1', name: 'read', response: { output: 'ok' } } }],
      };
    };

    await sessionManager.getSession(sessionId);
    sessionManager.attachChannel(channelId, 'chat-1', sessionId);

    const firstInbound = await (channel as any).processInboundBody(cloneBody('card-switch-turn-1'), {
      mode: 'webhook',
      responseUrl: aibotTextBody.response_url,
    }, true);
    const firstStreamId = firstInbound.passiveResponse.stream.id;
    assert.equal(firstInbound.passiveResponse.stream.content, '> 🤔 thinking');

    await toolStartedPromise;

    const secondInbound = await (channel as any).processInboundBody({
      ...cloneBody('card-switch-turn-2'),
      text: { content: 'second steering' },
    }, {
      mode: 'webhook',
      responseUrl: aibotTextBody.response_url,
    }, true);
    const secondStreamId = secondInbound.passiveResponse.stream.id;
    assert.notEqual(secondStreamId, firstStreamId);
    assert.equal(secondInbound.passiveResponse.stream.content, '> 🤔 thinking');

    await waitFor(() => handlerRuns.length >= 2);
    await handlerRuns[1];

    const queuedSession = await sessionManager.getSession(sessionId);
    assert.equal(queuedSession.queue.length, 1);
    assert.equal(queuedSession.queue[0]?.source?.weworkStreamId, secondStreamId);

    releaseTool();
    await handlerRuns[0];

    let firstRefresh: any;
    let secondRefresh: any;
    await waitFor(async () => {
      firstRefresh = await (channel as any).processInboundBody({ msgtype: 'stream', stream: { id: firstStreamId } }, { mode: 'webhook' }, true);
      secondRefresh = await (channel as any).processInboundBody({ msgtype: 'stream', stream: { id: secondStreamId } }, { mode: 'webhook' }, true);
      return firstRefresh.passiveResponse.stream.finish === true
        && secondRefresh.passiveResponse.stream.finish === true
        && secondRefresh.passiveResponse.stream.content.endsWith('combined answer');
    });

    assert.equal(firstRefresh.passiveResponse.stream.content.includes('thinking'), false);
    assert.equal(firstRefresh.passiveResponse.stream.content, '处理完成。');
    assert.equal(firstRefresh.passiveResponse.stream.finish, true);
    assert.equal(secondRefresh.passiveResponse.stream.content.endsWith('combined answer'), true);
    assert.equal(secondRefresh.passiveResponse.stream.finish, true);
    assert.equal(callIndex, 2);
    const userMessages = queuedSession.history.filter(message => message.role === 'user');
    assert.equal(userMessages.length, 2);
    assert.equal(userMessages.some(message => message.parts.some(part => part.system?.includes('second steering'))), true);
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    unregisterChannel(channelId);
    const cleanupSession = await sessionManager.getSession(sessionId).catch((_err: unknown): null => null);
    if (cleanupSession) {
      cleanupSession.busy = false;
      await sessionManager.saveSession(sessionId).catch(() => {});
      await sessionManager.deleteSession(sessionId).catch(() => {});
    }
  }
});

test('WeWork encrypted passive response can be decrypted back to the stream payload', () => {
  const encodingAESKey = crypto.randomBytes(32).toString('base64').replace(/=+$/u, '');
  const channel = new WeWorkWebhookChannel({
    name: 'wework-test',
    token: 'test-token',
    encodingAESKey,
  });
  const payload = {
    msgtype: 'stream',
    stream: { id: 'stream-1', finish: false, content: '> 🤔 thinking' },
  };

  const encrypted = (channel as any).buildPassiveHttpResponse(payload, { timestamp: '1710000000', nonce: 'nonce-1' });
  assert.equal(typeof encrypted.encrypt, 'string');
  assert.equal(typeof encrypted.msgsignature, 'string');

  const plaintext = (channel as any).crypto.decryptCallbackMessage(encrypted.encrypt);
  assert.deepEqual(JSON.parse(plaintext), payload);
  assert.equal((channel as any).crypto.verifySignature(encrypted.msgsignature, String(encrypted.timestamp), encrypted.nonce, encrypted.encrypt), true);
});
