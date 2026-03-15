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
import { tool_get_archived_messages } from '../toolsSessionAgent';

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
  const originalCompactHistory = (sessionManager as any).compactHistory;
  const originalCompactHistoryWithSummary = (sessionManager as any).compactHistoryWithSummary;
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

    await test('send_to_session with noFurtherAssistantReply stops the current turn without an extra LLM round', async () => {
      const parentId = makeSessionId('selftest_parent_endturn');
      const childId = makeSessionId('selftest_child_endturn');
      createdSessionIds.push(parentId, childId);
      await ensureSession(parentId);
      await ensureSession(childId, parentId);

      let childCallCount = 0;
      let parentCallCount = 0;
      (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
        await appendStubUserMessage(activeSession, parts);

        if (activeSession.id === childId) {
          childCallCount += 1;
          if (childCallCount === 1) {
            const toolCall = {
              id: 'child-report-endturn',
              name: 'send_to_session',
              args: { sessionId: parentId, message: 'child-endturn-ok', noFurtherAssistantReply: true },
            };
            await appendStubModelMessage(activeSession, [{ functionCall: toolCall }]);
            return { text: '', toolCalls: [toolCall] };
          }

          throw new Error(`child session should not receive a second LLM call, got ${childCallCount}`);
        }

        if (activeSession.id === parentId) {
          parentCallCount += 1;
          await appendStubModelMessage(activeSession, [{ text: 'parent received end-turn handoff' }]);
          return { text: 'parent received end-turn handoff' };
        }

        throw new Error(`unexpected session in end-turn selftest: ${activeSession.id}`);
      };

      await (router as any).runSessionTurn(childId, {
        parts: [{ text: 'child task with immediate handoff' }],
      });

      const childAfter = await sessionManager.getSession(childId);
      const parentAfterChildRun = await sessionManager.getSession(parentId);
      assert.strictEqual(childCallCount, 1);
      assert.strictEqual(childAfter.busy, false);
      assert.strictEqual(parentAfterChildRun.queue.length, 1);
      assert.strictEqual(childAfter.history[childAfter.history.length - 1]?.role, 'tool');
      assert(childAfter.history.some(msg => msg.role === 'model' && msg.parts.some(part => part.functionCall?.name === 'send_to_session')));

      await router.processSessionQueue(parentId);

      const parentAfter = await sessionManager.getSession(parentId);
      assert.strictEqual(parentCallCount, 1);
      assert.strictEqual(parentAfter.queue.length, 0);
      assert(parentAfter.history.some(msg => msg.role === 'user' && msg.parts.some(part => (part.text || '').includes('child-endturn-ok'))));
      assertLastModelText(parentAfter, 'parent received end-turn handoff');
    });

    await test('compact_session retries invalid compact plans and then resumes with compacted history', async () => {
      const sessionId = makeSessionId('selftest_compact_current');
      createdSessionIds.push(sessionId);
      await ensureSession(sessionId);

      let llmCallCount = 0;

      (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
        await appendStubUserMessage(activeSession, parts);
        llmCallCount += 1;

        if (llmCallCount === 1) {
          const toolCall = {
            id: 'compact-now',
            name: 'compact_session',
            args: { keepPercent: 0.25 },
          };
          await appendStubModelMessage(activeSession, [{ functionCall: toolCall }]);
          return { text: '', toolCalls: [toolCall] };
        }

        if (llmCallCount === 2) {
          const systemText = parts?.find(part => typeof part.system === 'string')?.system || '';
          assert.match(systemText, /COMPACTION STARTED/);
          const blockIds = Array.from(systemText.matchAll(/- (block_[^\n]+)/g)).map(match => match[1]);
          assert(blockIds.length > 0, 'expected compaction prompt to include at least one block id');
          const toolCall = {
            id: 'compact-plan-invalid',
            name: 'submit_compact_plan',
            args: {
              summary: '',
              keepBlockIds: [] as string[],
              dropBlockIds: [] as string[],
            },
          };
          await appendStubModelMessage(activeSession, [{ functionCall: toolCall }]);
          return { text: '', toolCalls: [toolCall] };
        }

        if (llmCallCount === 3) {
          const systemText = parts?.find(part => typeof part.system === 'string')?.system || '';
          assert.match(systemText, /COMPACT PLAN INVALID/);
          assert.match(systemText, /summary: must be a non-empty string/);
          const originalPrompt = activeSession.history
            .find(msg => msg.role === 'user' && msg.parts.some(part => typeof part.system === 'string' && part.system.includes('COMPACTION STARTED')))
            ?.parts.find(part => typeof part.system === 'string')?.system || '';
          const blockIds = Array.from(originalPrompt.matchAll(/- (block_[^\n]+)/g)).map(match => match[1]);
          assert(blockIds.length > 0, 'expected original compaction prompt to remain available in history');
          const toolCall = {
            id: 'compact-plan',
            name: 'submit_compact_plan',
            args: {
              summary: 'compacted summary',
              keepBlockIds: [] as string[],
              dropBlockIds: blockIds,
            },
          };
          await appendStubModelMessage(activeSession, [{ functionCall: toolCall }]);
          return { text: '', toolCalls: [toolCall] };
        }

        if (llmCallCount === 4) {
          assert.strictEqual(parts, null);
          assert(activeSession.history.some(msg => msg.role === 'user' && msg.parts.some(part => (part.system || '').includes('This session has been compacted'))));
          assert(activeSession.history.some(msg => msg.role === 'model' && msg.parts.some(part => (part.text || '').includes('compacted summary'))));
          await appendStubModelMessage(activeSession, [{ text: 'continued after compact' }]);
          return { text: 'continued after compact' };
        }

        throw new Error(`compact_session self-request should resume after the dedicated compaction flow, got LLM call ${llmCallCount}`);
      };

      await (router as any).runSessionTurn(sessionId, {
        parts: [{ text: 'compact this session now' }],
      });

      const finalSession = await sessionManager.getSession(sessionId);
      assert.strictEqual(llmCallCount, 4);
      assert.strictEqual(finalSession.busy, false);
      assert(finalSession.history.some(msg => msg.role === 'user' && msg.parts.some(part => (part.system || '').includes('This session has been compacted'))));
      assert(finalSession.history.some(msg => msg.role === 'user' && msg.parts.some(part => (part.system || '').includes('Compacted message placeholder:') && (part.system || '').includes('get_archived_messages') && (part.system || '').includes('#1-#3'))));
      assert(finalSession.history.some(msg => msg.role === 'model' && msg.parts.some(part => (part.text || '').includes('compacted summary'))));
      assert(finalSession.history.some(msg => msg.role === 'user' && msg.parts.some(part => (part.system || '').includes('Compaction completed'))));
      assertLastModelText(finalSession, 'continued after compact');
    });

    await test('get_archived_messages reads archived session history by seq range', async () => {
      const sessionId = makeSessionId('selftest_archive_lookup');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);

      await sessionManager.appendSessionMessage(session, {
        role: 'user',
        parts: [{ text: 'archived alpha' }],
      });
      await sessionManager.appendSessionMessage(session, {
        role: 'model',
        parts: [{ text: 'archived beta' }],
      });
      await sessionManager.appendSessionMessage(session, {
        role: 'tool',
        parts: [{ functionResponse: { tool_use_id: 'archived-read', name: 'read', response: { output: 'archived gamma' } } }],
      });

      const output = await tool_get_archived_messages({
        sessionId,
        startSeq: 2,
        endSeq: 3,
        previewLength: 200,
      }, { sessionId, session });

      assert.match(String(output), /Archived messages for session/);
      assert.match(String(output), /\[#2\]/);
      assert.match(String(output), /archived beta/);
      assert.match(String(output), /\[#3\]/);
      assert.match(String(output), /archived gamma/);
      assert.doesNotMatch(String(output), /archived alpha/);
    });

    await test('automatic in-turn compaction after tool calls resumes with compacted history', async () => {
      const sessionId = makeSessionId('selftest_auto_compact_current');
      createdSessionIds.push(sessionId);
      await ensureSession(sessionId);

      const sampleFile = path.join(tempRoot, 'auto-compact-read.txt');
      await fs.writeFile(sampleFile, 'auto compact\n');

      let llmCallCount = 0;
      (sessionManager as any).compactHistory = async (targetSessionId: string) => {
        assert.strictEqual(targetSessionId, sessionId);
        const targetSession = await sessionManager.getSession(targetSessionId);
        targetSession.history = [
          {
            role: 'user',
            parts: [{ system: 'This session has been compacted. Messages before this are removed.' }],
            __meta: { timestamp: Date.now() }
          },
          {
            role: 'model',
            parts: [{ text: 'auto compact summary' }],
            __meta: { timestamp: Date.now() }
          },
          {
            role: 'user',
            parts: [{ system: 'Compaction completed. You can continue working now.' }],
            __meta: { timestamp: Date.now() }
          },
        ];
        await sessionManager.saveSession(targetSessionId);
      };

      (llm as any).chat = async (parts: MessagePart[] | null, activeSession: Session) => {
        assert.strictEqual(activeSession.id, sessionId);
        await appendStubUserMessage(activeSession, parts);
        llmCallCount += 1;

        if (llmCallCount === 1) {
          const toolCall = { id: 'auto-compact-read', name: 'read', args: { filePath: sampleFile } };
          await appendStubModelMessage(activeSession, [{ functionCall: toolCall }]);
          return {
            text: '',
            toolCalls: [toolCall],
            usage: { inputTokens: 10 ** 9, outputTokens: 0, cachedTokens: 0 },
          };
        }

        if (llmCallCount === 2) {
          assert.strictEqual(parts, null);
          assert(activeSession.history.some(msg => msg.role === 'user' && msg.parts.some(part => (part.system || '').includes('This session has been compacted'))));
          assert(activeSession.history.some(msg => msg.role === 'model' && msg.parts.some(part => (part.text || '').includes('auto compact summary'))));
          await appendStubModelMessage(activeSession, [{ text: 'continued after auto compact' }]);
          return { text: 'continued after auto compact' };
        }

        throw new Error(`automatic in-turn compaction should resume exactly once after compaction, got LLM call ${llmCallCount}`);
      };

      try {
        await (router as any).runSessionTurn(sessionId, {
          parts: [{ text: 'trigger auto compact now' }],
        });
      } finally {
        (sessionManager as any).compactHistory = originalCompactHistory;
      }

      const finalSession = await sessionManager.getSession(sessionId);
      assert.strictEqual(llmCallCount, 2);
      assert.strictEqual(finalSession.busy, false);
      assert(finalSession.history.some(msg => msg.role === 'model' && msg.parts.some(part => (part.text || '').includes('auto compact summary'))));
      assertLastModelText(finalSession, 'continued after auto compact');
    });

    await test('tool-noise compaction replaces oversized archived tool parts in older history only', async () => {
      const sessionId = makeSessionId('selftest_tool_noise_compact');
      createdSessionIds.push(sessionId);
      const session = await ensureSession(sessionId);
      const longArgs = { payload: 'x'.repeat(4000) };
      const longResponse = { output: 'y'.repeat(4000) };

      await sessionManager.appendSessionMessage(session, {
        role: 'user',
        parts: [{ text: 'tool noise test' }],
      });
      await sessionManager.appendSessionMessage(session, {
        role: 'model',
        parts: [{ functionCall: { id: 'tool-noise-call', name: 'exec', args: longArgs } }],
      });
      await sessionManager.appendSessionMessage(session, {
        role: 'tool',
        parts: [{ functionResponse: { tool_use_id: 'tool-noise-call', name: 'exec', response: longResponse } }],
      });
      await sessionManager.appendSessionMessage(session, {
        role: 'model',
        parts: [{ text: 'recent tail should stay untouched' }],
      });

      const result = await sessionManager.compactSessionToolMessages(sessionId, 0.25);
      assert.strictEqual(result.replacedFunctionCalls, 1);
      assert.strictEqual(result.replacedFunctionResponses, 1);

      const updated = await sessionManager.getSession(sessionId);
      const compactedCallPart = updated.history[1].parts[0];
      const compactedResponsePart = updated.history[2].parts[0];
      assert(compactedCallPart.functionCall, 'expected compacted function call part to preserve functionCall structure');
      assert(compactedResponsePart.functionResponse, 'expected compacted function response part to preserve functionResponse structure');
      assert.strictEqual(compactedCallPart.functionCall?.name, 'exec');
      assert.strictEqual(compactedResponsePart.functionResponse?.name, 'exec');
      assert.strictEqual(compactedCallPart.functionCall?.args?.__compacted, true);
      assert.match(String(compactedCallPart.functionCall?.args?.placeholder || ''), /compacted tool call/);
      assert.match(String(compactedCallPart.functionCall?.args?.placeholder || ''), /get_archived_messages/);
      assert.strictEqual(compactedResponsePart.functionResponse?.response?.__compacted, true);
      assert.match(String(compactedResponsePart.functionResponse?.response?.output || ''), /compacted tool response/);
      assert.match(String(compactedResponsePart.functionResponse?.response?.output || ''), /get_archived_messages/);
      assert.match(updated.history[3].parts[0].text || '', /recent tail should stay untouched/);
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
    (sessionManager as any).compactHistory = originalCompactHistory;
    (sessionManager as any).compactHistoryWithSummary = originalCompactHistoryWithSummary;
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
