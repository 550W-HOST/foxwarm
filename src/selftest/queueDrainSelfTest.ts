import assert from 'assert';
import { MessageRouter } from '../messageRouter';
import * as sessionManager from '../sessionManager';
import * as llm from '../llm';
import * as vector from '../vector';
import { formatCompactionCompletionMarker } from '../session/history';
import { Message, MessagePart, Session } from '../types';

function makeSessionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function createBaseSession(id: string): Session {
  return {
    id,
    agent: 'main',
    history: [],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  };
}

async function ensureSession(id: string): Promise<Session> {
  const existing = await sessionManager.getSession(id);
  Object.assign(existing, createBaseSession(id));
  await sessionManager.saveSession(id);
  return existing;
}

async function cleanupSessions(sessionIds: string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    try {
      await sessionManager.deleteSession(sessionId);
    } catch {
      // ignore cleanup failure in selftest
    }
  }
}

async function appendStubUserMessage(session: Session, parts: MessagePart[] | null): Promise<void> {
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

function assertLastModelText(session: Session, expected: string): void {
  const last = session.history[session.history.length - 1];
  assert(last, 'expected session history to be non-empty');
  assert.strictEqual(last.role, 'model');
  assert.strictEqual(last.parts.find(part => typeof part.text === 'string')?.text, expected);
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
  sessionManager.setSessionTriggerCallback(() => {});

  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  const originalApplyCompletedCompactJob = sessionManager.applyCompletedCompactJob;
  const originalArchiveIndex = (vector as any).scheduleSessionArchiveIndex;
  (vector as any).scheduleSessionArchiveIndex = async () => 0;

  const router = new MessageRouter();
  const createdSessionIds: string[] = [];

  try {
    await test('queued parts and message events are consumed in order during the same tool loop', async () => {
      const sessionId = makeSessionId('selftest_queue_mid_tool');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      let callIndex = 0;
      try {
        (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
          assert.strictEqual(activeSession.id, sessionId);
          await appendStubUserMessage(activeSession, parts);
          callIndex += 1;

          if (callIndex === 1) {
            const toolCall = { id: 'queue-mid-tool', name: 'read', args: { filePath: __filename } };
            await sessionManager.appendSessionMessage(activeSession, {
              role: 'model',
              parts: [{ functionCall: toolCall }],
            });
            return { text: '', toolCalls: [toolCall] };
          }

          if (callIndex === 2) {
            const userTexts = activeSession.history
              .filter(message => message.role === 'user')
              .map(message => message.parts.map(part => part.system || part.text || '').join('\n'));
            const firstUserText = userTexts[0] || '';
            assert.match(firstUserText, /<foxwarm-system\b[^\n]*kind="session"[^\n]*currentSessionId=/);
            assert.ok(firstUserText.endsWith('\nstart queue drain'));
            assert.deepStrictEqual(userTexts.slice(1).map(text => {
              const match = text.match(/^<foxwarm-message\b[^>]*>\n([\s\S]*)\n<\/foxwarm-message>$/);
              return match?.[1] || text;
            }), [
              'queued part before message',
              'queued message in the middle',
              'queued part after message',
            ]);

            await appendStubModelMessage(activeSession, 'queue drained inline');
            return { text: 'queue drained inline' };
          }

          throw new Error(`expected two LLM calls, got ${callIndex}`);
        };

        (llm as any).executeTools = async (_toolCalls: any, toolContext: { sessionId: string }) => {
          assert.strictEqual(toolContext.sessionId, sessionId);
          await sessionManager.queueSessionStructuredEvent(sessionId, [{ text: 'queued part before message' }], 'background');
          await sessionManager.queueSessionMessageEvent(sessionId, {
            role: 'user',
            parts: [{ text: 'queued message in the middle' }],
          }, 'background');
          await sessionManager.queueSessionStructuredEvent(sessionId, [{ text: 'queued part after message' }], 'background');

          return {
            role: 'tool',
            parts: [{ functionResponse: { tool_use_id: 'queue-mid-tool', name: 'read', response: { output: 'queued' } } }],
          } as Message;
        };

        await (router as any).turnRunner.runSessionTurn(sessionId, {
          parts: [{ text: 'start queue drain' }],
          session,
          preclaimed: true,
        });
      } finally {
        (llm as any).executeTools = originalExecuteTools;
      }

      const refreshedSession = await sessionManager.getSession(sessionId);
      assert.strictEqual(callIndex, 2);
      assert.strictEqual(refreshedSession.queue.length, 0);
      assert.strictEqual(refreshedSession.busy, false);
      assertLastModelText(refreshedSession, 'queue drained inline');
    });

    await test('a single processSessionQueue call drains all currently consumable queued work', async () => {
      const sessionId = makeSessionId('selftest_queue_drain_idle');
      createdSessionIds.push(sessionId);
      await ensureSession(sessionId);

      await sessionManager.queueSessionStructuredEvent(sessionId, [{ text: 'queued part one' }], 'background');
      await sessionManager.queueSessionMessageEvent(sessionId, {
        role: 'user',
        parts: [{ text: 'queued message two' }],
      }, 'background');
      await sessionManager.queueSessionStructuredEvent(sessionId, [{ text: 'queued part three' }], 'background');

      let callIndex = 0;
      (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
        assert.strictEqual(activeSession.id, sessionId);
        await appendStubUserMessage(activeSession, parts);
        callIndex += 1;
        assert.strictEqual(callIndex, 1);

        const userTexts = activeSession.history
          .filter(message => message.role === 'user')
          .map(message => message.parts.map(part => part.system || part.text || '').join('\n'));
        const firstUserText = userTexts[0] || '';
        assert.match(firstUserText, /<foxwarm-system\b[^\n]*kind="session"[^\n]*currentSessionId=/);
        assert.match(firstUserText, /\nqueued part one\n<\/foxwarm-message>$/);
        assert.deepStrictEqual(userTexts.slice(1).map(text => {
          const match = text.match(/^<foxwarm-message\b[^>]*>\n([\s\S]*)\n<\/foxwarm-message>$/);
          return match?.[1] || text;
        }), [
          'queued message two',
          'queued part three',
        ]);

        await appendStubModelMessage(activeSession, 'all queued work handled');
        return { text: 'all queued work handled' };
      };

      await router.processSessionQueue(sessionId);

      const refreshedSession = await sessionManager.getSession(sessionId);
      assert.strictEqual(callIndex, 1);
      assert.strictEqual(refreshedSession.queue.length, 0);
      assert.strictEqual(refreshedSession.busy, false);
      assertLastModelText(refreshedSession, 'all queued work handled');
    });

    await test('queued compact commit preempts already-held input and the same turn then continues with remaining ordinary work', async () => {
      const sessionId = makeSessionId('selftest_queue_compact_boundary');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      let compactRequestCount = 0;
      (sessionManager as any).applyCompletedCompactJob = async (targetSessionId: string) => {
        assert.strictEqual(targetSessionId, sessionId);
        compactRequestCount += 1;
        await sessionManager.appendSessionMessage(targetSessionId, {
          role: 'user',
          parts: [{ system: formatCompactionCompletionMarker(targetSessionId, 'Compaction completed.') }],
        });
        return true;
      };

      session.queue.push({ type: 'compact-commit' });
      session.queue.push({ type: 'background', parts: [{ text: 'after compact' }] });
      await sessionManager.saveSession(sessionId);

      let callIndex = 0;
      (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
        assert.strictEqual(activeSession.id, sessionId);
        assert.strictEqual(parts, null);
        await appendStubUserMessage(activeSession, parts);
        callIndex += 1;

        assert.strictEqual(callIndex, 1);
        const userTexts = activeSession.history
          .filter(message => message.role === 'user')
          .map(message => message.parts.map(part => part.system || part.text || '').join('\n'));
        assert(userTexts.some(text => text.includes('before compact')));
        assert(userTexts.some(text => text === 'after compact'));
        assert(userTexts.some(text => text === `<foxwarm-system kind="session-boundary" event="compact-completed" parentSessionId="(none)" currentSessionId="${sessionId}" />`));
        await appendStubModelMessage(activeSession, 'handled after compact boundary');
        return { text: 'handled after compact boundary' };
      };

      await (router as any).turnRunner.runSessionTurn(sessionId, {
        parts: [{ text: 'before compact' }],
        session,
        preclaimed: true,
      });

      const refreshedSession = await sessionManager.getSession(sessionId);
      assert(compactRequestCount >= 1);
      assert.strictEqual(callIndex, 1);
      assert.strictEqual(refreshedSession.queue.length, 0);
      assert.strictEqual(refreshedSession.busy, false);
      assertLastModelText(refreshedSession, 'handled after compact boundary');
    });

    console.log('queue drain selftest passed');
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
    (sessionManager as any).applyCompletedCompactJob = originalApplyCompletedCompactJob;
    (vector as any).scheduleSessionArchiveIndex = originalArchiveIndex;
    await cleanupSessions(createdSessionIds);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
