import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { ProcessRpcClientTransport, ProcessRpcServer, RpcClient, RpcServiceRegistry } from './rpc';
import { createMainManagementToolServiceHandler, mainManagementToolServiceDescriptor } from './mainManagementToolService';
import { createMcpExternalServiceHandler, mcpExternalServiceDescriptor } from './mcpExternalService';
import { createNodeExecutionServiceHandler, nodeExecutionServiceDescriptor } from './nodeExecutionService';
import { createFileDeliveryServiceHandler, fileDeliveryServiceDescriptor } from './fileDeliveryService';
import * as mcpClient from './mcpClient';
import { nodesManager } from './nodes/manager';
import { serializeSessionHistoryPayload } from './session/metadataStore';
import { readSessionWorkerProcessIdentity } from './sessionWorkerProcessIdentity';
import { sessionWorkerControlServiceDescriptor } from './sessionWorkerControlService';
import { SessionWorkerHost } from './sessionWorkerHost';
import { sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { SessionWorkerStore } from './sessionWorkerStore';
import type { Session } from './types';
import * as llm from './llm';
import * as sessionManager from './sessionManager';
import { getAgentDir, SESSIONS_FILE, TIMERS_FILE } from './config';
import * as timers from './timers';
import * as vector from './vector';
import * as sessionHistory from './session/history';
import { createVectorFacadeProxyHandler } from './vectorFacadeProxy';
import { vectorServiceDescriptor } from './vectorServiceDescriptor';
import { createSessionWorkerPublicationServiceHandler, sessionWorkerPublicationServiceDescriptor, SessionWorkerProjectionRegistry } from './sessionWorkerPublicationService';
import { createSessionTurnDeliveryServiceHandler, sessionTurnDeliveryServiceDescriptor } from './sessionTurnDelivery';

function baseSession(id: string): Session {
  return {
    id,
    agent: 'main',
    history: [],
    contextFrontier: [],
    persistentMemorySnapshot: 'worker prompt',
    systemPromptFiles: [],
    snapshotUpdatedAt: Date.now(),
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: 0 },
    lastAppliedMailboxId: 0,
  } as Session;
}

function assertRpcCode(code: string) {
  return (error: any) => error?.code === code;
}

async function withLocalHost(
  initial: Session,
  testBody: (fixture: { host: SessionWorkerHost; store: SessionWorkerStore; session: Session; turnHost: any; readDurable: () => Record<string, any> }) => Promise<void>,
  keepRunner = false,
  publishCommitted?: (projection: any) => Promise<void>,
  deliverCommittedFinal?: (source: any, text: string, outcome: any) => Promise<void>,
  deliverIntermediateText?: (source: any, text: string) => Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-local-worker-host-'));
  const store = new SessionWorkerStore(path.join(root, 'runtime.sqlite')); store.open();
  const incarnationId = 'local-host-incarnation';
  const ownership = store.beginGeneration(initial.id, incarnationId);
  store.registerCandidate(initial.id, ownership.generation, incarnationId, process.pid, 'local-test-process');
  store.activateCandidate(initial.id, ownership.generation, incarnationId, process.pid, 'local-test-process');
  let durable = structuredClone(serializeSessionHistoryPayload(initial));
  const host = new SessionWorkerHost({
    sessionId: initial.id, generation: ownership.generation, incarnationId,
    pid: process.pid, processIdentity: 'local-test-process',
  }, store, {
    initialize: async () => {},
    persistence: {
      readState: async () => structuredClone(durable),
      writeState: async session => { durable = structuredClone(serializeSessionHistoryPayload(session)); },
    },
    publishCommitted,
    deliverIntermediateText,
    deliverCommittedFinal,
  });
  try {
    await (host as any).ensureLoaded();
    const turnHost = (host as any).runner.host;
    if (!keepRunner) (host as any).runner = { processSessionQueue: async () => {} };
    await testBody({ host, store, session: (host as any).session, turnHost, readDurable: () => structuredClone(durable) });
  } finally { store.close(); await fs.remove(root); }
}

function injectWorkerReleasePersistenceFailure(host: SessionWorkerHost, turnHost: any, message: string): () => number {
  const realUpdateBusy = turnHost.updateSessionBusyState.bind(turnHost);
  let releaseAttempts = 0;
  turnHost.updateSessionBusyState = async (session: Session, busy: boolean) => {
    if (busy) return realUpdateBusy(session, true);
    releaseAttempts += 1;
    const realPersistOwner = (host as any).persistOwner;
    (host as any).persistOwner = async () => { throw new Error(message); };
    try {
      return await realUpdateBusy(session, false);
    } finally {
      (host as any).persistOwner = realPersistOwner;
    }
  };
  return () => releaseAttempts;
}

test('worker swallows one ambiguous final-delivery failure after committed response and error finals', async () => {
  const initial = baseSession('worker-final-ambiguity'); let deliveryCalls = 0; let chatCalls = 0; const outcomes: string[] = [];
  let latestProjection: any; const deliveryRecords: any[] = [];
  const originalChat = llm.chat;
  (llm as any).chat = async (parts: any, _session: any, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    chatCalls += 1;
    if (chatCalls === 2) throw new Error('committed final error');
    if (chatCalls === 3) {
      await options.appendMessage({ role: 'model', parts: [{ text: '' }] });
      return { text: '' };
    }
    if (chatCalls === 4) throw new llm.LlmRequestError('provider terminal');
    await options.appendMessage({ role: 'model', parts: [{ text: 'committed before ambiguous delivery' }] });
    return { text: 'committed before ambiguous delivery' };
  };
  try {
    await withLocalHost(initial, async ({ host, store, readDurable }) => {
      store.enqueueIntent(initial.id, 'final', 'enqueue', {
        type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'run' }],
      });
      await host.runPending(8);
      assert.equal(deliveryCalls, 1);
      assert.equal(readDurable().history.at(-1).parts[0].text, 'committed before ambiguous delivery');
      assert.equal(readDurable().busy, false);
      store.enqueueIntent(initial.id, 'error-final', 'enqueue', {
        type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'fail' }],
      });
      await host.runPending(8);
      assert.equal(deliveryCalls, 2);
      assert.equal(readDurable().history.at(-1).parts[0].text, 'Error: committed final error');
      assert.equal(deliveryRecords[1].text, 'Error: committed final error');
      assert.equal(deliveryRecords[1].messageCount, readDurable().history.length);
      assert.equal(readDurable().busy, false);
      store.enqueueIntent(initial.id, 'empty-final', 'enqueue', {
        type: 'user', source: { platform: 'wework', channelUserId: 'room', weworkStreamId: 'stream' }, parts: [{ text: 'empty' }],
      });
      await host.runPending(8);
      assert.equal(deliveryCalls, 3);
      assert.deepEqual(outcomes, ['response', 'error', 'empty-final']);
      const historyBeforeLlmFailure = readDurable().history.length;
      store.enqueueIntent(initial.id, 'llm-error-final', 'enqueue', {
        type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'llm fail' }],
      });
      await host.runPending(8);
      assert.equal(deliveryCalls, 4);
      assert.equal(deliveryRecords.at(-1).text, '⚠️ LLM request failed: provider terminal');
      assert.equal(readDurable().history.length, historyBeforeLlmFailure + 1);
      assert.equal(readDurable().history.at(-1).parts[0].text, 'llm fail');
      assert.equal(deliveryRecords.at(-1).messageCount, readDurable().history.length);
    }, true, async projection => { latestProjection = structuredClone(projection); }, async (_source, text, outcome) => {
      deliveryCalls += 1; outcomes.push(outcome); deliveryRecords.push({ text, outcome, messageCount: latestProjection?.messageCount });
      throw new Error('ambiguous reverse transport');
    });
  } finally { (llm as any).chat = originalChat; }
});

