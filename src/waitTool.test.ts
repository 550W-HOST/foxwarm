import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

import { MessageRouter } from './messageRouter';
import * as sessionManager from './sessionManager';
import * as llm from './llm';
import * as vector from './vector';
import {
  buildWaitTimeoutMessage,
  createTimer,
  createTimersStore,
  resetTimersForTests,
  setTimersStoreForTests,
} from './timers';
import { definitions } from './tools';
import { tool_wait } from './toolsSessionAgent';
import type { Message, MessagePart, Session } from './types';

function makeSessionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function cleanupSession(sessionId: string): Promise<void> {
  await sessionManager.deleteSession(sessionId).catch(() => false);
}

async function seedCompactableHistory(sessionId: string): Promise<Session> {
  const session = await sessionManager.getSession(sessionId);
  const messages: Message[] = [
    { role: 'user', parts: [{ text: `older user message for compact wait test ${'alpha '.repeat(12000)}` }] },
    { role: 'model', parts: [{ text: `older model response for compact wait test ${'bravo '.repeat(12000)}` }] },
    { role: 'user', parts: [{ text: 'recent user message kept outside compact range' }] },
    { role: 'model', parts: [{ text: 'recent model response kept outside compact range' }] },
  ];
  await sessionManager.appendSessionMessages(session, messages);
  return session;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await sleep(intervalMs);
  }
  assert.fail('Timed out waiting for condition');
}

function flattenPartsText(parts: MessagePart[] | null | undefined): string {
  return (parts || [])
    .map(part => part.system || part.text || '')
    .join('\n');
}

async function appendStubTurn(activeSession: Session, parts: MessagePart[] | null, responseText: string): Promise<void> {
  if (parts?.length) {
    await sessionManager.appendSessionMessage(activeSession, {
      role: 'user',
      parts,
    });
  }
  await sessionManager.appendSessionMessage(activeSession, {
    role: 'model',
    parts: [{ text: responseText }],
  });
}

async function waitForSessionIdle(sessionId: string): Promise<void> {
  await waitFor(async () => {
    const session = await sessionManager.getSession(sessionId);
    return !session.busy && session.queue.length === 0;
  });
}

async function withTempTimerStore(run: () => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-wait-timers-'));
  try {
    setTimersStoreForTests(createTimersStore(path.join(dirPath, 'timers.json')));
    await run();
  } finally {
    resetTimersForTests();
    setTimersStoreForTests(null);
    await fs.remove(dirPath).catch(() => {});
  }
}

test('buildWaitTimeoutMessage uses fixed text and no custom timeout message', () => {
  assert.equal(
    buildWaitTimeoutMessage({ waitTimeoutSeconds: 7 }),
    '[SYSTEM: wait timeout reached after 7s. No newer message or event triggered this session during the wait.]',
  );
});

test('wait tool schema includes waitAllSessions', () => {
  const waitDefinition = definitions.find(definition => definition.name === 'wait');
  assert.ok(waitDefinition);
  assert.equal(waitDefinition.parameters.properties.waitAllSessions?.type, 'array');
  assert.equal(waitDefinition.parameters.properties.waitAllSessions?.items?.type, 'string');
});

test('waitAllSessions argument validation rejects invalid values and de-dupes duplicates', async () => {
  const sessionId = makeSessionId('wait_all_validation');
  try {
    const session = await sessionManager.getSession(sessionId);

    await assert.rejects(
      () => tool_wait({ waitAllSessions: 'child-a' }, { sessionId, session }),
      /waitAllSessions must be an array/,
    );
    await assert.rejects(
      () => tool_wait({ waitAllSessions: [] }, { sessionId, session }),
      /at least one session ID/,
    );
    await assert.rejects(
      () => tool_wait({ waitAllSessions: ['child-a', '   '] }, { sessionId, session }),
      /entries must be non-empty strings/,
    );
    await assert.rejects(
      () => tool_wait({ waitAllSessions: ['child-a', 42] }, { sessionId, session }),
      /entries must be non-empty strings/,
    );

    const result = await tool_wait({ waitAllSessions: [' child-a ', 'child-a', 'child-b'] }, { sessionId, session });
    assert.equal(result.output, 'ok');
    const reloaded = await sessionManager.getSession(sessionId);
    assert.deepEqual(reloaded.meta.wait?.waitAll?.sessions, ['child-a', 'child-b']);
  } finally {
    await cleanupSession(sessionId);
  }
});

test('active wait timeout queues a system event and clears wait state', async () => {
  const sessionId = makeSessionId('wait_timeout_active');
  try {
    await sessionManager.getSession(sessionId);
    const wait = await sessionManager.startSessionWait(sessionId, { timeoutSeconds: 12 });

    await sessionManager.queueSessionWaitTimeoutEvent(
      sessionId,
      wait.id,
      buildWaitTimeoutMessage({ waitTimeoutSeconds: 12 }),
    );

    const session = await sessionManager.getSession(sessionId);
    assert.equal(session.meta.wait, undefined);
    assert.equal(session.queue.length, 1);
    assert.equal(session.queue[0].waitTimeoutId, wait.id);
    assert.match(String(session.queue[0].parts?.[0]?.system), /wait timeout reached after 12s/);
  } finally {
    await cleanupSession(sessionId);
  }
});

