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