test('worker delivers canonical model text before multiple tool iterations and only finalizes the genuine no-tool result', async () => {
  const initial = baseSession('worker-intermediate-text');
  const originalChat = llm.chat;
  const intermediate: Array<{ source: any; text: string }> = [];
  const finals: Array<{ source: any; text: string; outcome: string }> = [];
  let chatCalls = 0;
  const source = {
    platform: 'qqbot', channelId: 'qq-instance', channelType: 'qqbot',
    channelUserId: 'c2c:openid', conversationId: 'c2c:openid',
    qqbotMessageId: 'inbound-message',
  };
  (llm as any).chat = async (parts: any, _session: any, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    chatCalls += 1;
    if (chatCalls <= 2) {
      const text = `intermediate-${chatCalls}`;
      const toolCall = { id: `status-${chatCalls}`, name: 'session', args: { action: 'status' } };
      await options.appendMessage({ role: 'model', parts: [{ text }, { functionCall: toolCall }] });
      return { text, toolCalls: [toolCall], allParts: [{ text }, { functionCall: toolCall }], usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
    }
    const text = 'genuine-final';
    await options.appendMessage({ role: 'model', parts: [{ text }] });
    return { text, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
  };
  try {
    await withLocalHost(initial, async ({ host, store, readDurable }) => {
      store.enqueueIntent(initial.id, 'intermediate-text', 'enqueue', { type: 'user', source, parts: [{ text: 'run tools' }] });
      await host.runPending(8);
      assert.equal(chatCalls, 3);
      assert.deepEqual(intermediate.map(item => item.text), ['intermediate-1', 'intermediate-2']);
      assert.deepEqual(finals.map(item => [item.text, item.outcome]), [['genuine-final', 'response']]);
      assert.equal(readDurable().history.filter((message: any) => message.role === 'model' && message.parts.some((part: any) => part.text === 'intermediate-1')).length, 1);
      assert.equal(readDurable().busy, false);
    }, true, undefined,
      async (finalSource, text, outcome) => { finals.push({ source: finalSource, text, outcome }); },
      async (intermediateSource, text) => { intermediate.push({ source: intermediateSource, text }); });
  } finally { (llm as any).chat = originalChat; }
});

test('worker publishes a no-tool result once when a compatible QQ follow-up arrives during the provider request', async () => {
  const initial = baseSession('worker-no-tool-compatible-followup');
  const originalChat = llm.chat;
  const intermediate: Array<{ source: any; text: string }> = [];
  const finals: Array<{ source: any; text: string; outcome: string }> = [];
  const firstSource = {
    platform: 'qqbot', channelId: 'qq-instance', channelType: 'qqbot',
    channelUserId: 'c2c:openid', conversationId: 'c2c:openid', qqbotMessageId: 'qq-first',
  };
  const latestSource = { ...firstSource, qqbotMessageId: 'qq-latest' };
  let storeRef: SessionWorkerStore | undefined;
  let readDurableRef: (() => Record<string, any>) | undefined;
  let latestProjection: any;
  let chatCalls = 0;
  (llm as any).chat = async (parts: any, _session: any, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    chatCalls += 1;
    if (chatCalls === 1) {
      const text = 'seq604 no-tool text';
      await options.appendMessage({ role: 'model', parts: [{ text }] });
      storeRef!.enqueueIntent(initial.id, 'qq-compatible-followup', 'enqueue', {
        type: 'user', source: latestSource, parts: [{ text: 'compatible follow-up' }], queuedAt: Date.now(),
      });
      return { text, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
    }
    const text = 'provider-call-2 final';
    await options.appendMessage({ role: 'model', parts: [{ text }] });
    return { text, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } };
  };
  try {
    await withLocalHost(initial, async ({ host, store, readDurable }) => {
      storeRef = store;
      readDurableRef = readDurable;
      store.enqueueIntent(initial.id, 'qq-initial', 'enqueue', {
        type: 'user', source: firstSource, parts: [{ text: 'initial request' }], queuedAt: Date.now(),
      });
      await host.runPending(8);
      assert.equal(chatCalls, 2);
      assert.deepEqual(intermediate.map(item => [item.text, item.source.qqbotMessageId]), [['seq604 no-tool text', 'qq-latest']]);
      assert.deepEqual(finals.map(item => [item.text, item.outcome, item.source.qqbotMessageId]), [['provider-call-2 final', 'response', 'qq-latest']]);
      assert.deepEqual(readDurable().history.map((message: any) => message.role), ['user', 'model', 'user', 'model']);
      const durableText = JSON.stringify(readDurable().history);
      for (const expectedText of ['initial request', 'seq604 no-tool text', 'compatible follow-up', 'provider-call-2 final']) {
        assert.equal(durableText.split(expectedText).length - 1, 1, `${expectedText} remains one separate canonical row`);
      }
      assert.equal(readDurable().lastAppliedMailboxId, 2);
      assert.equal(readDurable().busy, false);
    }, true, async projection => { latestProjection = structuredClone(projection); },
      async (source, text, outcome) => {
        assert.deepEqual(readDurableRef!().history.map((message: any) => message.role), ['user', 'model', 'user', 'model']);
        finals.push({ source, text, outcome });
      },
      async (source, text) => {
        assert.deepEqual(readDurableRef!().history.map((message: any) => message.role), ['user', 'model']);
        assert.equal(readDurableRef!().queue.length, 1, 'compatible mailbox input remains queued until after intermediate delivery');
        assert.equal(latestProjection.messageCount, 2, 'model publication precedes intermediate delivery');
        intermediate.push({ source, text });
      });
  } finally { (llm as any).chat = originalChat; }
});

test('worker keeps tool call/result adjacent while delivering text before appending a compatible follow-up', async () => {
  const initial = baseSession('worker-tool-followup-adjacency');
  const originalChat = llm.chat; const originalExecuteTools = llm.executeTools;
  const source = {
    platform: 'qqbot', channelId: 'qq-instance', channelType: 'qqbot',
    channelUserId: 'c2c:openid', conversationId: 'c2c:openid', qqbotMessageId: 'qq-first',
  };
  let storeRef: SessionWorkerStore | undefined;
  let readDurableRef: (() => Record<string, any>) | undefined;
  const intermediate: string[] = []; const finals: string[] = [];
  let chatCalls = 0;
  (llm as any).chat = async (parts: any, _session: any, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    chatCalls += 1;
    if (chatCalls === 1) {
      const toolCall = { id: 'adjacent-tool', name: 'session', args: { action: 'status' } };
      await options.appendMessage({ role: 'model', parts: [{ text: 'tool text' }, { functionCall: toolCall }] });
      storeRef!.enqueueIntent(initial.id, 'tool-followup', 'enqueue', {
        type: 'user', source: { ...source, qqbotMessageId: 'qq-latest' }, parts: [{ text: 'after tool' }],
      });
      return { text: 'tool text', toolCalls: [toolCall], allParts: [{ text: 'tool text' }, { functionCall: toolCall }] };
    }
    assert.deepEqual(readDurableRef!().history.map((message: any) => message.role), ['user', 'model', 'tool', 'user']);
    await options.appendMessage({ role: 'model', parts: [{ text: 'tool follow-up final' }] });
    return { text: 'tool follow-up final' };
  };
  (llm as any).executeTools = async () => ({
    role: 'tool',
    parts: [{ functionResponse: { tool_use_id: 'adjacent-tool', name: 'session', response: { output: 'ok' } } }],
  });
  try {
    await withLocalHost(initial, async ({ host, store, readDurable }) => {
      storeRef = store; readDurableRef = readDurable;
      store.enqueueIntent(initial.id, 'tool-initial', 'enqueue', { type: 'user', source, parts: [{ text: 'run tool' }] });
      await host.runPending(8);
      assert.equal(chatCalls, 2);
      assert.deepEqual(intermediate, ['tool text']);
      assert.deepEqual(finals, ['tool follow-up final']);
      assert.deepEqual(readDurable().history.map((message: any) => message.role), ['user', 'model', 'tool', 'user', 'model']);
    }, true, undefined,
      async (_source, text) => { finals.push(text); },
      async (_source, text) => {
        assert.deepEqual(readDurableRef!().history.map((message: any) => message.role), ['user', 'model']);
        intermediate.push(text);
      });
  } finally { (llm as any).chat = originalChat; (llm as any).executeTools = originalExecuteTools; }
});

test('tool terminal paths never resend model text and close an active Worker WeWork stream', async t => {
  const originalChat = llm.chat; const originalExecuteTools = llm.executeTools;
  let mode: 'wait' | 'stop' | 'stop-empty' | 'managed' | 'tool-stop' = 'wait';
  (llm as any).chat = async (parts: any, _session: any, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    const toolCall = { id: `terminal-${mode}`, name: 'session', args: { action: 'status' } };
    const text = mode === 'stop-empty' ? '' : `${mode} text`;
    await options.appendMessage({ role: 'model', parts: [{ text }, { functionCall: toolCall }] });
    return { text, toolCalls: [toolCall], allParts: [{ text }, { functionCall: toolCall }] };
  };
  (llm as any).executeTools = async (_calls: any, _context: any, session: Session) => {
    if (mode === 'stop' || mode === 'stop-empty') session.stopping = true;
    if (mode === 'managed') (session.meta as any).managedSession = {
      ownerSessionId: 'owner', leaseId: 'lease', revision: 1, pendingInbox: [], openedAt: 1, leaseTouchedAt: 1,
      currentStep: { stepId: 'step', runMode: 'tool' },
    };
    return {
      role: 'tool',
      parts: [{ functionResponse: { tool_use_id: `terminal-${mode}`, name: 'session', response: { output: 'ok' } } }],
      ...(mode === 'wait' ? { __toolPostAction: { waitForReply: true } } : {}),
      ...(mode === 'tool-stop' ? { __toolLoopControl: { stopCurrentTurn: true } } : {}),
    };
  };
  try {
    for (mode of ['wait', 'stop', 'stop-empty', 'managed', 'tool-stop'] as const) {
      await t.test(mode, async () => {
        const initial = baseSession(`worker-tool-terminal-${mode}`);
        const intermediates: string[] = []; const finals: Array<{ text: string; outcome: string }> = [];
        await withLocalHost(initial, async ({ host, store, readDurable }) => {
          store.enqueueIntent(initial.id, `terminal-${mode}`, 'enqueue', {
            type: 'user',
            source: { platform: 'wework', channelId: 'wework', channelUserId: 'chat', conversationId: 'chat', weworkStreamId: `stream-${mode}` },
            parts: [{ text: mode }],
          });
          await host.runPending(8);
          assert.deepEqual(intermediates, mode === 'stop-empty' ? [] : [`${mode} text`]);
          assert.deepEqual(finals, mode === 'stop-empty'
            ? [{ text: '_[Execution stopped by user]_', outcome: 'response' }]
            : [{ text: '', outcome: 'empty-final' }]);
          assert.equal(readDurable().history.filter((message: any) => message.role === 'model').length, 1);
          assert.equal(readDurable().busy, false);
        }, true, undefined,
          async (_source, text, outcome) => { finals.push({ text, outcome }); },
          async (_source, text) => { intermediates.push(text); });
      });
    }
  } finally { (llm as any).chat = originalChat; (llm as any).executeTools = originalExecuteTools; }
});

test('worker intermediate delivery failure is swallowed without poisoning later turns', async () => {
  const initial = baseSession('worker-intermediate-delivery-failure');
  const originalChat = llm.chat;
  let chatCalls = 0; let intermediateCalls = 0; let finalCalls = 0;
  (llm as any).chat = async (parts: any, _session: any, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    chatCalls += 1;
    const toolCall = { id: `failure-status-${chatCalls}`, name: 'session', args: { action: 'status' } };
    if (chatCalls % 2 === 1) {
      await options.appendMessage({ role: 'model', parts: [{ text: 'intermediate despite delivery failure' }, { functionCall: toolCall }] });
      return { text: 'intermediate despite delivery failure', toolCalls: [toolCall], allParts: [{ text: 'intermediate despite delivery failure' }, { functionCall: toolCall }] };
    }
    await options.appendMessage({ role: 'model', parts: [{ text: `final-${chatCalls}` }] });
    return { text: `final-${chatCalls}` };
  };
  try {
    await withLocalHost(initial, async ({ host, store, readDurable }) => {
      store.enqueueIntent(initial.id, 'first', 'enqueue', { type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'first' }] });
      await host.runPending(8);
      assert.equal(intermediateCalls, 1); assert.equal(finalCalls, 1); assert.equal(readDurable().busy, false);
      store.enqueueIntent(initial.id, 'second', 'enqueue', { type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'second' }] });
      await host.runPending(8);
      assert.equal(intermediateCalls, 2); assert.equal(finalCalls, 2); assert.equal(readDurable().busy, false);
    }, true, undefined,
      async () => { finalCalls += 1; },
      async () => { intermediateCalls += 1; throw new Error('QQ delivery unavailable'); });
  } finally { (llm as any).chat = originalChat; }
});