test('compact maintenance queue items are wait-neutral and keep timeout token valid', async () => {
  const sessionId = makeSessionId('wait_compact_maintenance');
  try {
    await sessionManager.getSession(sessionId);
    const wait = await sessionManager.startSessionWait(sessionId, { timeoutSeconds: 20 });

    await sessionManager.enqueueSessionItem(sessionId, { type: 'compact-commit' });
    let session = await sessionManager.getSession(sessionId);
    assert.equal(session.meta.wait?.id, wait.id);
    assert.deepEqual(session.queue.map(item => item.type), ['compact-commit']);

    await sessionManager.enqueueSessionItem(sessionId, { type: 'compact', completionMarker: 'Compaction completed.' });
    session = await sessionManager.getSession(sessionId);
    assert.equal(session.meta.wait?.id, wait.id);
    assert.deepEqual(session.queue.map(item => item.type), ['compact-commit', 'compact']);

    await sessionManager.queueSessionWaitTimeoutEvent(
      sessionId,
      wait.id,
      buildWaitTimeoutMessage({ waitTimeoutSeconds: 20 }),
    );

    session = await sessionManager.getSession(sessionId);
    assert.equal(session.meta.wait, undefined);
    assert.equal(session.queue.length, 3);
    assert.equal(session.queue[2].waitTimeoutId, wait.id);
    assert.match(String(session.queue[2].parts?.[0]?.system), /wait timeout reached after 20s/);
  } finally {
    await cleanupSession(sessionId);
  }
});

test('idle compaction request starts immediately without enqueueing compact initiator item', async () => {
  const sessionId = makeSessionId('wait_compact_direct_start');
  const originalChat = llm.chat;
  const originalArchiveIndex = (vector as any).scheduleSessionArchiveIndex;
  try {
    (vector as any).scheduleSessionArchiveIndex = async () => 0;
    await seedCompactableHistory(sessionId);

    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
      assert.equal((activeSession as any).__compactJob, true);
      const prompt = (parts || []).map(part => part.system || part.text || '').join('\n');
      assert.match(prompt, /COMPACTION STARTED/);
      const toolCall = {
        id: 'compact-direct-start-plan',
        name: 'submit_compact_plan',
        args: {
          createBlocksJson: JSON.stringify([{
            level: 1,
            sourceKind: 'message',
            sourceStart: 1,
            sourceEnd: 2,
            summary: 'summary created by immediate compact request test',
          }]),
        },
      };
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    };

    const result = await sessionManager.requestSessionCompaction(sessionId, { keepPercent: 0.5 });
    assert.equal(result.startedImmediately, true);

    let session = await sessionManager.getSession(sessionId);
    for (let attempt = 0; attempt < 50 && (session.busy || !session.queue.some(item => item.type === 'compact-commit')); attempt += 1) {
      await sleep(10);
      session = await sessionManager.getSession(sessionId);
    }

    assert.equal(session.busy, false);
    assert.equal(session.queue.some(item => item.type === 'compact'), false);
    assert.equal(session.queue.filter(item => item.type === 'compact-commit').length, 1);
  } finally {
    (llm as any).chat = originalChat;
    (vector as any).scheduleSessionArchiveIndex = originalArchiveIndex;
    await cleanupSession(sessionId);
  }
});

