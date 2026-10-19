import './testEnvironment';
import { parseFoxwarmOpeningTag } from './utils/promptWrappers';
import * as llm from './llm';
import * as nodeExecution from './nodeExecution';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import * as config from './config';
import { loadModelsConfigFromObject } from './config';
import { initArchiveStore } from './session/archiveStore';
import { readSessionHistorySnapshot } from './session/metadataStore';
import { writeAuthoritativeSessionState } from './session/stateFile';
import { reconstructLlmRequest } from './llmRequestJournal';
import { SessionWorkerHost } from './sessionWorkerHost';
import { SessionWorkerStore } from './sessionWorkerStore';
import { createSessionWorkerRuntimeServiceHandler, sessionWorkerRuntimeServiceDescriptor } from './sessionWorkerRuntimeService';
import { LocalRpcTransport, RpcClient, RpcServiceRegistry } from './rpc';
import type { Message, Session } from './types';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

function sendAnswer(response: http.ServerResponse) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.end('data: {"choices":[{"delta":{"content":"selection answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
}

function seedSession(id: string): Session {
  return {
    id, agent: 'main', model: 'fixture/a', effort: 'high',
    promptCacheKey: randomUUID(),
    history: [], persistentMemorySnapshot: '<foxwarm-current-model model-id="fixture/a" />\n\noriginal model memory',
    systemPromptFiles: [], busy: false, queue: [],
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    meta: { lastMessageTime: 0 }, lastAppliedMailboxId: 0,
  };
}

async function workerFixture(initial: Session) {
  await initArchiveStore();
  await writeAuthoritativeSessionState(initial);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-selection-worker-'));
  const store = new SessionWorkerStore(path.join(root, 'runtime.sqlite'));
  store.open();
  const incarnationId = 'selection-incarnation';
  const ownership = store.beginGeneration(initial.id, incarnationId);
  store.registerCandidate(initial.id, ownership.generation, incarnationId, process.pid, 'selection-process');
  store.activateCandidate(initial.id, ownership.generation, incarnationId, process.pid, 'selection-process');
  const host = new SessionWorkerHost({ sessionId: initial.id, generation: ownership.generation,
    incarnationId, pid: process.pid, processIdentity: 'selection-process' }, store);
  const registry = new RpcServiceRegistry();
  registry.register(sessionWorkerRuntimeServiceDescriptor, createSessionWorkerRuntimeServiceHandler({ assertActive() {} } as any, host));
  const transport = new LocalRpcTransport(registry);
  const client = new RpcClient(sessionWorkerRuntimeServiceDescriptor, transport);
  await client.call('loadProjection', {});
  return { store, host, client, async close() { transport.close(); store.close(); await fs.remove(root); } };
}