test('worker tool-stop finalizes the iteration without a duplicate model-text delivery', async () => {
  const initial = baseSession('worker-intermediate-no-duplicate-final');
  const originalChat = llm.chat; const originalExecuteTools = llm.executeTools;
  let intermediateCalls = 0; let finalCalls = 0;
  (llm as any).chat = async (parts: any, _session: any, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    const toolCall = { id: 'stop-after-intermediate', name: 'session', args: { action: 'status' } };
    await options.appendMessage({ role: 'model', parts: [{ text: 'already sent', }, { functionCall: toolCall }] });
    return { text: 'already sent', toolCalls: [toolCall], allParts: [{ text: 'already sent' }, { functionCall: toolCall }] };
  };
  (llm as any).executeTools = async () => ({ parts: [{ functionResponse: { name: 'session', response: 'stopped' } }], __toolLoopControl: { stopCurrentTurn: true } });
  try {
    await withLocalHost(initial, async ({ host, store, readDurable }) => {
      store.enqueueIntent(initial.id, 'stop-after-text', 'enqueue', { type: 'user', source: { platform: 'qqbot', channelId: 'qq', channelType: 'qqbot', channelUserId: 'c2c:openid', conversationId: 'c2c:openid', qqbotMessageId: 'inbound' }, parts: [{ text: 'stop' }] });
      await host.runPending(8);
      assert.equal(intermediateCalls, 1); assert.equal(finalCalls, 0); assert.equal(readDurable().busy, false);
    }, true, undefined,
      async () => { finalCalls += 1; },
      async () => { intermediateCalls += 1; });
  } finally { (llm as any).chat = originalChat; (llm as any).executeTools = originalExecuteTools; }
});

test('automatic compact maintenance failure after a delivered success resyncs without a second final', async () => {
  const initial = baseSession('worker-auto-compact-failure'); initial.compactThresholdTokens = 1;
  const originalChat = llm.chat; const originalCompact = sessionHistory.processSessionCompactionRequest;
  let deliveries = 0; let compactCalls = 0;
  (llm as any).chat = async (parts: any, _session: any, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'delivered success' }] });
    return { text: 'delivered success', usage: { inputTokens: 2, outputTokens: 0, cachedTokens: 0 } };
  };
  (sessionHistory as any).processSessionCompactionRequest = async () => { compactCalls += 1; throw new Error('automatic maintenance failed'); };
  try {
    await withLocalHost(initial, async ({ host, store, readDurable }) => {
      (host as any).resyncAfterFailure = async () => { (host as any).publicationPoison = new Error('post-final resync unavailable'); throw new Error('post-final resync unavailable'); };
      store.enqueueIntent(initial.id, 'auto-fail', 'enqueue', { type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'work' }] });
      await assert.rejects(() => host.runPending(8), /resync unavailable|publication/i);
      assert.equal(compactCalls, 1); assert.equal(deliveries, 1); assert.equal(readDurable().busy, true);
      assert.equal(readDurable().history.at(-1).parts[0].text, 'delivered success');
    }, true, undefined, async () => { deliveries += 1; });
  } finally { (llm as any).chat = originalChat; (sessionHistory as any).processSessionCompactionRequest = originalCompact; }
});

test('post-final transient compact poison releases busy with one resynced retry and remains usable', async () => {
  const initial = baseSession('worker-post-final-compact-recovery'); initial.compactThresholdTokens = 1;
  const originalChat = llm.chat; const originalCompact = sessionHistory.processSessionCompactionRequest;
  let deliveries = 0; let compactCalls = 0; let failFirstResync = true;
  (llm as any).chat = async (parts: any, _session: any, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'usable response' }] });
    return { text: 'usable response', usage: { inputTokens: 2, outputTokens: 0, cachedTokens: 0 } };
  };
  (sessionHistory as any).processSessionCompactionRequest = async () => { compactCalls += 1; throw new Error('post-final compact failed'); };
  try {
    await withLocalHost(initial, async ({ host, store, readDurable }) => {
      const realResync = (host as any).resyncAfterFailure.bind(host);
      (host as any).resyncAfterFailure = async (error: any) => {
        if (!failFirstResync) return realResync(error);
        failFirstResync = false;
        (host as any).poison = { original: error, resync: new Error('one transient reload failure') };
        throw new Error('one transient reload failure');
      };
      store.enqueueIntent(initial.id, 'post-final-recover', 'enqueue', { type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'first' }] });
      await host.runPending(8);
      assert.equal(deliveries, 1); assert.equal(compactCalls, 1); assert.equal(readDurable().busy, false); assert.equal((host as any).poison, undefined);
      (sessionHistory as any).processSessionCompactionRequest = originalCompact; (host as any).session.compactThresholdTokens = 999999;
      store.enqueueIntent(initial.id, 'post-final-usable', 'enqueue', { type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'second' }] });
      await host.runPending(8);
      assert.equal(deliveries, 2); assert.equal(readDurable().busy, false);
    }, true, undefined, async () => { deliveries += 1; });
  } finally { (llm as any).chat = originalChat; (sessionHistory as any).processSessionCompactionRequest = originalCompact; }
});