test('wait survives compact request and compact commit before timeout turn', async () => {
  const sessionId = makeSessionId('wait_compact_timeout_integration');
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const originalArchiveIndex = (vector as any).scheduleSessionArchiveIndex;
  const observedTurns: string[] = [];

  (vector as any).scheduleSessionArchiveIndex = async () => 0;
  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    if ((activeSession as any).__compactJob) {
      const toolCall = {
        id: 'wait-compact-plan',
        name: 'submit_compact_plan',
        args: {
          createBlocksJson: JSON.stringify([{
            level: 1,
            sourceKind: 'message',
            sourceStart: 1,
            sourceEnd: 2,
            summary: 'summary created while session was waiting',
          }]),
        },
      };
      return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }] };
    }

    const text = (parts || [])
      .map(part => part.system || part.text || '')
      .join('\n');
    observedTurns.push(text);
    await sessionManager.appendSessionMessage(activeSession, {
      role: 'user',
      parts: parts || [],
    });
    const responseText = `wait compact observed turn ${observedTurns.length}`;
    await sessionManager.appendSessionMessage(activeSession, {
      role: 'model',
      parts: [{ text: responseText }],
    });
    return { text: responseText };
  };

  try {
    await seedCompactableHistory(sessionId);
    const wait = await sessionManager.startSessionWait(sessionId, { timeoutSeconds: 30 });

    const result = await sessionManager.requestSessionCompaction(sessionId, { keepPercent: 0.5 });
    assert.equal(result.startedImmediately, true);

    let session = await sessionManager.getSession(sessionId);
    for (let attempt = 0; attempt < 50 && !session.queue.some(item => item.type === 'compact-commit'); attempt += 1) {
      await sleep(10);
      session = await sessionManager.getSession(sessionId);
    }
    assert.equal(session.meta.wait?.id, wait.id);
    assert.equal(session.queue.some(item => item.type === 'compact'), false);
    assert.equal(session.queue.some(item => item.type === 'compact-commit'), true);

    await router.processSessionQueue(sessionId);
    session = await sessionManager.getSession(sessionId);
    assert.equal(session.meta.wait?.id, wait.id);
    assert.equal(session.queue.length, 0);
    assert.equal(observedTurns.length, 0);
    assert(session.history.some(message => message.parts.some(part => (part.text || '').includes('summary created while session was waiting'))));
    assert(session.history.some(message => message.parts.some(part => (part.system || '').includes('Compaction completed.'))));

    await sessionManager.queueSessionWaitTimeoutEvent(
      sessionId,
      wait.id,
      buildWaitTimeoutMessage({ waitTimeoutSeconds: 30 }),
    );

    session = await sessionManager.getSession(sessionId);
    assert.equal(session.meta.wait, undefined);
    assert.equal(session.queue.length, 1);
    assert.equal(session.queue[0].waitTimeoutId, wait.id);

    await router.processSessionQueue(sessionId);
    assert.equal(observedTurns.length, 1);
    assert.match(observedTurns[0], /wait timeout reached after 30s/);
  } finally {
    (llm as any).chat = originalChat;
    (vector as any).scheduleSessionArchiveIndex = originalArchiveIndex;
    await cleanupSession(sessionId);
  }
});

test('wait without timeout works and does not schedule a timeout wake', async () => {
  await withTempTimerStore(async () => {
    const sessionId = makeSessionId('wait_no_timeout');
    try {
      const session = await sessionManager.getSession(sessionId);
      const result = await tool_wait({}, { sessionId, session });
      assert.equal(result.output, 'ok');

      await sleep(80);
      const reloaded = await sessionManager.getSession(sessionId);
      assert.equal(reloaded.queue.length, 0);
      assert.equal(typeof reloaded.meta.wait?.id, 'string');
      assert.equal(reloaded.meta.wait?.timeoutSeconds, undefined);
    } finally {
      await cleanupSession(sessionId);
    }
  });
});

test('wait with timeoutSeconds 0 works as no timeout', async () => {
  await withTempTimerStore(async () => {
    const sessionId = makeSessionId('wait_zero_timeout');
    try {
      const session = await sessionManager.getSession(sessionId);
      const result = await tool_wait({ timeoutSeconds: 0 }, { sessionId, session });
      assert.equal(result.output, 'ok');

      await sleep(80);
      const reloaded = await sessionManager.getSession(sessionId);
      assert.equal(reloaded.queue.length, 0);
      assert.equal(typeof reloaded.meta.wait?.id, 'string');
      assert.equal(reloaded.meta.wait?.timeoutSeconds, undefined);
    } finally {
      await cleanupSession(sessionId);
    }
  });
});

test('wait with positive timeout schedules an internal timer that wakes the session', async () => {
  await withTempTimerStore(async () => {
    const sessionId = makeSessionId('wait_scheduled_timeout');
    try {
      const session = await sessionManager.getSession(sessionId);
      const result = await tool_wait({ timeoutSeconds: 0.1 }, { sessionId, session });
      assert.equal(result.output, 'ok');

      await sleep(350);
      const reloaded = await sessionManager.getSession(sessionId);
      assert.equal(reloaded.meta.wait, undefined);
      assert.equal(reloaded.queue.length, 1);
      assert.match(String(reloaded.queue[0].parts?.[0]?.system), /wait timeout reached after 0\.1s/);
    } finally {
      await cleanupSession(sessionId);
    }
  });
});