for (const destination of ['fixture/b', 'selected-route']) {
  test(`Worker retry applies ${destination} through its existing safe point past ordinary runPending placeholders`, { timeout: 20_000 }, async () => {
    const firstSent = deferred<http.ServerResponse>();
    const retrySent = deferred<http.ServerResponse>();
    const requests: any[] = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      if (requests.length === 1) firstSent.resolve(response);
      else retrySent.resolve(response);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const models = loadModelsConfigFromObject({ default: 'fixture/a', providers: {
      fixture: { providerType: 'openai-completions', baseUrl, apiKey: 'synthetic-key', models: [
        { id: 'a', effort: { allowed: ['high'], default: 'high' } },
        { id: 'b', effort: { allowed: destination === 'fixture/b' ? ['none', 'high'] : ['none'], default: 'none' } },
      ] },
      'selected-route': 'fixture/b',
    } });
    const originals = { load: config.loadModelsConfig, resolve: config.resolveModelConfig };
    (config as any).loadModelsConfig = () => models;
    (config as any).resolveModelConfig = (model?: string) => {
      const currentKey = model || models.default;
      return { modelsConfig: models, defaultKey: models.default, currentKey, modelEntry: models.models[currentKey] };
    };
    const initial = seedSession(`selection_retry_${Date.now()}`);
    const fixture = await workerFixture(initial);
    let running: Promise<unknown> | undefined;
    let followup: Promise<unknown> | undefined;
    let finalResponse: http.ServerResponse | undefined;
    try {
      fixture.store.enqueueIntent(initial.id, 'initial', 'enqueue', { type: 'user', parts: [{ text: 'initial input' }] });
      running = fixture.client.call('runPending', { limit: 8 });
      const firstResponse = await firstSent.promise;
      fixture.store.enqueueIntent(initial.id, 'correction', 'enqueue', { type: 'user', parts: [{ text: 'ordinary correction' }] });
      let followupSettled = false;
      followup = fixture.client.call('runPending', { limit: 8 }).then(result => { followupSettled = true; return result; });
      const invalid = fixture.client.call('updateSettings', { patch: { model: destination, effort: 'max' } });
      const invalidCheck = assert.rejects(invalid, { code: 'SESSION_WORKER_SETTINGS_INVALID' });
      const changed = fixture.client.call('updateSettings', { patch: { model: destination, ...(destination === 'fixture/b' ? { effort: 'none' as const } : {}) } });
      firstResponse.writeHead(503); firstResponse.end('retry selection');
      const settings = await changed;
      await invalidCheck;
      assert.equal(settings.current.model, destination);
      assert.equal(settings.current.effort, destination === 'fixture/b' ? 'none' : null,
        'the next attempt uses the same normalized model/effort pair, including incompatible-override clearing');
      assert.equal(followupSettled, false, 'a transparent runPending placeholder still awaits turn completion');
      finalResponse = await retrySent.promise;
      assert.equal(requests.length, 2);
      assert.deepEqual(requests.map(body => [body.model, body.reasoning_effort]), [['a', 'high'], ['b', 'none']]);
      const payload = JSON.stringify(requests[1]);
      assert.equal(payload.split('session-settings-changed').length - 1, 1);
      assert.equal(payload.split('ordinary correction').length - 1, 1);
      assert.ok(payload.indexOf('ordinary correction') < payload.indexOf('session-settings-changed'));
      assert.equal(payload.includes('actorSessionId'), false);
      assert.match(payload, /foxwarm-current-model.*fixture\/b/);
      assert.equal(payload.includes('original model memory'), false);
      assert.equal(followupSettled, false);
      sendAnswer(finalResponse);
      await running; await followup;
      const durable = await readSessionHistorySnapshot(initial.id);
      assert.equal(durable.promptCacheKey, initial.promptCacheKey);
      assert.equal(durable.queue.length, 0);
      const final: Message = durable.history.find((message: Message) => message.parts.some(part => part.text === 'selection answer'));
      assert.equal(final.__meta?.modelId, 'fixture/b');
      assert.equal(final.__meta?.virtualModelKey, destination === 'selected-route' ? destination : undefined);
      const journal = await reconstructLlmRequest(final.__meta!.llmRequestId!);
      assert.equal(journal.completeness, 'complete');
      if (journal.completeness === 'complete') {
        assert.equal(journal.requestedModelKey, destination);
        assert.equal(journal.attempts.length, 1);
        assert.equal(JSON.stringify(journal.messages).split('session-settings-changed').length - 1, 1);
      }
    } finally {
      if (finalResponse && !finalResponse.writableEnded) sendAnswer(finalResponse);
      server.closeAllConnections();
      await running?.catch(() => {}); await followup?.catch(() => {});
      await fixture.close();
      (config as any).loadModelsConfig = originals.load;
      (config as any).resolveModelConfig = originals.resolve;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
}

for (const wake of ['ordinary', 'dequeue']) {
  test(`a real node-select plus wait does not enqueue a raw notice, and generic passive input waits for ${wake}`, async () => {
    const initial = seedSession(`selection_wait_tools_${Date.now()}`);
    const fixture = await workerFixture(initial);
    const originalChat = llm.chat;
    const originalValidate = nodeExecution.validateNodeSelection;
    let calls = 0;
    const contexts: string[] = [];
    (nodeExecution as any).validateNodeSelection = async () => ({ nodeId: 'fixture-node', defaultCwd: 'fixture://cwd' });
    (llm as any).chat = async (_parts: any, owner: Session, _iteration: number, options: any) => {
      contexts.push(JSON.stringify(owner.history));
      calls++;
      if (calls === 1) {
        const toolCalls = [
          { id: 'selection', name: 'node', args: { action: 'select', nodeId: 'fixture-node' } },
          { id: 'waiting', name: 'wait', args: { waitForInput: true, reason: 'after selection' } },
        ];
        await options.appendMessage({ role: 'model', parts: toolCalls.map(functionCall => ({ functionCall })) });
        return { toolCalls };
      }
      await options.appendMessage({ role: 'model', parts: [{ text: 'resumed answer' }] });
      return { text: 'resumed answer' };
    };
    try {
      fixture.store.enqueueIntent(initial.id, 'initial', 'enqueue', { type: 'user', parts: [{ text: 'select then wait' }] });
      await fixture.client.call('runPending', { limit: 8 });
      assert.equal(calls, 1, 'a passive selection notice must not start another turn after wait');
      let durable = await readSessionHistorySnapshot(initial.id);
      assert.equal(durable.meta.wait.reason, 'after selection');
      assert.equal(durable.queue.length, 0, 'node select must not leave a raw settings notice');
      fixture.store.enqueueIntent(initial.id, 'passive', 'enqueue', { type: 'background', trigger: false,
        parts: [{ system: 'fixture passive input' }] });
      await fixture.client.call('runPending', { limit: 8 });
      assert.equal(calls, 1);
      durable = await readSessionHistorySnapshot(initial.id);
      assert.equal(durable.queue.length, 1);
      assert.deepEqual(durable.history.map((message: Message) => message.role), ['user', 'model', 'tool']);
      if (wake === 'dequeue') {
        await fixture.client.call('dequeue', {});
      } else {
        fixture.store.enqueueIntent(initial.id, 'wake', 'enqueue', { type: 'user', parts: [{ text: 'ordinary wake' }] });
        await fixture.client.call('runPending', { limit: 8 });
        assert.ok(contexts[1].indexOf('fixture passive input') < contexts[1].indexOf('ordinary wake'));
      }
      assert.equal(calls, 2, 'a real wake or explicit Run queued may consume the passive prefix');
      durable = await readSessionHistorySnapshot(initial.id);
      assert.equal(durable.meta.wait, undefined);
      assert.equal(durable.queue.length, 0);
      assert.equal(contexts[1].split('fixture passive input').length - 1, 1);
    } finally {
      (llm as any).chat = originalChat;
      (nodeExecution as any).validateNodeSelection = originalValidate;
      await fixture.close();
    }
  });
}

test('Worker selection settings do not bypass a pending history mutation', async () => {
  const initial = seedSession(`selection_history_barrier_${Date.now()}`);
  const fixture = await workerFixture(initial);
  const entered = deferred();
  const release = deferred();
  const originalChat = llm.chat;
  const seenModels: Array<string | undefined> = [];
  (llm as any).chat = async (_parts: any, owner: Session, _iteration: number, options: any) => {
    seenModels.push(owner.model);
    if (seenModels.length === 1) { entered.resolve(); await release.promise; }
    await options.appendMessage({ role: 'model', parts: [{ text: 'barrier answer' }] });
    return { text: 'barrier answer' };
  };
  let running: Promise<unknown> | undefined;
  let followup: Promise<unknown> | undefined;
  try {
    fixture.store.enqueueIntent(initial.id, 'initial', 'enqueue', { type: 'user', parts: [{ text: 'initial input' }] });
    running = fixture.client.call('runPending', { limit: 8 });
    await entered.promise;
    fixture.store.enqueueIntent(initial.id, 'ordinary', 'enqueue', { type: 'user', parts: [{ text: 'ordinary followup' }] });
    followup = fixture.client.call('runPending', { limit: 8 });
    const clearing = fixture.client.call('clearHistory', {});
    const selecting = fixture.client.call('updateSettings', { patch: { model: 'fixture/b' } });
    release.resolve();
    await running; await followup;
    const cleared = await clearing;
    const selected = await selecting;
    assert.deepEqual(seenModels, ['fixture/a', 'fixture/a']);
    assert.equal(cleared.projection.messageCount, 0);
    assert.equal(selected.current.model, 'fixture/b');
    const durable = await readSessionHistorySnapshot(initial.id);
    assert.equal(durable.history.length, 0);
    assert.equal(durable.queue.length, 0);
  } finally {
    release.resolve(); await running?.catch(() => {}); await followup?.catch(() => {});
    (llm as any).chat = originalChat;
    await fixture.close();
  }
});

for (const changePolicy of [false, true]) test(`automatic failover puts one effective notice into the next attempt${changePolicy ? ' after a same-leaf policy change' : ''}`, { timeout: 20_000 }, async () => {
  const requests: any[] = [];
  const firstSent = deferred<http.ServerResponse>();
  const routeKey = changePolicy ? 'new-failover-policy' : 'selected-route';
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    if (requests.length === 1) firstSent.resolve(response);
    else if (requests.at(-1).model === 'a') { response.writeHead(503); response.end('first leaf unavailable'); }
    else sendAnswer(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const models = loadModelsConfigFromObject({ default: routeKey, providers: {
    fixture: { providerType: 'openai-completions', baseUrl, apiKey: 'synthetic-key', models: [
      { id: 'a', effort: { allowed: ['high'], default: 'high' } },
      { id: 'b', effort: { allowed: ['none'], default: 'none' } },
    ] },
    [routeKey]: { providerType: 'failover', targets: ['fixture/a', 'fixture/b'], failureThreshold: 1, cooldownMs: 60_000 },
  } });
  const originals = { load: config.loadModelsConfig, resolve: config.resolveModelConfig };
  (config as any).loadModelsConfig = () => models;
  (config as any).resolveModelConfig = (model?: string) => ({ modelsConfig: models, defaultKey: models.default,
    currentKey: model || models.default, modelEntry: models.models[model || models.default] });
  const initial = seedSession(`effective_failover_${Date.now()}`);
  initial.model = changePolicy ? 'fixture/a' : routeKey;
  const fixture = await workerFixture(initial);
  let running: Promise<unknown> | undefined;
  try {
    fixture.store.enqueueIntent(initial.id, 'initial', 'enqueue', { type: 'user', parts: [{ text: 'use effective failover' }] });
    running = fixture.client.call('runPending', { limit: 8 });
    const firstResponse = await firstSent.promise;
    const selected = changePolicy ? fixture.client.call('updateSettings', { patch: { model: routeKey } }) : undefined;
    firstResponse.writeHead(503); firstResponse.end('first leaf unavailable');
    await selected; await running;
    assert.deepEqual(requests.map(body => [body.model, body.reasoning_effort]),
      changePolicy ? [['a', 'high'], ['a', 'high'], ['b', 'none']] : [['a', 'high'], ['b', 'none']]);
    if (changePolicy) assert.equal(JSON.stringify(requests[1]).includes('session-settings-changed'), false,
      'a same-leaf alias change emits nothing but still installs its new failover policy');
    const payload = JSON.stringify(requests.at(-1));
    assert.equal(payload.split('session-settings-changed').length - 1, 1);
    assert.match(payload, /reason=\\?"failover/);
    assert.match(payload, /oldModel=\\?"fixture\/a/);
    assert.match(payload, /newModel=\\?"fixture\/b/);
    assert.match(payload, /oldEffort=\\?"high/);
    assert.match(payload, /newEffort=\\?"none/);
    const durable = await readSessionHistorySnapshot(initial.id);
    assert.deepEqual(durable.meta.lastEffectiveRequest, { modelId: 'fixture/b', nodeId: 'master', effort: 'none' });
    const notice = durable.history.flatMap((message: Message) => message.parts)
      .find((part: any) => part.system?.includes('kind="session-settings-changed"'));
    assert.equal(parseFoxwarmOpeningTag(notice.system)!.attrs.actorKind, undefined);
    assert.equal(durable.model, routeKey);
    assert.equal(durable.promptCacheKey, initial.promptCacheKey);
    const answer: Message = durable.history.find((message: Message) => message.parts.some(part => part.text === 'selection answer'));
    const journal = await reconstructLlmRequest(answer.__meta!.llmRequestId!);
    assert.equal(journal.completeness, 'complete');
    if (journal.completeness === 'complete') {
      assert.equal(journal.attempts.length, 1, 'the notice joins the existing committed-context rebuild, not another retry loop');
      assert.equal(journal.attempts[0].start.concreteModelId, 'fixture/b');
      assert.equal(JSON.stringify(journal.messages).split('session-settings-changed').length - 1, 1);
    }
  } finally {
    server.closeAllConnections(); await running?.catch(() => {}); await fixture.close();
    (config as any).loadModelsConfig = originals.load; (config as any).resolveModelConfig = originals.resolve;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