test('pre-final automatic compact poison stops before a second provider call and emits one error final', async () => {
  const initial = baseSession('worker-pre-final-compact-failure'); initial.compactThresholdTokens = 1; let chatCalls = 0; let deliveries = 0; let compactCalls = 0;
  const originalChat = llm.chat; const originalCompact = sessionHistory.processSessionCompactionRequest;
  (llm as any).chat = async (parts: any, _session: any, _iteration: number, options: any) => {
    chatCalls += 1; if (parts) await options.appendMessage({ role: 'user', parts });
    if (chatCalls > 1) { await options.appendMessage({ role: 'model', parts: [{ text: 'recovered turn' }] }); return { text: 'recovered turn', usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }; }
    const toolCall = { id: 'status-before-compact', name: 'session', args: { action: 'status' } };
    await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
    return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }], usage: { inputTokens: 2, outputTokens: 0, cachedTokens: 0 } };
  };
  (sessionHistory as any).processSessionCompactionRequest = async (deps: any, id: string, _request: any) => {
    compactCalls += 1; deps.getSessionById(id).displayName = 'partial compact mutation'; throw new Error('pre-final compact failed');
  };
  try {
    await withLocalHost(initial, async ({ host, store, readDurable }) => {
      (host as any).resyncAfterFailure = async () => {
        (host as any).poison = { original: new Error('pre-final compact failed'), resync: new Error('reload failed') };
        throw new Error('reload failed');
      };
      store.enqueueIntent(initial.id, 'pre-final-fail', 'enqueue', { type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'work' }] });
      store.enqueueIntent(initial.id, 'pre-final-deferred', 'enqueue', { type: 'user', source: { platform: 'test', channelUserId: 'other-room', preferDirectReply: true }, parts: [{ text: 'must remain queued' }] });
      await host.runPending(8);
      await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve));
      assert.equal(chatCalls, 1); assert.equal(deliveries, 1); assert.equal(compactCalls, 1);
      assert.equal(readDurable().queue.length, 1); assert.equal(readDurable().busy, false);
      (sessionHistory as any).processSessionCompactionRequest = originalCompact; (host as any).session.compactThresholdTokens = 999999;
      await host.runPending(8);
      assert.equal(chatCalls, 2); assert.equal(deliveries, 2); assert.equal(readDurable().queue.length, 0); assert.equal(readDurable().busy, false);
    }, true, undefined, async (_source, text, outcome) => { deliveries += 1; assert.equal(outcome, 'error'); assert.match(text, /Automatic Worker compaction failed/); });
  } finally { (llm as any).chat = originalChat; (sessionHistory as any).processSessionCompactionRequest = originalCompact; }
});

test('source-less pre-final compact fatal skips history reminder and delivery branches without masking', async () => {
  const initial = baseSession('worker-source-less-compact-fatal'); initial.compactThresholdTokens = 1; initial.parentSessionId = 'parent';
  const originalChat = llm.chat; const originalCompact = sessionHistory.processSessionCompactionRequest;
  let chatCalls = 0; let reminderEffects = 0; let deliveries = 0;
  (llm as any).chat = async (parts: any, _session: any, _iteration: number, options: any) => {
    chatCalls += 1; if (parts) await options.appendMessage({ role: 'user', parts });
    const toolCall = { id: 'source-less-status', name: 'session', args: { action: 'status' } };
    await options.appendMessage({ role: 'model', parts: [{ functionCall: toolCall }] });
    return { text: '', toolCalls: [toolCall], allParts: [{ functionCall: toolCall }], usage: { inputTokens: 2, outputTokens: 0, cachedTokens: 0 } };
  };
  (sessionHistory as any).processSessionCompactionRequest = async () => { throw new Error('source-less compact failed'); };
  try {
    await withLocalHost(initial, async ({ host, store, session }) => {
      (host as any).runner.maybeQueueChildReminder = async () => { reminderEffects += 1; };
      (host as any).resyncAfterFailure = async () => {
        (host as any).poison = { original: new Error('source-less compact failed'), resync: new Error('source-less reload failed') };
        throw new Error('source-less reload failed');
      };
      store.enqueueIntent(initial.id, 'source-less-fatal', 'enqueue', { type: 'background', parts: [{ system: 'background maintenance turn' }] });
      await assert.rejects(() => host.runPending(8), (error: any) => error?.code === 'SESSION_WORKER_AUTO_COMPACTION_FATAL');
      assert.equal(chatCalls, 1); assert.equal(reminderEffects, 0); assert.equal(deliveries, 0);
      assert.equal(session.history.some(message => JSON.stringify(message.parts).includes('Automatic Worker compaction failed')), false);
    }, true, undefined, async () => { deliveries += 1; });
  } finally { (llm as any).chat = originalChat; (sessionHistory as any).processSessionCompactionRequest = originalCompact; }
});

test('Worker stop-owned release failure restores authority and is not retried by outer cleanup', async () => {
  const initial = baseSession('worker-stop-release-failure');
  const originalChat = llm.chat;
  (llm as any).chat = async (_parts: any, activeSession: Session, _iteration: number, options: any) => {
    activeSession.stopping = true;
    await options.appendMessage({ role: 'model', parts: [{ text: 'stop before release' }] });
    return { text: 'stop before release' };
  };
  try {
    await withLocalHost(initial, async ({ host, store, session, turnHost, readDurable }) => {
      const releaseAttempts = injectWorkerReleasePersistenceFailure(host, turnHost, 'worker stop release rejected');
      store.enqueueIntent(initial.id, 'worker-stop-release', 'enqueue', {
        type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'stop' }],
      });
      await assert.rejects(() => host.runPending(8), /worker stop release rejected/);
      assert.equal(releaseAttempts(), 1);
      assert.equal(session.busy, true);
      assert.equal(readDurable().busy, true);
    }, true, undefined, async () => {});
  } finally { (llm as any).chat = originalChat; }
});

test('Worker fenced turn-owned release failure restores authority and is not retried by outer cleanup', async () => {
  const initial = baseSession('worker-fenced-release-failure');
  const originalChat = llm.chat;
  (llm as any).chat = async () => {
    const error = new Error('worker fenced semantic failure') as Error & { code: string };
    error.code = 'SESSION_WORKER_AUTO_COMPACTION_FATAL';
    throw error;
  };
  try {
    await withLocalHost(initial, async ({ host, store, session, turnHost, readDurable }) => {
      const releaseAttempts = injectWorkerReleasePersistenceFailure(host, turnHost, 'worker fenced release rejected');
      store.enqueueIntent(initial.id, 'worker-fenced-release', 'enqueue', {
        type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'fenced' }],
      });
      await assert.rejects(() => host.runPending(8), /worker fenced release rejected/);
      assert.equal(releaseAttempts(), 1);
      assert.equal(session.busy, true);
      assert.equal(readDurable().busy, true);
    }, true, undefined, async () => {});
  } finally { (llm as any).chat = originalChat; }
});

test('explicit awaited compact rejects busy or queued exact owners instead of waiting', async () => {
  const initial = baseSession('worker-explicit-compact-admission');
  await withLocalHost(initial, async ({ host, session }) => {
    session.busy = true;
    await assert.rejects(() => host.compactAwaited({ keepPercent: 0.3 }), assertRpcCode('SESSION_WORKER_COMPACTION_BUSY'));
    session.busy = false; session.queue.push({ type: 'background', parts: [{ system: 'pending' }] });
    await assert.rejects(() => host.compactAwaited({ keepPercent: 0.3 }), assertRpcCode('SESSION_WORKER_COMPACTION_BUSY'));
  });
});

test('worker mailbox reuses canonical wait and waitAll transitions', async () => {
  const scenarios: Array<{ name: string; wait?: any; items: any[]; queueTypes: string[]; waitPresent: boolean }> = [
    { name: 'ordinary wait wakes', wait: { id: 'w', startedAt: 1 }, items: [{ type: 'user', parts: [{ text: 'wake' }] }], queueTypes: ['user'], waitPresent: false },
    { name: 'stale timeout drops', wait: { id: 'w', startedAt: 1 }, items: [{ type: 'background', waitTimeoutId: 'old', parts: [{ system: 'late' }] }], queueTypes: [], waitPresent: true },
    { name: 'listed waitAll defers', wait: { id: 'w', startedAt: 1, waitAll: { sessions: ['a', 'b'], satisfiedSessions: [], deferredQueue: [] } }, items: [{ type: 'intersession', sourceSessionId: 'a', parts: [{ text: 'a' }] }], queueTypes: [], waitPresent: true },
    { name: 'listed waitAll completes', wait: { id: 'w', startedAt: 1, waitAll: { sessions: ['a', 'b'], satisfiedSessions: [], deferredQueue: [] } }, items: [{ type: 'intersession', sourceSessionId: 'a', parts: [{ text: 'a' }] }, { type: 'intersession', sourceSessionId: 'b', parts: [{ text: 'b' }] }], queueTypes: ['intersession', 'intersession'], waitPresent: false },
    { name: 'unrelated waitAll wakes with reminder', wait: { id: 'w', startedAt: 1, waitAll: { sessions: ['a'], satisfiedSessions: [], deferredQueue: [] } }, items: [{ type: 'user', parts: [{ text: 'other' }] }], queueTypes: ['user', 'background'], waitPresent: false },
    { name: 'active timeout wakes', wait: { id: 'w', startedAt: 1 }, items: [{ type: 'background', waitTimeoutId: 'w', parts: [{ system: 'timeout' }] }], queueTypes: ['background'], waitPresent: false },
  ];
  for (const scenario of scenarios) {
    const initial = baseSession(`wait-${scenario.name.replace(/\W/g, '-')}`); initial.meta.wait = scenario.wait;
    await withLocalHost(initial, async ({ host, store, session }) => {
      for (const [index, item] of scenario.items.entries()) store.enqueueIntent(initial.id, `${scenario.name}-${index}`, 'enqueue', item);
      await host.runPending(32);
      assert.deepEqual(session.queue.map(item => item.type), scenario.queueTypes, scenario.name);
      assert.equal(!!session.meta.wait, scenario.waitPresent, scenario.name);
    });
  }
});