test('direct idle user messages enter the session queue gate and preserve source headers and inlineData', async () => {
  const sessionId = makeSessionId('wait_direct_queue');
  const channelId = makeSessionId('webui_direct_queue');
  const conversationId = sessionId;
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const observedTurns: Array<{ text: string; parts: MessagePart[] | null }> = [];

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    const text = flattenPartsText(parts);
    const responseText = `direct queued response ${observedTurns.length + 1}`;
    await appendStubTurn(activeSession, parts, responseText);
    observedTurns.push({ text, parts });
    return { text: responseText };
  };

  sessionManager.setSessionTriggerCallback((triggeredSessionId) => {
    if (triggeredSessionId === sessionId) {
      void router.processSessionQueue(triggeredSessionId);
    }
  });

  try {
    await sessionManager.getSession(sessionId);
    sessionManager.attachChannel(channelId, conversationId, sessionId);

    await router.handleMessage({
      platform: 'webui',
      channelType: 'webui',
      channelId,
      channelUserId: conversationId,
      conversationId,
      senderId: 'webui-user',
      username: 'webui-user',
      reply: async () => {},
      sendTyping: async () => {},
    }, {
      parts: [
        { text: 'hello from direct queue' },
        { inlineData: { mimeType: 'image/png', data: Buffer.from('png').toString('base64') } },
      ],
      channelUserId: conversationId,
      conversationId,
      username: 'webui-user',
    });

    await waitFor(() => observedTurns.length === 1);
    await waitForSessionIdle(sessionId);
    assert.equal(observedTurns.length, 1);
    assert.ok(observedTurns[0].text.includes(`channel_instance_id: \`${channelId}\``));
    assert.ok(observedTurns[0].text.includes(`conversation_id: \`${conversationId}\``));
    assert.match(observedTurns[0].text, /channel_target_id:/);
    assert.match(observedTurns[0].text, /sender: `webui-user`/);
    assert.match(observedTurns[0].text, /hello from direct queue/);
    assert(observedTurns[0].parts?.some(part => part.inlineData?.mimeType === 'image/png'));
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await cleanupSession(sessionId);
  }
});

test('command, unauthorized, and busy queued notices still reply immediately before normal user enqueue', async () => {
  const busySessionId = makeSessionId('wait_direct_busy_notice');
  const busyChannelId = makeSessionId('webui_busy_notice');
  const busyReplies: string[] = [];
  const commandReplies: string[] = [];
  const unauthorizedReplies: string[] = [];
  const router = new MessageRouter();
  router.setCommandHandler(async () => false);

  try {
    const busySession = await sessionManager.getSession(busySessionId);
    busySession.busy = true;
    await sessionManager.saveSession(busySessionId);
    sessionManager.attachChannel(busyChannelId, busySessionId, busySessionId);

    await router.handleMessage({
      platform: 'webui',
      channelType: 'webui',
      channelId: busyChannelId,
      channelUserId: busySessionId,
      conversationId: busySessionId,
      senderId: 'webui-user',
      username: 'webui-user',
      preferDirectReply: true,
      reply: async (text: string) => { busyReplies.push(text); },
      sendTyping: async () => {},
    }, {
      parts: [{ text: 'queue me while busy' }],
      channelUserId: busySessionId,
      conversationId: busySessionId,
      username: 'webui-user',
    });

    assert.match(busyReplies[0] || '', /Request queued/);
    const busyReloaded = await sessionManager.getSession(busySessionId);
    assert.equal(busyReloaded.queue.length, 1);

    await router.handleMessage({
      platform: 'webui',
      channelType: 'webui',
      channelId: makeSessionId('webui_command_notice'),
      channelUserId: makeSessionId('webui_command_conv'),
      conversationId: makeSessionId('webui_command_conv'),
      senderId: 'webui-user',
      username: 'webui-user',
      reply: async (text: string) => { commandReplies.push(text); },
      sendTyping: async () => {},
    }, {
      parts: [{ text: '/unknown-wait-test-command' }],
      channelUserId: 'command-conv',
      conversationId: 'command-conv',
      username: 'webui-user',
    });
    assert.match(commandReplies[0] || '', /Unknown command/);

    await router.handleMessage({
      platform: 'telegram',
      channelType: 'telegram',
      channelId: makeSessionId('telegram_unauthorized_notice'),
      channelUserId: makeSessionId('unauthorized_conv'),
      conversationId: makeSessionId('unauthorized_conv'),
      senderId: 'unauthorized-user',
      username: 'unauthorized-user',
      reply: async (text: string) => { unauthorizedReplies.push(text); },
      sendTyping: async () => {},
    }, {
      parts: [{ text: 'not authorized' }],
      channelUserId: 'unauthorized-conv',
      conversationId: 'unauthorized-conv',
      username: 'unauthorized-user',
    });
    assert.match(unauthorizedReplies[0] || '', /Unauthorized/);
  } finally {
    const busy = await sessionManager.getSession(busySessionId).catch((_err: unknown): null => null);
    if (busy) {
      busy.busy = false;
      await sessionManager.saveSession(busySessionId);
    }
    await cleanupSession(busySessionId);
  }
});

