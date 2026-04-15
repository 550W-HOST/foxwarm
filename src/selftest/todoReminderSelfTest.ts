import assert from 'assert';
import fs from 'fs-extra';
import { MessageRouter } from '../messageRouter';
import * as llm from '../llm';
import * as sessionManager from '../sessionManager';
import * as vector from '../vector';
import { Message, Session } from '../types';
import { tool_set_todo } from '../toolsSessionAgent';
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

async function append(session: Session, message: Message): Promise<void> {
  await sessionManager.appendSessionMessage(session, message);
}

async function appendStubUserMessage(session: Session, parts: Message['parts'] | null): Promise<void> {
  if (!parts?.length) {
    return;
  }

  await sessionManager.appendSessionMessage(session, {
    role: 'user',
    parts,
  });
}

async function appendStubModelMessage(session: Session, text: string): Promise<void> {
  await sessionManager.appendSessionMessage(session, {
    role: 'model',
    parts: [{ text }],
  });
}

function countTodoReminders(session: Session): number {
  return session.history.filter(message => message.__meta?.todoReminder === true).length;
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
  const originalArchiveIndex = (vector as any).scheduleSessionArchiveIndex;
  (vector as any).scheduleSessionArchiveIndex = async () => 0;
  const router = new MessageRouter();
  const createdSessionIds: string[] = [];

  try {
    await test('set_todo persists configuration and clears cleanly', async () => {
      const sessionId = makeSessionId('selftest_todo_persist');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      const result = await tool_set_todo({ todo: '- [ ] write docs', remindEvery: 3 }, { sessionId, session });
      assert.strictEqual(String(result), 'ok');
      assert.strictEqual(session.todoState?.todo, '- [ ] write docs');
      assert.strictEqual(session.todoState?.remindEvery, 3);
      assert.strictEqual(session.todoState?.remindOnTurnEnd, true);

      const historyPayload = await fs.readJson(getSessionHistoryFilePath(sessionId));
      assert.strictEqual(historyPayload.todoState?.todo, '- [ ] write docs');
      assert.strictEqual(historyPayload.todoState?.remindEvery, 3);
      assert.strictEqual(historyPayload.todoState?.remindOnTurnEnd, true);

      const cleared = await tool_set_todo({ clear: true }, { sessionId, session });
      assert.strictEqual(String(cleared), 'ok');
      assert.strictEqual(session.todoState, undefined);
    });

    await test('todo reminder counts exact later non-reminder messages and repeats within the same busy tool loop', async () => {
      const sessionId = makeSessionId('selftest_todo_loop');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      (llm as any).chat = async (parts: Message['parts'] | null, activeSession: Session) => {
        assert.strictEqual(activeSession.id, sessionId);
        await appendStubUserMessage(activeSession, parts);
        await appendStubModelMessage(activeSession, '[NO_ACTION]');
        return { text: '[NO_ACTION]' };
      };

      await append(session, {
        role: 'model',
        parts: [{ functionCall: { id: 'set-todo-1', name: 'set_todo', args: { todo: '- [ ] ship feature', remindEvery: 2 } } }],
      });

      session.busy = true;
      await tool_set_todo({ todo: '- [ ] ship feature', remindEvery: 2 }, { sessionId, session });
      assert.strictEqual(session.todoState?.anchorSeq, 1);

      await append(session, {
        role: 'tool',
        parts: [{ functionResponse: { tool_use_id: 'set-todo-1', name: 'set_todo', response: { output: 'ok' } } }],
      });
      assert.strictEqual(countTodoReminders(session), 0);

      await append(session, {
        role: 'model',
        parts: [{ text: 'Working on it.' }],
      });
      assert.strictEqual(countTodoReminders(session), 0);
      assert.strictEqual(session.queue.length, 1);
      assert.strictEqual(session.todoState?.anchorSeq, 3);

      await append(session, {
        role: 'tool',
        parts: [{ functionResponse: { tool_use_id: 'other-1', name: 'read', response: { output: 'done' } } }],
      });
      assert.strictEqual(countTodoReminders(session), 0);

      await append(session, {
        role: 'model',
        parts: [{ functionCall: { id: 'other-2', name: 'exec', args: { command: 'echo hi' } } }],
      });
      assert.strictEqual(countTodoReminders(session), 0);
      assert.strictEqual(session.queue.length, 2);
      assert.strictEqual(session.todoState?.anchorSeq, 5);

      await append(session, {
        role: 'tool',
        parts: [{ functionResponse: { tool_use_id: 'other-2', name: 'exec', response: { output: 'hi' } } }],
      });
      assert.strictEqual(countTodoReminders(session), 0);

      session.busy = false;
      await sessionManager.saveSession(sessionId);

      await router.processSessionQueue(sessionId);
      if (session.queue.length > 0) {
        await router.processSessionQueue(sessionId);
      }

      assert.strictEqual(countTodoReminders(session), 2);
      const firstReminder = session.history.find(message => message.__meta?.todoReminder === true)!;
      assert.strictEqual(firstReminder.__meta?.todoReminder, true);
      assert.match(firstReminder.parts[0].system || '', /TODO reminder for this session/);
      assert.match(firstReminder.parts[1].text || '', /- \[ \] ship feature/);
      const reminderSeqs = session.history
        .filter(message => message.__meta?.todoReminder === true)
        .map(message => message.__meta?.todoAnchorSeq);
      assert.deepStrictEqual(reminderSeqs, [3, 5]);

      await append(session, {
        role: 'user',
        parts: [{ text: 'next turn message' }],
      });
      assert.strictEqual(countTodoReminders(session), 2);
      assert.strictEqual(session.queue.length, 1);

      await router.processSessionQueue(sessionId);
      assert.strictEqual(countTodoReminders(session), 3);
    });

    await test('set_todo rejects non-checklist todo text', async () => {
      const sessionId = makeSessionId('selftest_todo_validate');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      await assert.rejects(
        () => tool_set_todo({ todo: 'plain text', remindEvery: 2 }, { sessionId, session }),
        /markdown checklist item/
      );
    });

    await test('set_todo defaults remindEvery to current value or 10 when omitted', async () => {
      const sessionId = makeSessionId('selftest_todo_default_remind_every');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      await tool_set_todo({ todo: '- [ ] first item' }, { sessionId, session });
      assert.strictEqual(session.todoState?.remindEvery, 10);
      assert.strictEqual(session.todoState?.remindOnTurnEnd, true);

      await tool_set_todo({ todo: '- [ ] second item', remindEvery: 4, remindOnTurnEnd: false }, { sessionId, session });
      assert.strictEqual(session.todoState?.remindEvery, 4);
      assert.strictEqual(session.todoState?.remindOnTurnEnd, false);

      await tool_set_todo({ todo: '- [ ] third item' }, { sessionId, session });
      assert.strictEqual(session.todoState?.remindEvery, 4);
      assert.strictEqual(session.todoState?.remindOnTurnEnd, false);
    });

    await test('turn-end reminder appears once unless final response ends with [NO_ACTION] or todo is cleared', async () => {
      const sessionId = makeSessionId('selftest_todo_endturn');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      await tool_set_todo({ todo: '- [ ] verify end-turn reminder', remindEvery: 99 }, { sessionId, session });

      let callIndex = 0;
      (llm as any).chat = async (parts: Message['parts'] | null, activeSession: Session) => {
        assert.strictEqual(activeSession.id, sessionId);
        await appendStubUserMessage(activeSession, parts);
        callIndex += 1;

        if (callIndex === 1) {
          await appendStubModelMessage(activeSession, 'First normal reply');
          return { text: 'First normal reply' };
        }

        if (callIndex === 2) {
          await appendStubModelMessage(activeSession, 'Second quiet reply [NO_ACTION]');
          return { text: 'Second quiet reply [NO_ACTION]' };
        }

        await appendStubModelMessage(activeSession, 'Third reply after clear');
        return { text: 'Third reply after clear' };
      };

      await (router as any).runSessionTurn(sessionId, {
        parts: [{ text: 'normal turn' }],
        session,
        preclaimed: true,
      });

      let reminderMessages = session.history.filter(message => message.__meta?.todoReminder === true);
      assert.strictEqual(reminderMessages.length, 1);
      assert.strictEqual(reminderMessages[0].__meta?.todoReminderKind, 'end-turn');

      await (router as any).runSessionTurn(sessionId, {
        parts: [{ text: 'quiet turn' }],
        session,
        preclaimed: true,
      });

      reminderMessages = session.history.filter(message => message.__meta?.todoReminder === true);
      assert.strictEqual(reminderMessages.length, 1);

      await tool_set_todo({ clear: true }, { sessionId, session });

      await (router as any).runSessionTurn(sessionId, {
        parts: [{ text: 'after clear' }],
        session,
        preclaimed: true,
      });

      reminderMessages = session.history.filter(message => message.__meta?.todoReminder === true);
      assert.strictEqual(reminderMessages.length, 1);
    });

    await test('turn-end reminder still appears when child reminder queues a background follow-up', async () => {
      const sessionId = makeSessionId('selftest_todo_child_endturn');
      const parentSessionId = makeSessionId('selftest_todo_child_parent');
      createdSessionIds.push(parentSessionId, sessionId);
      await ensureSession(parentSessionId);
      const session = await ensureSession(sessionId, parentSessionId);

      await tool_set_todo({ todo: '- [ ] child end-turn reminder', remindEvery: 99 }, { sessionId, session });

      (llm as any).chat = async (parts: Message['parts'] | null, activeSession: Session) => {
        assert.strictEqual(activeSession.id, sessionId);
        await appendStubUserMessage(activeSession, parts);

        const lastUserSystems = activeSession.history
          .slice()
          .reverse()
          .find(message => message.role === 'user')
          ?.parts.filter(part => typeof part.system === 'string').map(part => part.system || '') || [];

        if (lastUserSystems.some(systemText => systemText.includes('message ended without send_to_session call'))) {
          await appendStubModelMessage(activeSession, '[NO_ACTION]');
          return { text: '[NO_ACTION]' };
        }

        await appendStubModelMessage(activeSession, 'Child finished local work');
        return { text: 'Child finished local work' };
      };

      await (router as any).runSessionTurn(sessionId, {
        parts: [{ text: 'child timer-like turn' }],
        session,
        preclaimed: true,
      });

      const refreshedSession = await sessionManager.getSession(sessionId);
      const reminderMessages = refreshedSession.history.filter(message => message.__meta?.todoReminder === true);
      assert.strictEqual(reminderMessages.length, 1);
      assert.strictEqual(reminderMessages[0].__meta?.todoReminderKind, 'end-turn');
      assert.strictEqual(refreshedSession.queue.length, 0);
    });

    await test('turn-end todo reminder can be disabled via set_todo', async () => {
      const sessionId = makeSessionId('selftest_todo_disable_endturn');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      await tool_set_todo({ todo: '- [ ] disable end turn', remindEvery: 99, remindOnTurnEnd: false }, { sessionId, session });

      (llm as any).chat = async (parts: Message['parts'] | null, activeSession: Session) => {
        assert.strictEqual(activeSession.id, sessionId);
        await appendStubUserMessage(activeSession, parts);
        await appendStubModelMessage(activeSession, 'Normal reply');
        return { text: 'Normal reply' };
      };

      await (router as any).runSessionTurn(sessionId, {
        parts: [{ text: 'normal turn' }],
        session,
        preclaimed: true,
      });

      const reminderMessages = session.history.filter(message => message.__meta?.todoReminder === true);
      assert.strictEqual(reminderMessages.length, 0);
    });

    await test('interval todo reminder independently triggers a queued follow-up turn', async () => {
      const sessionId = makeSessionId('selftest_todo_queue_turn');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      await tool_set_todo({ todo: '- [ ] wake queued reminder turn', remindEvery: 1 }, { sessionId, session });

      let reminderTurns = 0;
      (llm as any).chat = async (parts: Message['parts'] | null, activeSession: Session) => {
        assert.strictEqual(activeSession.id, sessionId);
        await appendStubUserMessage(activeSession, parts);

        const latestUser = activeSession.history.slice().reverse().find(message => message.role === 'user');
        const latestSystem = latestUser?.parts.find(part => typeof part.system === 'string')?.system || '';
        if (latestSystem.includes('TODO reminder for this session')) {
          reminderTurns += 1;
          await appendStubModelMessage(activeSession, 'Reminder processed');
          return { text: 'Reminder processed' };
        }

        await appendStubModelMessage(activeSession, 'Normal reply');
        return { text: 'Normal reply' };
      };

      await append(session, {
        role: 'model',
        parts: [{ text: 'Progress update' }],
      });

      assert.strictEqual(session.queue.length, 1);
      assert.strictEqual(countTodoReminders(session), 0);

      await router.processSessionQueue(sessionId);

      const refreshedSession = await sessionManager.getSession(sessionId);
      assert.strictEqual(reminderTurns, 1);
      assert.strictEqual(refreshedSession.queue.length, 0);
      assert.strictEqual(countTodoReminders(refreshedSession), 1);
      const latestModel = refreshedSession.history.slice().reverse().find(message => message.role === 'model');
      assert.match(latestModel?.parts.find(part => typeof part.text === 'string')?.text || '', /Reminder processed/);
    });

    console.log('todo reminder selftest passed');
  } finally {
    (llm as any).chat = originalChat;
    (vector as any).scheduleSessionArchiveIndex = originalArchiveIndex;
    await cleanupSessions(createdSessionIds);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