test('worker fails managed and compact queues before state write or mailbox acknowledgement', async () => {
  for (const mode of ['managed', 'existing-compact', 'mailbox-compact'] as const) {
    const initial = baseSession(`unsupported-${mode}`);
    if (mode === 'managed') (initial.meta as any).managedSession = { ownerSessionId: 'owner', leaseId: 'lease', revision: 1, pendingInbox: [], openedAt: 1, leaseTouchedAt: 1 };
    if (mode === 'existing-compact') initial.queue.push({ type: 'compact-commit', request: {} } as any);
    await withLocalHost(initial, async ({ host, store, readDurable }) => {
      const before = readDurable();
      if (mode === 'mailbox-compact') store.enqueueIntent(initial.id, 'compact', 'enqueue', { type: 'compact-commit', request: {} });
      await assert.rejects(() => host.runPending(8), assertRpcCode('SESSION_WORKER_QUEUE_UNSUPPORTED'));
      assert.equal(store.getOwnership(initial.id).mailboxCursor, 0);
      assert.deepEqual(readDurable(), before);
    });
  }
});

test('worker retries a transient pre-hydration initialization failure', async () => {
  const initial = baseSession('transient-worker-init');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-init-'));
  const store = new SessionWorkerStore(path.join(root, 'runtime.sqlite')); store.open();
  const owner = store.beginGeneration(initial.id, 'inc');
  store.registerCandidate(initial.id, owner.generation, 'inc', process.pid, 'test');
  store.activateCandidate(initial.id, owner.generation, 'inc', process.pid, 'test');
  let attempts = 0; let durable = serializeSessionHistoryPayload(initial);
  const host = new SessionWorkerHost({ sessionId: initial.id, generation: owner.generation, incarnationId: 'inc', pid: process.pid, processIdentity: 'test' }, store, {
    initialize: async () => { attempts += 1; if (attempts === 1) throw new Error('transient init'); },
    persistence: { readState: async () => structuredClone(durable), writeState: async session => { durable = serializeSessionHistoryPayload(session); } },
  });
  try {
    await assert.rejects(() => host.runPending(8), /transient init/);
    await host.runPending(8);
    assert.equal(attempts, 2);
  } finally { store.close(); await fs.remove(root); }
});

test('failed mutation plus failed reload poisons until a later run resynchronizes first', async () => {
  const initial = baseSession('poisoned-worker-owner');
  await withLocalHost(initial, async ({ host, session, readDurable }) => {
    const persistence = (host as any).persistence;
    const originalWrite = persistence.writeState;
    const originalRead = persistence.readState;
    persistence.writeState = async () => { throw new Error('primary write failed'); };
    persistence.readState = async () => { throw new Error('secondary reload failed'); };
    session.displayName = 'must-not-survive';
    await assert.rejects(() => (host as any).persistOwner(), (error: any) => {
      assert.equal(error.code, 'SESSION_WORKER_RESYNC_REQUIRED');
      assert.match(error.details.original.message, /primary write failed/);
      assert.match(error.details.resync.message, /secondary reload failed/);
      return true;
    });
    persistence.writeState = originalWrite;
    persistence.readState = originalRead;
    await host.runPending(8);
    assert.equal(session.displayName, undefined);
    assert.equal(readDurable().displayName, undefined);
  });
});

test('exec completion is serialized after a failed turn and remains one durable wait-aware item', async () => {
  const initial = baseSession('serialized-exec-completion');
  initial.meta.wait = { id: 'wait-exec', startedAt: 1 };
  await withLocalHost(initial, async ({ host, session, readDurable }) => {
    let calls = 0; let started!: () => void; let failFirst!: () => void;
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const firstFailure = new Promise<void>(resolve => { failFirst = resolve; });
    (host as any).runner = {
      processSessionQueue: async () => {
        calls += 1;
        if (calls === 1) { started(); await firstFailure; throw new Error('turn mutation failed'); }
        throw new Error('scheduled completion processing failed');
      },
    };
    const turn = host.runPending(8);
    await firstStarted;
    const completion = (host as any).commitExecCompletion('background exec finished');
    failFirst();
    await assert.rejects(() => turn, /turn mutation failed/);
    await completion;
    for (let index = 0; index < 20 && calls < 2; index += 1) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(calls, 2);
    assert.equal(session.meta.wait, undefined);
    assert.equal(session.queue.length, 1);
    assert.match(String((session.queue[0] as any).parts?.[0]?.system), /foxwarm-system kind="system" time=/);
    assert.equal(readDurable().queue.length, 1);
  });
});

test('dequeue during post-tool ingestion leaves new rows for the same outer action loop', async () => {
  const initial = baseSession('worker-dequeue-tool-phase');
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  let storeRef: SessionWorkerStore | undefined;
  let chatCalls = 0;
  const finalDeliveries: Array<{ text: string; outcome: string }> = [];
  (llm as any).chat = async (parts: any, _session: Session, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    chatCalls += 1;
    if (chatCalls === 1) {
      const call = { id: 'held-tool', name: 'session', args: { action: 'status' } };
      await options.appendMessage({ role: 'model', parts: [{ text: 'tool phase text' }, { functionCall: call }] });
      return { text: 'tool phase text', toolCalls: [call], allParts: [{ text: 'tool phase text' }, { functionCall: call }] };
    }
    await options.appendMessage({ role: 'model', parts: [{ text: 'queued turn final' }] });
    return { text: 'queued turn final' };
  };
  (llm as any).executeTools = async () => {
    storeRef!.enqueueIntent(initial.id, 'queued-during-tool', 'enqueue', {
      type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'queued after tool' }],
    });
    return {
      role: 'tool',
      parts: [{ functionResponse: { tool_use_id: 'held-tool', name: 'session', response: { output: 'ok' } } }],
    };
  };
  try {
    await withLocalHost(initial, async ({ host, store, session, turnHost, readDurable }) => {
      storeRef = store;
      const originalIngest = turnHost.ingestPendingQueue.bind(turnHost);
      let ingestCalls = 0;
      let postToolIngested!: () => void;
      let releasePostToolIngest!: () => void;
      const postToolIngest = new Promise<void>(resolve => { postToolIngested = resolve; });
      const postToolRelease = new Promise<void>(resolve => { releasePostToolIngest = resolve; });
      turnHost.ingestPendingQueue = async (owner: Session) => {
        ingestCalls += 1;
        await originalIngest(owner);
        if (ingestCalls === 2) {
          postToolIngested();
          await postToolRelease;
        }
      };
      store.enqueueIntent(initial.id, 'initial-tool-turn', 'enqueue', {
        type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'start held tool' }],
      });
      const turn = host.runPending(8);
      await postToolIngest;
      assert.equal(session.queue.length, 1, 'second ingestion has made the durable input hot but has not returned to queue consumption');
      assert.deepEqual(await host.dequeue(), {
        queuedItems: 1, stoppedCurrent: true, abortedInFlight: false,
      });
      assert.equal(readDurable().queue.length, 1, 'dequeue leaves the newly ingested row queued while the safe point is paused');
      releasePostToolIngest();
      await turn;
      for (let index = 0; index < 40 && readDurable().busy; index += 1) await new Promise(resolve => setTimeout(resolve, 5));
      const durable = readDurable();
      assert.equal(durable.busy, false);
      assert.equal(durable.queue.length, 0);
      assert.equal(durable.stopping, false);
      assert.equal(durable.meta.runQueuedAfterStop, undefined);
      assert.equal(JSON.stringify(durable.history).split('queued after tool').length - 1, 1);
      assert.equal(JSON.stringify(durable.history).split('queued turn final').length - 1, 1);
      assert.equal(chatCalls, 2);
      assert.equal(ingestCalls, 4, 'post-tool recheck leaves the row for finalization and the next outer source turn');
      assert.deepEqual(finalDeliveries, [
        { text: '_[Execution stopped by user]_', outcome: 'response' },
        { text: 'queued turn final', outcome: 'response' },
      ]);
    }, true, undefined, async (_source, text, outcome) => {
      finalDeliveries.push({ text, outcome });
    });
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
  }
});

