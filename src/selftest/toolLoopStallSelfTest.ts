import assert from 'assert';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import axios from 'axios';
import { MessageRouter } from '../messageRouter';
import * as sessionManager from '../sessionManager';
import * as llm from '../llm';
import * as vector from '../vector';
import { MessagePart, Session } from '../types';

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
      // ignore cleanup failure in selftest
    }
  }
}

async function appendStubUserMessage(session: Session, parts: MessagePart[] | null): Promise<void> {
  if (!parts || parts.length === 0) {
    return;
  }

  await sessionManager.appendSessionMessage(session, {
    role: 'user',
    parts,
  });
}

async function appendStubModelMessage(session: Session, parts: MessagePart[]): Promise<void> {
  await sessionManager.appendSessionMessage(session, {
    role: 'model',
    parts,
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

  const originalChat = llm.chat;
  const originalAxiosPost = axios.post;
  const originalArchiveIndex = (vector as any).scheduleSessionArchiveIndex;
  (vector as any).scheduleSessionArchiveIndex = async () => 0;

  const router = new MessageRouter();
  const createdSessionIds: string[] = [];
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-tool-loop-selftest-'));

  try {
    await test('session continues across apply_patch -> read -> exec -> final response', async () => {
      const sessionId = makeSessionId('selftest_tool_chain');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);
      const sampleFile = path.join(tempRoot, 'tool-chain.txt');
      await fs.writeFile(sampleFile, 'alpha\nomega\n');

      let callIndex = 0;
      (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
        assert.strictEqual(activeSession.id, sessionId);
        await appendStubUserMessage(activeSession, parts);
        callIndex += 1;

        if (callIndex === 1) {
          const toolCall = { id: 'apply-1', name: 'apply_patch', args: {
            input: [
              '*** Begin Patch',
              `*** Update File: ${sampleFile}`,
              '@@',
              '-alpha',
              '+beta',
              ' omega',
              '*** End Patch',
            ].join('\n'),
          } };
          await appendStubModelMessage(activeSession, [{ functionCall: toolCall }]);
          return { text: '', toolCalls: [toolCall] };
        }

        if (callIndex === 2) {
          const toolCall = { id: 'read-1', name: 'read', args: { filePath: sampleFile } };
          await appendStubModelMessage(activeSession, [{ functionCall: toolCall }]);
          return { text: '', toolCalls: [toolCall] };
        }

        if (callIndex === 3) {
          const toolCall = {
            id: 'exec-1',
            name: 'exec',
            args: {
              command: `python3 - <<'PY'\nfrom pathlib import Path\nprint(Path(${JSON.stringify(sampleFile)}).read_text().strip())\nPY`,
            },
          };
          await appendStubModelMessage(activeSession, [{ functionCall: toolCall }]);
          return { text: '', toolCalls: [toolCall] };
        }

        await appendStubModelMessage(activeSession, [{ text: 'SELFTEST_DONE' }]);
        return { text: 'SELFTEST_DONE' };
      };

      await (router as any).runSessionTurn(sessionId, {
        parts: [{ text: 'run tool chain selftest' }],
      });

      const finalSession = await sessionManager.getSession(sessionId);
      assert.strictEqual(finalSession.busy, false);
      assert.strictEqual(finalSession.queue.length, 0);
      assert.strictEqual(await fs.readFile(sampleFile, 'utf8'), 'beta\nomega\n');
      assert(finalSession.history.some(msg => msg.role === 'tool' && msg.parts.some(part => part.functionResponse?.name === 'apply_patch')));
      assert(finalSession.history.some(msg => msg.role === 'tool' && msg.parts.some(part => part.functionResponse?.name === 'read')));
      assert(finalSession.history.some(msg => msg.role === 'tool' && msg.parts.some(part => part.functionResponse?.name === 'exec')));
      assertLastModelText(finalSession, 'SELFTEST_DONE');
    });

    await test('child session continues after a tool response and can still notify parent', async () => {
      const parentId = makeSessionId('selftest_parent');
      const childId = makeSessionId('selftest_child');
      createdSessionIds.push(parentId, childId);
      const parent = await ensureSession(parentId);
      const child = await ensureSession(childId, parentId);
      const sampleFile = path.join(tempRoot, 'child-read.txt');
      await fs.writeFile(sampleFile, 'child-data\n');

      const callCount = new Map<string, number>();
      (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
        await appendStubUserMessage(activeSession, parts);
        const nextCall = (callCount.get(activeSession.id) || 0) + 1;
        callCount.set(activeSession.id, nextCall);

        if (activeSession.id === childId && nextCall === 1) {
          const toolCall = { id: 'child-read', name: 'read', args: { filePath: sampleFile } };
          await appendStubModelMessage(activeSession, [{ functionCall: toolCall }]);
          return { text: '', toolCalls: [toolCall] };
        }

        if (activeSession.id === childId && nextCall === 2) {
          const toolCall = { id: 'child-report', name: 'send_to_session', args: { sessionId: parentId, message: 'child-ok' } };
          await appendStubModelMessage(activeSession, [{ functionCall: toolCall }]);
          return { text: '', toolCalls: [toolCall] };
        }

        if (activeSession.id === childId && nextCall === 3) {
          await appendStubModelMessage(activeSession, [{ text: 'child done' }]);
          return { text: 'child done' };
        }

        if (activeSession.id === parentId) {
          await appendStubModelMessage(activeSession, [{ text: 'parent observed child message' }]);
          return { text: 'parent observed child message' };
        }

        throw new Error(`unexpected session/call combination: ${activeSession.id}#${nextCall}`);
      };

      await (router as any).runSessionTurn(childId, {
        parts: [{ text: 'child task' }],
      });

      const childAfter = await sessionManager.getSession(childId);
      const parentAfterChildRun = await sessionManager.getSession(parentId);
      assert.strictEqual(childAfter.busy, false);
      assert.strictEqual(parentAfterChildRun.queue.length, 1);
      assertLastModelText(childAfter, 'child done');

      await router.processSessionQueue(parentId);

      const parentAfter = await sessionManager.getSession(parentId);
      assert.strictEqual(parentAfter.busy, false);
      assert(parentAfter.history.some(msg => msg.role === 'user' && msg.parts.some(part => (part.text || '').includes('child-ok'))));
      assertLastModelText(parentAfter, 'parent observed child message');
      assert.strictEqual(parentAfter.queue.length, 0);

      // keep variables referenced to silence accidental lint/TS elision assumptions
      assert(parent && child);
    });

    await test('post-tool LLM failure leaves a visible terminal model message without auto-notifying parent', async () => {
      const parentId = makeSessionId('selftest_error_parent');
      const childId = makeSessionId('selftest_error_child');
      createdSessionIds.push(parentId, childId);
      await ensureSession(parentId);
      await ensureSession(childId, parentId);
      const sampleFile = path.join(tempRoot, 'failure-read.txt');
      await fs.writeFile(sampleFile, 'failure-case\n');

      let childCallCount = 0;
      let parentCallCount = 0;
      (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session, iteration = 0) => {
        if (activeSession.id === childId) {
          childCallCount += 1;
          if (childCallCount === 1) {
            await appendStubUserMessage(activeSession, parts);
            const toolCall = { id: 'failure-read', name: 'read', args: { filePath: sampleFile } };
            await appendStubModelMessage(activeSession, [{ functionCall: toolCall }]);
            return { text: '', toolCalls: [toolCall] };
          }

          return originalChat(parts, activeSession, iteration);
        }

        if (activeSession.id === parentId) {
          parentCallCount += 1;
          await appendStubUserMessage(activeSession, parts);
          await appendStubModelMessage(activeSession, [{ text: 'parent received child failure' }]);
          return { text: 'parent received child failure' };
        }

        throw new Error(`unexpected session during failure selftest: ${activeSession.id}`);
      };

      (axios as any).post = async () => {
        throw new Error('simulated network failure');
      };

      const originalSetTimeout = global.setTimeout;
      (global as any).setTimeout = ((fn: (...args: any[]) => void, _ms?: number, ...args: any[]) => originalSetTimeout(fn, 0, ...args)) as typeof setTimeout;
      try {
        await (router as any).runSessionTurn(childId, {
          parts: [{ text: 'child should surface failure' }],
        });
      } finally {
        (global as any).setTimeout = originalSetTimeout;
      }

      const childAfter = await sessionManager.getSession(childId);
      const lastChild = childAfter.history[childAfter.history.length - 1];
      const lastChildText = lastChild.parts.find(part => typeof part.text === 'string')?.text || '';
      assert.strictEqual(lastChild.role, 'model');
      assert(lastChildText.startsWith('Error: API request failed after 3 attempts'));
      const parentAfter = await sessionManager.getSession(parentId);
      assert.strictEqual(parentAfter.queue.length, 0);
      assert(!parentAfter.history.some(msg => msg.parts.some(part => (part.text || '').includes(`Child session \`${childId}\` failed before reporting back.`))));
      assert.strictEqual(parentCallCount, 0);
    });
  } finally {
    (llm as any).chat = originalChat;
    (axios as any).post = originalAxiosPost;
    (vector as any).scheduleSessionArchiveIndex = originalArchiveIndex;
    await cleanupSessions(createdSessionIds);
    await fs.remove(tempRoot);
  }

  console.log('tool loop stall selftest passed');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