test('wait timeout wakes via router before a later ordinary timer', async () => {
  await withTempTimerStore(async () => {
    const sessionId = makeSessionId('wait_before_ordinary_timer');
    const router = new MessageRouter();
    const originalChat = llm.chat;
    const observedTurns: string[] = [];

    (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
      assert.equal(activeSession.id, sessionId);
      const text = (parts || [])
        .map(part => part.system || part.text || '')
        .join('\n');
      observedTurns.push(text);
      await sessionManager.appendSessionMessage(activeSession, {
        role: 'user',
        parts: parts || [],
      });
      const responseText = `observed turn ${observedTurns.length}`;
      await sessionManager.appendSessionMessage(activeSession, {
        role: 'model',
        parts: [{ text: responseText }],
      });
      return { text: responseText };
    };

    sessionManager.setSessionTriggerCallback((triggeredSessionId) => {
      if (triggeredSessionId === sessionId) {
        void router.processSessionQueue(triggeredSessionId);
      }
    });

    try {
      const session = await sessionManager.getSession(sessionId);
      await createTimer({
        sessionId,
        afterSeconds: 0.2,
        message: 'ordinary timer fired for wait test',
      });
      await tool_wait({ timeoutSeconds: 0.02 }, { sessionId, session });

      await sleep(120);
      assert.equal(observedTurns.length, 1);
      assert.match(observedTurns[0], /wait timeout reached after 0\.02s/);

      await sleep(220);
      assert.equal(observedTurns.length, 2);
      assert.match(observedTurns[1], /Timer fired/);
      assert.match(observedTurns[1], /ordinary timer fired for wait test/);
    } finally {
      (llm as any).chat = originalChat;
      sessionManager.setSessionTriggerCallback(() => {});
      await cleanupSession(sessionId);
    }
  });
});

test('wait rejects negative and NaN timeoutSeconds', async () => {
  const sessionId = makeSessionId('wait_bad_timeout');
  try {
    const session = await sessionManager.getSession(sessionId);
    await assert.rejects(
      () => tool_wait({ timeoutSeconds: -1 }, { sessionId, session }),
      /timeoutSeconds must be a non-negative number/,
    );
    await assert.rejects(
      () => tool_wait({ timeoutSeconds: Number.NaN }, { sessionId, session }),
      /timeoutSeconds must be a non-negative number/,
    );
  } finally {
    await cleanupSession(sessionId);
  }
});

test('new session event clears active wait and makes later timeout stale', async () => {
  const sessionId = makeSessionId('wait_timeout_cancel');
  try {
    await sessionManager.getSession(sessionId);
    const wait = await sessionManager.startSessionWait(sessionId, { timeoutSeconds: 30 });

    await sessionManager.queueSessionSystemEvent(sessionId, 'external wakeup', 'background');
    let session = await sessionManager.getSession(sessionId);
    assert.equal(session.meta.wait, undefined);
    assert.equal(session.queue.length, 1);

    await sessionManager.queueSessionWaitTimeoutEvent(
      sessionId,
      wait.id,
      buildWaitTimeoutMessage({ waitTimeoutSeconds: 30 }),
    );

    session = await sessionManager.getSession(sessionId);
    assert.equal(session.queue.length, 1);
    assert.equal(session.queue[0].waitTimeoutId, undefined);
  } finally {
    await cleanupSession(sessionId);
  }
});

test('direct session turn wake clears active wait token', async () => {
  const sessionId = makeSessionId('wait_timeout_direct');
  try {
    const session = await sessionManager.getSession(sessionId);
    const wait = await sessionManager.startSessionWait(sessionId, { timeoutSeconds: 45 });

    assert.equal(sessionManager.clearSessionWaitForDirectTurn(session, 'test-direct'), true);
    assert.equal(session.meta.wait, undefined);

    await sessionManager.queueSessionWaitTimeoutEvent(
      sessionId,
      wait.id,
      buildWaitTimeoutMessage({ waitTimeoutSeconds: 45 }),
    );

    const reloaded = await sessionManager.getSession(sessionId);
    assert.equal(reloaded.queue.length, 0);
  } finally {
    await cleanupSession(sessionId);
  }
});

test('new wait token replaces older wait timeout token', async () => {
  const sessionId = makeSessionId('wait_timeout_stale');
  try {
    await sessionManager.getSession(sessionId);
    const oldWait = await sessionManager.startSessionWait(sessionId, { timeoutSeconds: 30 });
    const newWait = await sessionManager.startSessionWait(sessionId, { timeoutSeconds: 60 });

    await sessionManager.queueSessionWaitTimeoutEvent(
      sessionId,
      oldWait.id,
      buildWaitTimeoutMessage({ waitTimeoutSeconds: 30 }),
    );

    const session = await sessionManager.getSession(sessionId);
    assert.equal(session.queue.length, 0);
    assert.equal(session.meta.wait?.id, newWait.id);
  } finally {
    await cleanupSession(sessionId);
  }
});