test('idle worker BTW snapshots exact owner state, persists cache lineage, and appends one display-only result per outcome', async () => {
  const initial = baseSession('worker-btw-idle');
  initial.history = [{ role: 'user', parts: [{ text: 'immutable owner prefix' }] }];
  initial.nextMessageSeq = 2;
  const originalChat = llm.chat;
  const originalExecuteTools = llm.executeTools;
  let executeToolsCalled = false;
  let readDurable!: () => Record<string, any>;
  let hotOwner!: Session;
  let calls = 0;
  const deliveries: Array<{ source: any; text: string }> = [];
  (llm as any).executeTools = async () => { executeToolsCalled = true; throw new Error('BTW must not execute tools'); };
  (llm as any).chat = async (parts: any, snapshot: Session, _iteration: number, options: any) => {
    calls += 1;
    assert.notEqual(snapshot, hotOwner);
    assert.deepEqual(snapshot.history, hotOwner.history);
    assert.equal(snapshot.promptCacheKey, hotOwner.promptCacheKey);
    assert.equal(readDurable().promptCacheKey, snapshot.promptCacheKey, 'legacy prompt-cache identity is durable before the snapshot provider starts');
    assert.equal(options.purpose, 'btw');
    assert.equal(options.notifySessionEvents, false);
    assert.equal(options.registerAbortController, false);
    snapshot.history[0].parts[0].text = 'mutated detached prefix';
    assert.equal(hotOwner.history[0].parts[0].text, 'immutable owner prefix');
    if (parts) await options.appendMessage({ role: 'user', parts });
    if (calls === 2) {
      const call = { id: 'btw-denied', name: 'exec', args: { command: 'false' } };
      await options.appendMessage({ role: 'model', parts: [{ functionCall: call }] });
      return { toolCalls: [call], allParts: [{ functionCall: call }] };
    }
    if (calls === 3) throw new Error('idle BTW provider failed');
    await options.appendMessage({ role: 'model', parts: [{ text: 'idle BTW answer' }] });
    return { text: 'idle BTW answer', modelId: 'provider/model', virtualModelKey: 'route', allParts: [{ text: 'idle BTW answer' }] };
  };
  try {
    await withLocalHost(initial, async ({ host, session, readDurable: read }) => {
      hotOwner = session; readDurable = read;
      const success = await host.runBtw('idle success');
      const denied = await host.runBtw('idle denied');
      const failed = await host.runBtw('idle error');
      assert.equal(success.toolDenied, false);
      assert.equal(denied.toolDenied, true);
      assert.equal(failed.toolDenied, false);
      assert.equal(executeToolsCalled, false);
      const durable = read();
      assert.equal(durable.history.length, 4);
      assert.equal(durable.history[0].parts[0].text, 'immutable owner prefix');
      assert.ok(durable.history.slice(1).every((message: any) => message.modelVisible === false && message.__meta.noticeType === 'btw'));
      assert.equal(durable.history[1].__meta.modelId, 'provider/model');
      assert.equal(durable.history[1].__meta.virtualModelKey, 'route');
      assert.match(durable.history[1].parts[0].text, /idle BTW answer/);
      assert.match(durable.history[2].parts[0].text, /BTW aborted/);
      assert.match(durable.history[2].parts[0].text, /`exec`/);
      assert.match(durable.history[3].parts[0].text, /BTW error/);
      assert.match(durable.history[3].parts[0].text, /idle BTW provider failed/);
      assert.equal(success.projection.messageCount, 2);
      assert.equal(failed.projection.messageCount, 4);
      assert.equal(deliveries.length, 3);
      assert.ok(deliveries.every(item => item.source.platform === 'btw' && item.source.channelUserId === 'btw'));
    }, false, undefined, undefined, async (source, text) => { deliveries.push({ source, text }); });
  } finally {
    (llm as any).chat = originalChat;
    (llm as any).executeTools = originalExecuteTools;
  }
});

test('bound worker host closes reminders, awaits automatic compaction, and rejects background commits', async () => {
  const compactSession = baseSession('exact-worker-compact'); compactSession.compactThresholdTokens = 10;
  await withLocalHost(compactSession, async ({ turnHost, session, readDurable }) => {
    await turnHost.checkAndCompactIfNeeded(session.id, undefined);
    await turnHost.checkAndCompactIfNeeded(session.id, { inputTokens: 10 });
    await turnHost.checkAndCompactIfNeeded(session.id, { inputTokens: 11 });
    await turnHost.processSessionCompactionRequest(session.id, {});
    await assert.rejects(() => turnHost.applyCompletedCompactJob(session.id), assertRpcCode('SESSION_WORKER_COMPACTION_UNSUPPORTED'));
    assert.equal(readDurable().history.length, 0);
  });

  const initial = baseSession('exact-worker-child'); initial.parentSessionId = 'parent-session';
  const sessionsFileBefore = await fs.pathExists(SESSIONS_FILE) ? await fs.readFile(SESSIONS_FILE) : null;
  const originalChat = llm.chat;
  let calls = 0;
  (llm as any).chat = async (parts: any, session: Session, _iteration: number, options: any) => {
    calls += 1;
    if (parts) await options.appendMessage({ role: 'user', parts });
    const reminderTurn = JSON.stringify(parts ?? session.history.at(-1)?.parts).includes('child-reminder');
    await options.appendMessage({ role: 'model', parts: [{ text: reminderTurn ? '[NO_ACTION]' : 'ordinary child answer' }] });
    if (!reminderTurn) await options.currentSessionEffects.startWait(session, {});
    return { text: reminderTurn ? '[NO_ACTION]' : 'ordinary child answer' };
  };
  try {
    await withLocalHost(initial, async ({ host, store, session }) => {
      store.enqueueIntent(initial.id, 'ordinary', 'enqueue', { type: 'user', parts: [{ text: 'work' }] });
      await host.runPending(8);
      for (let index = 0; index < 40 && calls < 2; index += 1) await new Promise(resolve => setTimeout(resolve, 5));
      const reminders = session.history.filter(message => JSON.stringify(message.parts).includes('kind=\\"child-reminder\\"'));
      assert.equal(calls, 2);
      assert.equal(reminders.length, 1);
      assert.equal(session.queue.length, 0);
      assert.equal(session.meta.wait, undefined);
      assert.equal(await sessionManager.getExistingSession(session.id), null);
    }, true);
  } finally { (llm as any).chat = originalChat; }
  const sessionsFileAfter = await fs.pathExists(SESSIONS_FILE) ? await fs.readFile(SESSIONS_FILE) : null;
  assert.deepEqual(sessionsFileAfter, sessionsFileBefore);
});

test('Worker post-final child-reminder persistence failure resyncs authority without a second final', async () => {
  const initial = baseSession('worker-post-final-reminder-failure');
  initial.parentSessionId = 'parent-session';
  const originalChat = llm.chat;
  const finals: Array<{ text: string; outcome: string }> = [];
  let latestProjection: any;
  let reminderPersistFailed = false;
  (llm as any).chat = async (parts: any, _session: Session, _iteration: number, options: any) => {
    if (parts) await options.appendMessage({ role: 'user', parts });
    await options.appendMessage({ role: 'model', parts: [{ text: 'provider success' }] });
    return { text: 'provider success' };
  };
  try {
    await withLocalHost(initial, async ({ host, store, readDurable }) => {
      const persistence = (host as any).persistence;
      const persistActivated = persistence.persistActivated.bind(persistence);
      persistence.persistActivated = async (session: Session, ...args: any[]) => {
        if (!reminderPersistFailed && session.queue.some(item => JSON.stringify(item).includes('child-reminder'))) {
          reminderPersistFailed = true;
          throw new Error('reminder authority write failed');
        }
        return persistActivated(session, ...args);
      };
      store.enqueueIntent(initial.id, 'post-final-reminder', 'enqueue', {
        type: 'user', source: { platform: 'test', channelUserId: 'room' }, parts: [{ text: 'work' }],
      });
      await host.runPending(8);
      assert.equal(reminderPersistFailed, true);
      assert.deepEqual(finals, [{ text: 'provider success', outcome: 'response' }]);
      assert.deepEqual(readDurable().history.map((message: any) => message.role), ['user', 'model']);
      assert.equal(JSON.stringify(readDurable().history).includes('reminder authority write failed'), false);
      assert.equal(readDurable().queue.length, 0);
      assert.equal(readDurable().busy, false);
      assert.equal(latestProjection.messageCount, 2);
      assert.equal(latestProjection.queueLength, 0);
      assert.equal(latestProjection.busy, false);
    }, true,
      async projection => { latestProjection = structuredClone(projection); },
      async (_source, text, outcome) => { finals.push({ text, outcome }); });
  } finally { (llm as any).chat = originalChat; }
});

