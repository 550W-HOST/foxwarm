import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'fs-extra';
import {
  beginLlmRequestJournal,
  canonicalJournalJson,
  reconstructLlmRequest,
  listLlmRequestJournal,
  setLlmRequestJournalFaultInjectorForTests,
  getLlmRequestJournalStatsForTests,
  getLlmRequestManifestForTests,
  replaceLlmJournalPromptPayloadForTests,
  replaceLlmJournalMessageCountForTests,
  LLM_REQUEST_JOURNAL_DB_PATH,
  replaceLlmJournalCreatedAtForTests,
  appendLlmAttemptStart,
  appendLlmAttemptResult,
  replaceLlmJournalRequestIdentityForTests,
  replaceLlmJournalAttemptStartHashForTests,
  replaceLlmJournalAttemptResultOutcomeForTests,
  exportLlmRequestJournalJsonl,
  LLM_REQUEST_JOURNAL_JSONL_PATH,
} from './llmRequestJournal';
import { ARCHIVE_DB_PATH } from './config';
import { appendMessagesToArchive } from './session/archive';

function unique(prefix: string): string { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2)}`; }

const tools = [{ name: 'echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } } } }];

test('canonical journal JSON is stable across object key insertion order', () => {
  assert.equal(canonicalJournalJson({ b: 2, a: { d: 4, c: 3 } }), canonicalJournalJson({ a: { c: 3, d: 4 }, b: 2 }));
});

test('content objects deduplicate and delta chains checkpoint at the fixed bound', async () => {
  const sessionId = unique('journal_bound');
  const prompt = unique('prompt');
  const message: any = { role: 'user', parts: [{ text: unique('message') }] };
  await beginLlmRequestJournal({ sessionId, systemPrompt: prompt, toolDefinitions: tools as any, messages: [message], requestedModelKey: 'fixture/model', promptCacheKey: 'cache-b' });
  const afterFirst = await getLlmRequestJournalStatsForTests();
  let latest = await beginLlmRequestJournal({ sessionId, systemPrompt: prompt, toolDefinitions: tools as any, messages: [message], requestedModelKey: 'fixture/model', promptCacheKey: 'cache-b' });
  const afterDuplicate = await getLlmRequestJournalStatsForTests();
  assert.equal(afterDuplicate.objects, afterFirst.objects);
  for (let index = 2; index < 10; index += 1) {
    latest = await beginLlmRequestJournal({ sessionId, systemPrompt: prompt, toolDefinitions: tools as any, messages: [message, { role: 'model', parts: [{ text: String(index) }] }] as any, requestedModelKey: 'fixture/model', promptCacheKey: 'cache-b' });
  }
  const manifest = await getLlmRequestManifestForTests(latest.requestId);
  assert.deepEqual(manifest, { deltaDepth: 0, checkpoint: true, baseRequestId: undefined });
  const reconstructed = await reconstructLlmRequest(latest.requestId);
  assert.equal(reconstructed.completeness, 'complete');
});

test('request journal reconstructs checkpoint and bounded delta inputs exactly', async () => {
  const sessionId = unique('journal_delta');
  const firstMessages: any[] = [
    { role: 'user', parts: [{ text: 'one' }] },
    { role: 'model', parts: [{ text: 'two' }] },
  ];
  const first = await beginLlmRequestJournal({ sessionId, purpose: 'normal-turn', systemPrompt: 'system A', toolDefinitions: tools as any, messages: firstMessages, requestedModelKey: 'fixture/model', promptCacheKey: 'cache-a' });
  const secondMessages: any[] = [
    ...firstMessages,
    { role: 'tool', parts: [{ functionResponse: { tool_use_id: 't1', name: 'echo', response: { output: 'three' } } }] },
  ];
  const second = await beginLlmRequestJournal({ sessionId, purpose: 'normal-turn', systemPrompt: 'system A', toolDefinitions: tools as any, messages: secondMessages, requestedModelKey: 'fixture/model', promptCacheKey: 'cache-a' });

  const reconstructedFirst = await reconstructLlmRequest(first.requestId);
  const reconstructedSecond = await reconstructLlmRequest(second.requestId);
  assert.equal(reconstructedFirst.completeness, 'complete');
  assert.equal(reconstructedSecond.completeness, 'complete');
  if (reconstructedFirst.completeness === 'complete') assert.deepEqual(reconstructedFirst.messages, firstMessages);
  if (reconstructedSecond.completeness === 'complete') {
    assert.deepEqual(reconstructedSecond.messages, secondMessages);
    assert.equal(reconstructedSecond.systemPrompt, 'system A');
    assert.deepEqual(reconstructedSecond.toolDefinitions, tools);
    assert.equal(reconstructedSecond.promptCacheKeyHash.startsWith('sha256:'), true);
  }
  const listed = await listLlmRequestJournal({ sessionId, purpose: 'normal-turn' });
  assert.deepEqual(listed.slice(0, 2).map(item => item.requestId), [second.requestId, first.requestId]);
});

test('a pre-SQLite journal failure blocks the provider-bound request manifest', async () => {
  const sessionId = unique('journal_recovery');
  let capturedRequestId = '';
  setLlmRequestJournalFaultInjectorForTests((phase, record: any) => {
    if (phase.startsWith('before-') && record.kind === 'request' && record.sessionId === sessionId) {
      capturedRequestId = record.requestId;
      throw new Error('injected pre-SQLite failure');
    }
  });
  await assert.rejects(beginLlmRequestJournal({ sessionId, purpose: 'low-level', systemPrompt: '', toolDefinitions: [], messages: [{ role: 'user', parts: [{ text: 'recover me' }] }] as any, requestedModelKey: 'fixture/model', promptCacheKey: 'cache-r' }), /injected/);
  setLlmRequestJournalFaultInjectorForTests(null);
  assert.ok(capturedRequestId);
  assert.equal((await reconstructLlmRequest(capturedRequestId)).completeness, 'legacy-partial');
});

test('unknown legacy request is reported partial instead of guessed', async () => {
  const result = await reconstructLlmRequest(unique('legacy'));
  assert.equal(result.completeness, 'legacy-partial');
  if (result.completeness === 'legacy-partial') assert.ok(result.missing.includes('system-prompt'));
});

test('corrupt object hashes and manifest lengths are never reported complete', async () => {
  const request = await beginLlmRequestJournal({ sessionId: unique('journal_corrupt'), systemPrompt: unique('system'), toolDefinitions: [], messages: [{ role: 'user', parts: [{ text: 'one' }] }] as any, requestedModelKey: 'fixture/model', promptCacheKey: 'cache-c' });
  const originalPrompt = await replaceLlmJournalPromptPayloadForTests(request.requestId, JSON.stringify('tampered'));
  assert.equal((await reconstructLlmRequest(request.requestId)).completeness, 'corrupt');
  await replaceLlmJournalPromptPayloadForTests(request.requestId, originalPrompt);
  const originalCount = await replaceLlmJournalMessageCountForTests(request.requestId, 99);
  assert.equal((await reconstructLlmRequest(request.requestId)).completeness, 'corrupt');
  await replaceLlmJournalMessageCountForTests(request.requestId, originalCount);
  assert.equal((await reconstructLlmRequest(request.requestId)).completeness, 'complete');
});

test('corrupt request and attempt identity rows are never reported complete', async () => {
  const request = await beginLlmRequestJournal({ sessionId: unique('journal_row_corrupt'), purpose: 'normal-turn', iteration: 2, systemPrompt: 'row', toolDefinitions: [], messages: [{ role: 'user', parts: [{ text: 'row' }] }] as any, requestedModelKey: 'fixture/model', promptCacheKey: 'cache-row' });
  await appendLlmAttemptStart({ requestId: request.requestId, attempt: 1, concreteModelId: 'fixture/model', providerType: 'anthropic', semanticPayload: { messages: [] } });
  await appendLlmAttemptResult({ requestId: request.requestId, attempt: 1, outcome: 'success', result: { text: 'ok' } });

  const originalRequest = await replaceLlmJournalRequestIdentityForTests(request.requestId, { purpose: 'invalid', promptCacheKeyHash: 'plaintext', iteration: -9 });
  assert.equal((await reconstructLlmRequest(request.requestId)).completeness, 'corrupt');
  await replaceLlmJournalRequestIdentityForTests(request.requestId, originalRequest);

  const originalHash = await replaceLlmJournalAttemptStartHashForTests(request.requestId, 'not-a-digest');
  assert.equal((await reconstructLlmRequest(request.requestId)).completeness, 'corrupt');
  await replaceLlmJournalAttemptStartHashForTests(request.requestId, originalHash);

  const originalOutcome = await replaceLlmJournalAttemptResultOutcomeForTests(request.requestId, 'unknown');
  assert.equal((await reconstructLlmRequest(request.requestId)).completeness, 'corrupt');
  await replaceLlmJournalAttemptResultOutcomeForTests(request.requestId, originalOutcome);
  const restored = await reconstructLlmRequest(request.requestId);
  assert.equal(restored.completeness, 'complete');
  if (restored.completeness === 'complete') assert.equal(restored.attempts[0].result?.outcome, 'success');
});

test('dedicated journal DB supports a second process while ordinary archive writes continue', async () => {
  assert.notEqual(LLM_REQUEST_JOURNAL_DB_PATH, ARCHIVE_DB_PATH);
  const sessionId = unique('journal_concurrency');
  const session: any = { id: sessionId, agent: 'main', history: [], nextMessageSeq: 1, contextFrontier: [] };
  const modulePath = path.join(__dirname, 'llmRequestJournal.js');
  const childCode = `const j=require(${JSON.stringify(modulePath)}); j.beginLlmRequestJournal({sessionId:${JSON.stringify(sessionId)},systemPrompt:'child',toolDefinitions:[],messages:[{role:'user',parts:[{text:'child'}]}],requestedModelKey:'fixture/model',promptCacheKey:'child-cache'}).then(()=>process.exit(0),e=>{console.error(e);process.exit(1)})`;
  const child = spawn(process.execPath, ['-e', childCode], { cwd: process.cwd(), env: { ...process.env, FOXWARM_SYNC_FILE_LOG: '1' }, stdio: ['ignore', 'ignore', 'pipe'] });
  let childError = '';
  child.stderr.on('data', chunk => { childError += String(chunk); });
  const childDone = new Promise<void>((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(childError || `child exit ${code}`))));
  await Promise.all([
    appendMessagesToArchive(session, Array.from({ length: 25 }, (_, index) => ({ role: index % 2 ? 'model' : 'user', parts: [{ text: `archive-${index}` }] })) as any),
    beginLlmRequestJournal({ sessionId, systemPrompt: 'parent', toolDefinitions: [], messages: [{ role: 'user', parts: [{ text: 'parent' }] }] as any, requestedModelKey: 'fixture/model', promptCacheKey: 'parent-cache' }),
    childDone,
  ]);
});

test('normal runtime is SQLite-only and exports compatibility JSONL on demand', async () => {
  await fs.remove(LLM_REQUEST_JOURNAL_JSONL_PATH);
  const request = await beginLlmRequestJournal({ sessionId: unique('sqlite_only'), systemPrompt: 'export', toolDefinitions: [], messages: [{ role: 'user', parts: [{ text: 'export me' }] }] as any, requestedModelKey: 'fixture/model', promptCacheKey: 'cache' });
  await appendLlmAttemptStart({ requestId: request.requestId, attempt: 1, concreteModelId: 'fixture/model', providerType: 'anthropic', semanticPayload: {} });
  await appendLlmAttemptResult({ requestId: request.requestId, attempt: 1, outcome: 'success', result: { text: 'done' } });
  assert.equal(await fs.pathExists(LLM_REQUEST_JOURNAL_JSONL_PATH), false);
  const output = path.join(process.cwd(), '.temp', `${unique('journal_export')}.jsonl`);
  await fs.outputFile(output, 'stale-output-must-be-replaced\n');
  const exported = await exportLlmRequestJournalJsonl(output);
  assert.ok(exported.records >= 4);
  const exportedText = await fs.readFile(output, 'utf8');
  assert.match(exportedText, new RegExp(request.requestId));
  assert.doesNotMatch(exportedText, /stale-output/);
  await fs.remove(output);
});

test('composite pagination is lossless when requests share a millisecond timestamp', async () => {
  const sessionId = unique('journal_pagination');
  const requests: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    requests.push((await beginLlmRequestJournal({ sessionId, systemPrompt: 'page', toolDefinitions: [], messages: [{ role: 'user', parts: [{ text: String(index) }] }] as any, requestedModelKey: 'fixture/model', promptCacheKey: 'page-cache' })).requestId);
  }
  await replaceLlmJournalCreatedAtForTests(requests, 1_785_743_000_000);
  const seen: string[] = [];
  let before: { createdAt: number; requestId: string } | undefined;
  do {
    const page = await listLlmRequestJournal({ sessionId, limit: 2, before });
    if (page.length === 0) break;
    seen.push(...page.map(item => item.requestId));
    const last = page[page.length - 1];
    before = { createdAt: last.createdAt, requestId: last.requestId };
  } while (true);
  assert.equal(new Set(seen).size, requests.length);
  assert.deepEqual(new Set(seen), new Set(requests));
});
