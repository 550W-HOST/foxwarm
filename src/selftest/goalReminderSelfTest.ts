import assert from 'assert';
import fs from 'fs-extra';
import { MessageRouter } from '../messageRouter';
import * as llm from '../llm';
import * as sessionManager from '../sessionManager';
import * as vector from '../vector';
import { Message, Session } from '../types';
import { tool_set_goal } from '../toolsSessionAgent';
import { getSessionHistoryFilePath } from '../session/metadataStore';

function makeSessionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createBaseSession(id: string, parentSessionId?: string): Session {
  return {
    id,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
    parentSessionId,
  };
}

async function ensureSession(id: string, parentSessionId?: string): Promise<Session> {
  const existing = await sessionManager.getSession(id);
  Object.assign(existing, createBaseSession(id, parentSessionId));
  await sessionManager.saveSession(id);
  return existing;
}

async function cleanupSessions(sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    try {
      await sessionManager.deleteSession(sessionId);
    } catch {
      // ignore
    }
  }
}

function countGoalReminders(session: Session): number {
  return session.history.filter(message => message.__meta?.goalReminder === true).length;
}

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

async function main(): Promise<void> {
  await sessionManager.loadSessions();

  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  const originalArchiveIndex = (vector as any).scheduleSessionArchiveIndex;
  (vector as any).scheduleSessionArchiveIndex = async () => 0;
  const router = new MessageRouter();
  const createdSessionIds: string[] = [];

  try {
    await test('set_goal persists configuration and clears cleanly', async () => {
      const sessionId = makeSessionId('selftest_goal_persist');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      const result = await tool_set_goal({ goal: '- [ ] write docs', remindEvery: 3 }, { sessionId, session });
      assert.strictEqual(String(result), 'ok');
      assert.strictEqual(session.goalState?.goal, '- [ ] write docs');
      assert.strictEqual(session.goalState?.remindEvery, 3);

      const historyPayload = await fs.readJson(getSessionHistoryFilePath(sessionId));
      assert.strictEqual(historyPayload.goalState?.goal, '- [ ] write docs');
      assert.strictEqual(historyPayload.goalState?.remindEvery, 3);

      const cleared = await tool_set_goal({ clear: true }, { sessionId, session });
      assert.strictEqual(String(cleared), 'ok');
      assert.strictEqual(session.goalState, undefined);
    });

    await test('interval reminder is appended before the first provider call, not queued', async () => {
      const sessionId = makeSessionId('selftest_goal_pre_provider');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      await tool_set_goal({ goal: '- [ ] preserve the active work', remindEvery: 1 }, { sessionId, session });
      session.queue.push({
        type: 'intersession',
        message: {
          role: 'user',
          parts: [{ system: '<foxwarm-message type="inter-agent">continue the active work</foxwarm-message>' }],
        },
      });

      let chatCalls = 0;
      (llm as any).chat = async (parts: Message['parts'] | null, activeSession: Session) => {
        assert.strictEqual(activeSession.id, sessionId);
        chatCalls += 1;
        assert.strictEqual(parts, null);
        assert.strictEqual(countGoalReminders(activeSession), 1);
        assert.strictEqual(activeSession.queue.length, 0);

        const waitCall = { id: 'wait-1', name: 'wait', args: { timeoutSeconds: 0 } };
        await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ functionCall: waitCall }] });
        return { text: '', toolCalls: [waitCall] };
      };
      (llm as any).executeTools = async () => {
        const toolResult = {
          role: 'tool' as const,
          parts: [{ functionResponse: { tool_use_id: 'wait-1', name: 'wait', response: { output: 'ok' } } }],
        } as any;
        toolResult.__toolPostAction = { waitForReply: true };
        return toolResult;
      };

      await sessionManager.saveSession(sessionId);
      await router.processSessionQueue(sessionId);

      assert.strictEqual(chatCalls, 1);
      assert.strictEqual(session.queue.length, 0);
      const reminders = session.history.filter(message => message.__meta?.goalReminder === true);
      assert.strictEqual(reminders.length, 1);
      assert.strictEqual(reminders[0].__meta?.goalReminderKind, 'interval');
      const reminderIndex = session.history.indexOf(reminders[0]);
      const functionCallIndex = session.history.findIndex(message => message.parts.some(part => part.functionCall?.id === 'wait-1'));
      const toolResultIndex = session.history.findIndex(message => message.parts.some(part => part.functionResponse?.tool_use_id === 'wait-1'));
      assert.ok(reminderIndex < functionCallIndex);
      assert.ok(functionCallIndex < toolResultIndex);

      const historyPayload = await fs.readJson(getSessionHistoryFilePath(sessionId));
      assert.strictEqual(historyPayload.goalState?.anchorSeq, reminders[0].__meta?.goalAnchorSeq);
      assert.strictEqual(historyPayload.queue?.some((item: any) => item.message?.__meta?.goalReminder === true), false);

      session.history = [];
      const reloaded = await sessionManager.getSession(sessionId);
      assert.strictEqual(countGoalReminders(reloaded), 1);
      assert.strictEqual(reloaded.queue.some(item => item.message?.__meta?.goalReminder === true), false);
    });

    await test('set_goal accepts plain long-term goal text', async () => {
      const sessionId = makeSessionId('selftest_goal_validate');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      const result = await tool_set_goal({ goal: 'Ship the feature safely', remindEvery: 2 }, { sessionId, session });
      assert.strictEqual(String(result), 'ok');
      assert.strictEqual(session.goalState?.goal, 'Ship the feature safely');
    });

    await test('set_goal defaults remindEvery to current value or 20 when omitted', async () => {
      const sessionId = makeSessionId('selftest_goal_default_remind_every');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      await tool_set_goal({ goal: '- [ ] first item' }, { sessionId, session });
      assert.strictEqual(session.goalState?.remindEvery, 20);

      await tool_set_goal({ goal: '- [ ] second item', remindEvery: 4 }, { sessionId, session });
      assert.strictEqual(session.goalState?.remindEvery, 4);
    });

    await test('completed turns do not append end-turn goal reminders', async () => {
      const sessionId = makeSessionId('selftest_goal_no_endturn');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      await tool_set_goal({ goal: '- [ ] keep the goal at pre-provider boundaries', remindEvery: 99 }, { sessionId, session });
      (llm as any).chat = async (parts: Message['parts'] | null, activeSession: Session) => {
        if (parts?.length) {
          await sessionManager.appendSessionMessage(activeSession, { role: 'user', parts });
        }
        await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ text: 'Normal reply' }] });
        return { text: 'Normal reply' };
      };

      session.queue.push({ type: 'user', parts: [{ text: 'normal turn' }] });
      await sessionManager.saveSession(sessionId);
      await router.processSessionQueue(sessionId);

      assert.strictEqual(countGoalReminders(session), 0);
    });

    await test('interval reminder is appended after a complete tool result before the next provider call', async () => {
      const sessionId = makeSessionId('selftest_goal_between_tools');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      await tool_set_goal({ goal: '- [ ] keep the tool loop on task', remindEvery: 2 }, { sessionId, session });
      session.queue.push({ type: 'user', parts: [{ text: 'start the tool loop' }] });

      let chatCalls = 0;
      (llm as any).chat = async (parts: Message['parts'] | null, activeSession: Session) => {
        chatCalls += 1;
        if (chatCalls === 1) {
          assert.strictEqual(parts, null);
          assert.strictEqual(countGoalReminders(activeSession), 0);
          const readCall = { id: 'read-1', name: 'read', args: { filePath: 'README.md' } };
          await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ functionCall: readCall }] });
          return { text: '', toolCalls: [readCall] };
        }

        assert.strictEqual(parts, null);
        const reminder = activeSession.history.find(message => message.__meta?.goalReminder === true);
        assert.ok(reminder);
        const reminderIndex = activeSession.history.indexOf(reminder);
        const functionCallIndex = activeSession.history.findIndex(message => message.parts.some(part => part.functionCall?.id === 'read-1'));
        const toolResultIndex = activeSession.history.findIndex(message => message.parts.some(part => part.functionResponse?.tool_use_id === 'read-1'));
        assert.ok(functionCallIndex < toolResultIndex);
        assert.ok(toolResultIndex < reminderIndex);
        await sessionManager.appendSessionMessage(activeSession, { role: 'model', parts: [{ text: 'tool loop completed' }] });
        return { text: 'tool loop completed' };
      };
      (llm as any).executeTools = async () => ({
        role: 'tool',
        parts: [{ functionResponse: { tool_use_id: 'read-1', name: 'read', response: { output: 'ok' } } }],
      });

      await sessionManager.saveSession(sessionId);
      await router.processSessionQueue(sessionId);

      assert.strictEqual(chatCalls, 2);
      assert.strictEqual(session.queue.length, 0);
      const reminders = session.history.filter(message => message.__meta?.goalReminder === true);
      assert.strictEqual(reminders.length, 1);
      assert.strictEqual(reminders[0].__meta?.goalReminderKind, 'interval');
    });

    console.log('goal reminder selftest passed');
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    (vector as any).scheduleSessionArchiveIndex = originalArchiveIndex;
    await cleanupSessions(createdSessionIds);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