test('postcommit publication failure preserves authority and poisons later mutation', async () => {
  const initial = baseSession('publication-postcommit'); let publishes = 0;
  await withLocalHost(initial, async ({ host, session, turnHost, readDurable }) => {
    await host.runPending(8); assert.equal(publishes, 1);
    await assert.rejects(() => turnHost.currentSessionEffects.updateBusy(session, true), assertRpcCode('SESSION_WORKER_PUBLICATION_RESYNC_REQUIRED'));
    assert.equal(readDurable().busy, true); assert.equal(session.busy, true);
    session.model = 'uncommitted-later';
    await assert.rejects(() => (host as any).persistOwner(), assertRpcCode('SESSION_WORKER_PUBLICATION_RESYNC_REQUIRED'));
    assert.equal(session.model, undefined); assert.equal(session.busy, true);
  }, false, async () => { publishes += 1; if (publishes > 1) throw new Error('publication reply lost'); });
});

test('real activated child runs durable mailbox through canonical SessionTurnRunner', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-worker-host-'));
  const sessionId = 'worker-host-real-child';
  const dbPath = path.join(root, 'session-runtime.sqlite');
  const statePath = path.join(root, 'state', 'sessions', `${sessionId}.json`);
  await fs.outputJson(statePath, serializeSessionHistoryPayload(baseSession(sessionId)));
  await fs.outputFile(path.join(getAgentDir('main'), 'worker-send.txt'), 'worker-master-file');
  const store = new SessionWorkerStore(dbPath); store.open();
  const incarnationId = 'runtime-test-incarnation';
  const ownership = store.beginGeneration(sessionId, incarnationId);
  const externalOriginals = {
    getNode: nodesManager.getNode, executeTool: nodesManager.executeTool,
    listNodesWithTools: nodesManager.listNodesWithTools, setCurrentNode: nodesManager.setCurrentNode,
    readFileFromNode: nodesManager.readFileFromNode, writeFileToNode: nodesManager.writeFileToNode,
    sendFileToSession: sessionManager.sendFileToSession, sendFileToChannelTargetId: sessionManager.sendFileToChannelTargetId,
    listServers: mcpClient.listServers, callTool: mcpClient.callTool, vectorSearch: vector.search,
  };
  const externalCalls: any[] = [];
  (nodesManager as any).getNode = (nodeId: string) => ({ id: nodeId, ws: {}, tools: new Set(['read']) });
  (nodesManager as any).executeTool = async (...args: any[]) => { externalCalls.push(['node', ...args]); return { node: args[0], tool: args[1] }; };
  (nodesManager as any).listNodesWithTools = () => [{ id: 'master', type: 'master', tools: [{ name: 'read', description: 'read', parameters: { type: 'object' } }] },
    { id: 'reverse-node', type: 'node', tools: [{ name: 'read', description: 'remote read', parameters: { type: 'object' } }] }];
  (nodesManager as any).setCurrentNode = () => {};
  (nodesManager as any).readFileFromNode = async () => ({ dataBase64: 'c2VjcmV0LWJ5dGVz', sizeBytes: 12,
    sha256: createHash('sha256').update('secret-bytes').digest('hex') });
  (nodesManager as any).writeFileToNode = async () => ({ sha256: 'a'.repeat(64), overwritten: false, absolutePath: '/remote/to.txt' });
  (sessionManager as any).sendFileToSession = async () => ({ deliveredChannels: ['telegram:session'], skippedChannels: [] as any[], failedChannels: [] as any[] });
  (sessionManager as any).sendFileToChannelTargetId = async () => {};
  (mcpClient as any).listServers = async () => [{ name: 'reverse-mcp', enabled: true, transport: 'http', argsCount: 0,
    envKeys: [] as string[], headerKeys: [] as string[], hasToken: false }];
  (mcpClient as any).callTool = async (...args: any[]) => { externalCalls.push(['mcp', ...args]); return { echoed: args[2] }; };
  (vector as any).search = async (...args: any[]) => { externalCalls.push(['vector', ...args]); return [{ id: 'reverse-hit' }]; };
  const child = fork(path.join(__dirname, 'sessionWorkerRuntimeTestChild.js'), [], {
    env: {
      ...process.env,
      FOXWARM_DATA_DIR: root,
      FOXWARM_SESSION_WORKER_SESSION_ID: sessionId,
      FOXWARM_SESSION_WORKER_GENERATION: String(ownership.generation),
      FOXWARM_SESSION_WORKER_INCARNATION_ID: incarnationId,
      FOXWARM_SESSION_WORKER_STORE_PATH: dbPath,
      FOXWARM_TEST_FAIL_WRITE_AT: '2',
      FOXWARM_TEST_FAIL_GOAL: '1',
      FOXWARM_TEST_WAIT_TOOL: '1',
      FOXWARM_TEST_EXTERNAL_REVERSE: '1',
      FOXWARM_TEST_PUBLICATION_TOOL: '1',
    },
    serialization: 'advanced',
  });
  const transport = new ProcessRpcClientTransport(child, { generation: ownership.generation });
  const reverseRegistry = new RpcServiceRegistry();
  const projectionRegistry = new SessionWorkerProjectionRegistry();
  const publicationIdentity = { sessionId, generation: ownership.generation, incarnationId };
  projectionRegistry.establish(publicationIdentity);
  let failPublicationAfter = 0;
  const published: any[] = []; projectionRegistry.subscribe(entry => {
    published.push(entry); if (failPublicationAfter > 0 && --failPublicationAfter === 0) throw new Error('publication reply disconnected');
  });
  reverseRegistry.register(mainManagementToolServiceDescriptor, createMainManagementToolServiceHandler({ expectedSourceSessionId: sessionId }));
  reverseRegistry.register(nodeExecutionServiceDescriptor, createNodeExecutionServiceHandler({ expectedSourceSessionId: sessionId }));
  reverseRegistry.register(fileDeliveryServiceDescriptor, createFileDeliveryServiceHandler({ expectedSourceSessionId: sessionId }));
  const committedFinals: any[] = [];
  reverseRegistry.register(sessionTurnDeliveryServiceDescriptor, createSessionTurnDeliveryServiceHandler({
    expectedSourceSessionId: sessionId,
    resolveExactSourceContext: async () => ({
      platform: 'test', channelId: 'test', channelType: 'test', channelUserId: 'conversation', conversationId: 'conversation',
      preferDirectReply: true, username: undefined, senderId: undefined,
      reply: async (text: string, options?: any) => {
        committedFinals.push({ text, options, authority: await fs.readJson(statePath), projection: projectionRegistry.get(sessionId)?.projection });
      },
      sendTyping: async () => {},
    }),
  }));
  reverseRegistry.register(sessionWorkerPublicationServiceDescriptor, createSessionWorkerPublicationServiceHandler({ expected: publicationIdentity, registry: projectionRegistry }));
  reverseRegistry.register(mcpExternalServiceDescriptor, createMcpExternalServiceHandler({ expectedSourceSessionId: sessionId }));
  reverseRegistry.register(vectorServiceDescriptor, createVectorFacadeProxyHandler());
  const reverseServer = new ProcessRpcServer(reverseRegistry, {
    generation: ownership.generation, peer: child, direction: 'reverse', exitOnDisconnect: false,
  });
  reverseServer.start();
  try {
    await transport.waitUntilReady();
    const control = new RpcClient(sessionWorkerControlServiceDescriptor, transport);
    const runtime = new RpcClient(sessionWorkerRuntimeServiceDescriptor, transport);
    await assert.rejects(() => runtime.call('runPending', { limit: 8 }), assertRpcCode('SESSION_WORKER_NOT_ACTIVATED'));
    const processIdentity = readSessionWorkerProcessIdentity(child.pid!);
    assert.ok(processIdentity);
    store.registerCandidate(sessionId, ownership.generation, incarnationId, child.pid!, processIdentity!);
    store.activateCandidate(sessionId, ownership.generation, incarnationId, child.pid!, processIdentity!);
    await control.call('activate', {});
    await assert.rejects(() => runtime.call('runPending', { limit: 0 }), assertRpcCode('SESSION_WORKER_MAILBOX_LIMIT'));

    const intent = store.enqueueIntent(sessionId, 'first-input', 'enqueue', {
      type: 'user',
      source: { platform: 'test', channelId: 'test', channelType: 'test', channelUserId: 'conversation', conversationId: 'conversation', preferDirectReply: true },
      parts: [{ text: 'child input' }],
    });
    await assert.rejects(() => runtime.call('runPending', { limit: 8 }), /test write failure 2/);
    assert.equal(store.getOwnership(sessionId).mailboxCursor, intent.id);
    const afterFailedClaim = await fs.readJson(statePath);
    assert.equal(afterFailedClaim.lastAppliedMailboxId, intent.id);
    assert.equal(afterFailedClaim.queue.length, 1);
    assert.equal(afterFailedClaim.busy, false);
    assert.equal(afterFailedClaim.history.length, 0);

    const projection = await runtime.call('runPending', { limit: 8 });
    assert.ok(published.length >= 2);
    assert.equal(published[0].projection.messageCount, 0);
    assert.equal(published[0].projection.queueLength, 0);
    assert.equal(published.some(entry => entry.projection.busy === true), true);
    assert.equal(published.at(-1).projection.busy, false);
    assert.equal(projectionRegistry.get(sessionId)?.stale, false);
    assert.equal(Object.prototype.hasOwnProperty.call(projectionRegistry.get(sessionId)?.projection || {}, 'stateRevision'), false);
    assert.equal(projection.lastAppliedMailboxId, intent.id);
    assert.equal(projection.busy, false);
    assert.equal(projection.queueLength, 0);
    assert.equal(projection.messageCount, 2);
    assert.equal(committedFinals[0].text, 'deterministic child answer');
    assert.equal(committedFinals[0].authority.history.at(-1).parts[0].text, 'deterministic child answer');
    assert.equal(committedFinals[0].projection.messageCount, 2);
    assert.equal(committedFinals[0].authority.busy, true);
    assert.equal(committedFinals[0].projection.busy, true);
    assert.equal(committedFinals[0].options.turnFinal, true);
    const durable = await fs.readJson(statePath);
    assert.deepEqual(durable.history.map((message: any) => message.role), ['user', 'model']);
    assert.equal(durable.contextFrontier.length, 2);
    assert.equal(durable.queue.length, 0);
    assert.equal(durable.busy, false);
    const archive = new DatabaseSync(path.join(root, 'state', 'archive-store.sqlite'), { readOnly: true });
    try {
      const rows = archive.prepare('SELECT role FROM archive_messages WHERE session_id=? ORDER BY seq').all(sessionId) as Array<{ role: string }>;
      assert.deepEqual(rows.map(row => row.role), ['user', 'model']);
    } finally { archive.close(); }

    projection.stats.totalInputTokens = 999;
    const publicationCountBeforeNoop = published.length;
    const clonedProjection = await runtime.call('runPending', { limit: 8 });
    assert.notEqual(clonedProjection.stats.totalInputTokens, 999);
    assert.equal(published.length, publicationCountBeforeNoop + 2);
    assert.deepEqual(published.slice(-2).map(entry => entry.projection.busy), [true, false]);

    store.enqueueIntent(sessionId, 'goal-fault', 'enqueue', { type: 'user', parts: [{ text: 'set-goal-fault' }] });
    await runtime.call('runPending', { limit: 8 });
    const afterGoalFault = await fs.readJson(statePath);
    assert.equal(afterGoalFault.goalState, undefined);
    assert.match(afterGoalFault.history.at(-1).parts[0].text, /reported tool failure: test goal persistence failure/);

    await sessionManager.getSession(sessionId);
    store.enqueueIntent(sessionId, 'reverse-wait', 'enqueue', { type: 'user', parts: [{ text: 'wait through reverse RPC' }] });
    const waitingProjection = await runtime.call('runPending', { limit: 8 });
    const afterWait = await fs.readJson(statePath);
    assert.equal(waitingProjection.runtimeState.state, 'waiting');
    assert.equal(afterWait.meta.wait.reason, 'reverse wait');
    const waitTimer = (await fs.readJson(TIMERS_FILE)).timers.find((timer: any) => timer.waitTimeoutId === afterWait.meta.wait.id);
    assert.equal(waitTimer?.waitTimeoutSeconds, 30);
    assert.deepEqual(externalCalls.map(call => call[0]), ['node', 'mcp', 'vector']);
    assert.deepEqual(externalCalls[0].slice(1, 5), ['reverse-node', 'read', { filePath: 'reverse.txt' }, sessionId]);
    assert.equal(externalCalls[1][1], 'reverse-mcp');
    assert.equal(externalCalls[2][1], 'reverse vector query');
    assert.match(afterWait.history.at(-1).parts[0].text, /"fenceErrors":\["NODE_EXECUTION_SOURCE_MISMATCH","NODE_EXECUTION_SOURCE_MISMATCH","FILE_DELIVERY_SOURCE_MISMATCH","SESSION_TURN_DELIVERY_SOURCE_MISMATCH","MCP_EXTERNAL_SOURCE_MISMATCH"\]/);
    assert.match(afterWait.history.at(-1).parts[0].text, /"defaultCwd":"node process cwd/);
    assert.match(afterWait.history.at(-1).parts[0].text, new RegExp(`"sha256":"${'a'.repeat(64)}"`));
    assert.match(afterWait.history.at(-1).parts[0].text, /ready for WebUI target/);
    assert.match(afterWait.history.at(-1).parts[0].text, /Delivered: 1/);
    assert.match(afterWait.history.at(-1).parts[0].text, /telegram:room/);
    assert.equal(projectionRegistry.get(sessionId)?.projection?.currentNode, 'reverse-node');
    assert.equal(projectionRegistry.get(sessionId)?.projection?.lastAppliedMailboxId, afterWait.lastAppliedMailboxId);
    assert.equal(projectionRegistry.get(sessionId)?.projection?.queueLength, afterWait.queue.length);
    assert.deepEqual(projectionRegistry.get(sessionId)?.projection?.stats, afterWait.stats);
    assert.doesNotMatch(afterWait.history.at(-1).parts[0].text, /c2VjcmV0LWJ5dGVz/);
    assert.match(afterWait.history.at(-1).parts[0].text, /reverse-hit/);
    assert.match(afterWait.history.at(-1).parts[0].text, /"loadedLocalVectorOwner":false/);
    if (waitTimer) await timers.deleteTimer(waitTimer.id, sessionId);

    const accessor: Record<string, unknown> = { type: 'user' };
    Object.defineProperty(accessor, 'parts', { enumerable: true, get() { throw new Error('accessor ran'); } });
    assert.throws(() => store.enqueueIntent(sessionId, 'accessor', 'enqueue', accessor), /enumerable data properties/);

    const ambiguous = store.enqueueIntent(sessionId, 'publication-disconnect', 'enqueue', { type: 'user', parts: [{ text: 'commit tool mutation before lost reply' }] });
    failPublicationAfter = 5;
    await assert.rejects(() => runtime.call('runPending', { limit: 8 }), assertRpcCode('SESSION_WORKER_PUBLICATION_RESYNC_REQUIRED'));
    const committedBeforeDisconnect = await fs.readJson(statePath);
    assert.equal(committedBeforeDisconnect.lastAppliedMailboxId, ambiguous.id);
    assert.equal(committedBeforeDisconnect.goalState.goal, 'committed-before-publication-loss');
    assert.equal(committedBeforeDisconnect.history.length, afterWait.history.length + 1);
    const archiveAfterFailure = new DatabaseSync(path.join(root, 'state', 'archive-store.sqlite'), { readOnly: true });
    const archiveCount = Number((archiveAfterFailure.prepare('SELECT COUNT(*) AS count FROM archive_messages WHERE session_id=?').get(sessionId) as any).count);
    archiveAfterFailure.close();
    assert.equal(archiveCount, committedBeforeDisconnect.history.length);
    assert.equal(projectionRegistry.get(sessionId)?.stale, true);
    const blocked = store.enqueueIntent(sessionId, 'blocked-after-publication', 'enqueue', { type: 'background', parts: [{ text: 'must remain uncommitted' }] });
    await assert.rejects(() => runtime.call('runPending', { limit: 8 }), assertRpcCode('SESSION_WORKER_PUBLICATION_RESYNC_REQUIRED'));
    assert.ok(blocked.id > store.getOwnership(sessionId).mailboxCursor);
    assert.equal((await fs.readJson(statePath)).history.length, committedBeforeDisconnect.history.length);
    const archiveAfterBlocked = new DatabaseSync(path.join(root, 'state', 'archive-store.sqlite'), { readOnly: true });
    assert.equal(Number((archiveAfterBlocked.prepare('SELECT COUNT(*) AS count FROM archive_messages WHERE session_id=?').get(sessionId) as any).count), archiveCount);
    archiveAfterBlocked.close();
    child.disconnect();

  } finally {
    (nodesManager as any).getNode = externalOriginals.getNode;
    (nodesManager as any).executeTool = externalOriginals.executeTool;
    (nodesManager as any).listNodesWithTools = externalOriginals.listNodesWithTools;
    (nodesManager as any).setCurrentNode = externalOriginals.setCurrentNode;
    (nodesManager as any).readFileFromNode = externalOriginals.readFileFromNode;
    (nodesManager as any).writeFileToNode = externalOriginals.writeFileToNode;
    (sessionManager as any).sendFileToSession = externalOriginals.sendFileToSession;
    (sessionManager as any).sendFileToChannelTargetId = externalOriginals.sendFileToChannelTargetId;
    (mcpClient as any).listServers = externalOriginals.listServers;
    (mcpClient as any).callTool = externalOriginals.callTool;
    (vector as any).search = externalOriginals.vectorSearch;
    try { await transport.drain(2_000); } catch {}
    try { await reverseServer.drain(2_000); } catch {}
    reverseServer.close();
    transport.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
    store.close();
    await fs.remove(root);
  }
});