test('waitAllSessions waits for every listed session before triggering one turn', async () => {
  const parentId = makeSessionId('wait_all_parent');
  const childAId = makeSessionId('wait_all_child_a');
  const childBId = makeSessionId('wait_all_child_b');
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const observedTurns: string[] = [];
  let triggerCount = 0;

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    const text = flattenPartsText(parts);
    const responseText = `wait all response ${observedTurns.length + 1}`;
    await appendStubTurn(activeSession, parts, responseText);
    observedTurns.push(text);
    return { text: responseText };
  };

  sessionManager.setSessionTriggerCallback((triggeredSessionId) => {
    if (triggeredSessionId === parentId) {
      triggerCount += 1;
      void router.processSessionQueue(triggeredSessionId);
    }
  });

  try {
    const parent = await sessionManager.getSession(parentId);
    await sessionManager.getSession(childAId);
    await sessionManager.getSession(childBId);

    await tool_wait({ waitAllSessions: [childAId, childBId] }, { sessionId: parentId, session: parent });
    await sessionManager.sendToSession(parentId, 'A report', childAId);
    await sleep(60);

    let reloaded = await sessionManager.getSession(parentId);
    assert.equal(triggerCount, 0);
    assert.equal(observedTurns.length, 0);
    assert.equal(reloaded.queue.length, 0);
    assert.deepEqual(reloaded.meta.wait?.waitAll?.satisfiedSessions, [childAId]);
    assert.equal(reloaded.meta.wait?.waitAll?.deferredQueue.length, 1);

    await sessionManager.sendToSession(parentId, 'B report', childBId);
    await waitFor(() => observedTurns.length === 1);
    await waitForSessionIdle(parentId);
    assert.equal(observedTurns.length, 1);
    reloaded = await sessionManager.getSession(parentId);
    assert.equal(triggerCount, 1);
    assert.equal(reloaded.meta.wait, undefined);
    assert.match(observedTurns[0], /A report/);
    assert.match(observedTurns[0], /B report/);
    assert(observedTurns[0].indexOf('A report') < observedTurns[0].indexOf('B report'));
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await cleanupSession(parentId);
    await cleanupSession(childAId);
    await cleanupSession(childBId);
  }
});

test('waitAllSessions duplicate reports from one listed session do not complete early', async () => {
  const parentId = makeSessionId('wait_all_dupe_parent');
  const childAId = makeSessionId('wait_all_dupe_child_a');
  const childBId = makeSessionId('wait_all_dupe_child_b');
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const observedTurns: string[] = [];

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    const text = flattenPartsText(parts);
    const responseText = `wait all duplicate response ${observedTurns.length + 1}`;
    await appendStubTurn(activeSession, parts, responseText);
    observedTurns.push(text);
    return { text: responseText };
  };

  sessionManager.setSessionTriggerCallback((triggeredSessionId) => {
    if (triggeredSessionId === parentId) {
      void router.processSessionQueue(triggeredSessionId);
    }
  });

  try {
    const parent = await sessionManager.getSession(parentId);
    await sessionManager.getSession(childAId);
    await sessionManager.getSession(childBId);
    await tool_wait({ waitAllSessions: [childAId, childBId] }, { sessionId: parentId, session: parent });

    await sessionManager.sendToSession(parentId, 'A report 1', childAId);
    await sessionManager.sendToSession(parentId, 'A report 2', childAId);
    await sleep(60);

    let reloaded = await sessionManager.getSession(parentId);
    assert.equal(observedTurns.length, 0);
    assert.deepEqual(reloaded.meta.wait?.waitAll?.satisfiedSessions, [childAId]);
    assert.equal(reloaded.meta.wait?.waitAll?.deferredQueue.length, 2);

    await sessionManager.sendToSession(parentId, 'B final report', childBId);
    await waitFor(() => observedTurns.length === 1);
    await waitForSessionIdle(parentId);
    assert.equal(observedTurns.length, 1);
    reloaded = await sessionManager.getSession(parentId);
    assert.equal(reloaded.meta.wait, undefined);
    assert.match(observedTurns[0], /A report 1/);
    assert.match(observedTurns[0], /A report 2/);
    assert.match(observedTurns[0], /B final report/);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await cleanupSession(parentId);
    await cleanupSession(childAId);
    await cleanupSession(childBId);
  }
});

test('waitAllSessions unrelated intersession wake flushes deferred reports with pending reminder', async () => {
  const parentId = makeSessionId('wait_all_unrelated_parent');
  const childAId = makeSessionId('wait_all_unrelated_child_a');
  const childBId = makeSessionId('wait_all_unrelated_child_b');
  const childCId = makeSessionId('wait_all_unrelated_child_c');
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const observedTurns: string[] = [];

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    const text = flattenPartsText(parts);
    const responseText = `wait all unrelated response ${observedTurns.length + 1}`;
    await appendStubTurn(activeSession, parts, responseText);
    observedTurns.push(text);
    return { text: responseText };
  };

  sessionManager.setSessionTriggerCallback((triggeredSessionId) => {
    if (triggeredSessionId === parentId) {
      void router.processSessionQueue(triggeredSessionId);
    }
  });

  try {
    const parent = await sessionManager.getSession(parentId);
    await sessionManager.getSession(childAId);
    await sessionManager.getSession(childBId);
    await sessionManager.getSession(childCId);
    await tool_wait({ waitAllSessions: [childAId, childBId] }, { sessionId: parentId, session: parent });

    await sessionManager.sendToSession(parentId, 'A partial report', childAId);
    await sleep(40);
    assert.equal(observedTurns.length, 0);

    await sessionManager.sendToSession(parentId, 'C unrelated wake', childCId);
    await waitFor(() => observedTurns.length === 1);
    await waitForSessionIdle(parentId);
    assert.equal(observedTurns.length, 1);
    const reloaded = await sessionManager.getSession(parentId);
    assert.equal(reloaded.meta.wait, undefined);
    assert.match(observedTurns[0], /A partial report/);
    assert.match(observedTurns[0], /C unrelated wake/);
    assert.match(observedTurns[0], /waitAllSessions is still pending/);
    assert.match(observedTurns[0], new RegExp(childBId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await cleanupSession(parentId);
    await cleanupSession(childAId);
    await cleanupSession(childBId);
    await cleanupSession(childCId);
  }
});

test('waitAllSessions direct user wake shares the queue gate and gets a pending reminder', async () => {
  const parentId = makeSessionId('wait_all_direct_parent');
  const childAId = makeSessionId('wait_all_direct_child_a');
  const childBId = makeSessionId('wait_all_direct_child_b');
  const channelId = makeSessionId('webui_wait_all_direct');
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const observedTurns: string[] = [];

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    const text = flattenPartsText(parts);
    const responseText = `wait all direct response ${observedTurns.length + 1}`;
    await appendStubTurn(activeSession, parts, responseText);
    observedTurns.push(text);
    return { text: responseText };
  };

  sessionManager.setSessionTriggerCallback((triggeredSessionId) => {
    if (triggeredSessionId === parentId) {
      void router.processSessionQueue(triggeredSessionId);
    }
  });

  try {
    const parent = await sessionManager.getSession(parentId);
    await sessionManager.getSession(childAId);
    await sessionManager.getSession(childBId);
    sessionManager.attachChannel(channelId, parentId, parentId);
    await tool_wait({ waitAllSessions: [childAId, childBId] }, { sessionId: parentId, session: parent });
    await sessionManager.sendToSession(parentId, 'A before direct user', childAId);
    await sleep(40);
    assert.equal(observedTurns.length, 0);

    await router.handleMessage({
      platform: 'webui',
      channelType: 'webui',
      channelId,
      channelUserId: parentId,
      conversationId: parentId,
      senderId: 'webui-user',
      username: 'webui-user',
      reply: async () => {},
      sendTyping: async () => {},
    }, {
      parts: [{ text: 'direct user wake' }],
      channelUserId: parentId,
      conversationId: parentId,
      username: 'webui-user',
    });

    await waitFor(() => observedTurns.length === 1);
    await waitForSessionIdle(parentId);
    assert.equal(observedTurns.length, 1);
    assert.match(observedTurns[0], /A before direct user/);
    assert.match(observedTurns[0], /direct user wake/);
    assert.match(observedTurns[0], /waitAllSessions is still pending/);
    assert.match(observedTurns[0], new RegExp(childBId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const reloaded = await sessionManager.getSession(parentId);
    assert.equal(reloaded.meta.wait, undefined);
  } finally {
    (llm as any).chat = originalChat;
    sessionManager.setSessionTriggerCallback(() => {});
    await cleanupSession(parentId);
    await cleanupSession(childAId);
    await cleanupSession(childBId);
  }
});

test('waitAllSessions timeout wake flushes deferred reports with pending reminder and successful all makes timeout stale', async () => {
  const timeoutParentId = makeSessionId('wait_all_timeout_parent');
  const staleParentId = makeSessionId('wait_all_timeout_stale_parent');
  const childAId = makeSessionId('wait_all_timeout_child_a');
  const childBId = makeSessionId('wait_all_timeout_child_b');
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const observedTurns: string[] = [];

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    const text = flattenPartsText(parts);
    const responseText = `wait all timeout response ${observedTurns.length + 1}`;
    await appendStubTurn(activeSession, parts, responseText);
    observedTurns.push(text);
    return { text: responseText };
  };

  try {
    await sessionManager.getSession(childAId);
    await sessionManager.getSession(childBId);

    await sessionManager.getSession(timeoutParentId);
    const timeoutWait = await sessionManager.startSessionWait(timeoutParentId, {
      timeoutSeconds: 30,
      waitAllSessions: [childAId, childBId],
    });
    await sessionManager.sendToSession(timeoutParentId, 'A before timeout', childAId);
    await sessionManager.queueSessionWaitTimeoutEvent(
      timeoutParentId,
      timeoutWait.id,
      buildWaitTimeoutMessage({ waitTimeoutSeconds: 30 }),
    );

    let timeoutSession = await sessionManager.getSession(timeoutParentId);
    assert.equal(timeoutSession.meta.wait, undefined);
    assert.equal(timeoutSession.queue.length, 3);
    assert.match(flattenPartsText(timeoutSession.queue[0].parts), /A before timeout/);
    assert.match(flattenPartsText(timeoutSession.queue[1].parts), /wait timeout reached after 30s/);
    assert.match(flattenPartsText(timeoutSession.queue[2].parts), /waitAllSessions is still pending/);
    await router.processSessionQueue(timeoutParentId);
    assert.equal(observedTurns.length, 1);
    assert.match(observedTurns[0], /A before timeout/);
    assert.match(observedTurns[0], /wait timeout reached after 30s/);
    assert.match(observedTurns[0], new RegExp(childBId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    await sessionManager.getSession(staleParentId);
    const staleWait = await sessionManager.startSessionWait(staleParentId, {
      timeoutSeconds: 30,
      waitAllSessions: [childAId, childBId],
    });
    await sessionManager.sendToSession(staleParentId, 'A before success', childAId);
    await sessionManager.sendToSession(staleParentId, 'B before success', childBId);
    let staleSession = await sessionManager.getSession(staleParentId);
    assert.equal(staleSession.meta.wait, undefined);
    assert.equal(staleSession.queue.length, 2);
    await sessionManager.queueSessionWaitTimeoutEvent(
      staleParentId,
      staleWait.id,
      buildWaitTimeoutMessage({ waitTimeoutSeconds: 30 }),
    );
    staleSession = await sessionManager.getSession(staleParentId);
    assert.equal(staleSession.queue.length, 2);
  } finally {
    (llm as any).chat = originalChat;
    await cleanupSession(timeoutParentId);
    await cleanupSession(staleParentId);
    await cleanupSession(childAId);
    await cleanupSession(childBId);
  }
});

test('waitAllSessions leaves compact maintenance wait-neutral without flushing partial reports', async () => {
  const parentId = makeSessionId('wait_all_compact_parent');
  const childAId = makeSessionId('wait_all_compact_child_a');
  const childBId = makeSessionId('wait_all_compact_child_b');
  const router = new MessageRouter();
  const originalChat = llm.chat;
  const observedTurns: string[] = [];

  (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
    const text = flattenPartsText(parts);
    const responseText = `wait all compact response ${observedTurns.length + 1}`;
    await appendStubTurn(activeSession, parts, responseText);
    observedTurns.push(text);
    return { text: responseText };
  };

  try {
    const parent = await sessionManager.getSession(parentId);
    await sessionManager.getSession(childAId);
    await sessionManager.getSession(childBId);
    await tool_wait({ waitAllSessions: [childAId, childBId] }, { sessionId: parentId, session: parent });
    await sessionManager.sendToSession(parentId, 'A before compact', childAId);
    await sessionManager.enqueueSessionItem(parentId, { type: 'compact-commit' });

    let reloaded = await sessionManager.getSession(parentId);
    assert.equal(reloaded.meta.wait?.id, parent.meta.wait?.id);
    assert.equal(reloaded.meta.wait?.waitAll?.deferredQueue.length, 1);
    assert.deepEqual(reloaded.queue.map(item => item.type), ['compact-commit']);

    await router.processSessionQueue(parentId);
    reloaded = await sessionManager.getSession(parentId);
    assert.equal(observedTurns.length, 0);
    assert.equal(reloaded.meta.wait?.waitAll?.deferredQueue.length, 1);

    await sessionManager.sendToSession(parentId, 'B after compact', childBId);
    await router.processSessionQueue(parentId);
    await waitFor(() => observedTurns.length === 1);
    assert.match(observedTurns[0], /A before compact/);
    assert.match(observedTurns[0], /B after compact/);
  } finally {
    (llm as any).chat = originalChat;
    await cleanupSession(parentId);
    await cleanupSession(childAId);
    await cleanupSession(childBId);
  }
});

test('starting a new wait refuses to discard deferred waitAllSessions messages', async () => {
  const parentId = makeSessionId('wait_all_replace_parent');
  const childAId = makeSessionId('wait_all_replace_child_a');
  const childBId = makeSessionId('wait_all_replace_child_b');
  try {
    await sessionManager.getSession(parentId);
    await sessionManager.getSession(childAId);
    await sessionManager.getSession(childBId);
    await sessionManager.startSessionWait(parentId, { waitAllSessions: [childAId, childBId] });
    await sessionManager.sendToSession(parentId, 'A hidden report', childAId);

    await assert.rejects(
      () => sessionManager.startSessionWait(parentId, { timeoutSeconds: 5 }),
      /previous waitAllSessions has deferred messages/,
    );
    const reloaded = await sessionManager.getSession(parentId);
    assert.equal(reloaded.meta.wait?.waitAll?.deferredQueue.length, 1);
  } finally {
    await cleanupSession(parentId);
    await cleanupSession(childAId);
    await cleanupSession(childBId);
  }
});
