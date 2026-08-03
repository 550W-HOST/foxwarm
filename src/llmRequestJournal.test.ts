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
  resetLlmRequestJournalForTests,
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

test('JSONL remains a recovery source when SQLite insertion fails after append', async () => {
  const sessionId = unique('journal_recovery');
  let capturedRequestId = '';
  setLlmRequestJournalFaultInjectorForTests((phase, record: any) => {
    if (phase === 'after-jsonl-append' && record.kind === 'request' && record.sessionId === sessionId) {
      capturedRequestId = record.requestId;
      throw new Error('injected post-JSONL failure');
    }
  });
  await assert.rejects(beginLlmRequestJournal({ sessionId, purpose: 'low-level', systemPrompt: '', toolDefinitions: [], messages: [{ role: 'user', parts: [{ text: 'recover me' }] }] as any, requestedModelKey: 'fixture/model', promptCacheKey: 'cache-r' }), /injected/);
  setLlmRequestJournalFaultInjectorForTests(null);
  assert.ok(capturedRequestId);
  resetLlmRequestJournalForTests();
  const recovered = await reconstructLlmRequest(capturedRequestId);
  assert.equal(recovered.completeness, 'complete');
  if (recovered.completeness === 'complete') assert.equal(recovered.messages[0].parts[0].text, 'recover me');
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
  const child = spawn(process.execPath, ['-e', childCode], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
  let childError = '';
  child.stderr.on('data', chunk => { childError += String(chunk); });
  const childDone = new Promise<void>((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(childError || `child exit ${code}`))));
  await Promise.all([
    appendMessagesToArchive(session, Array.from({ length: 25 }, (_, index) => ({ role: index % 2 ? 'model' : 'user', parts: [{ text: `archive-${index}` }] })) as any),
    beginLlmRequestJournal({ sessionId, systemPrompt: 'parent', toolDefinitions: [], messages: [{ role: 'user', parts: [{ text: 'parent' }] }] as any, requestedModelKey: 'fixture/model', promptCacheKey: 'parent-cache' }),
    childDone,
  ]);
});

test('streaming bootstrap imports more than one batch without whole-file buffering', async () => {
  const isolatedRoot = path.join(process.cwd(), '.temp', unique('journal_stream_root'));
  const modulePath = path.join(__dirname, 'llmRequestJournal.js');
  const childCode = `
    const fs=require('fs-extra');
    const j=require(${JSON.stringify(modulePath)});
    (async()=>{
      let latest;
      for(let index=0;index<225;index+=1) latest=await j.beginLlmRequestJournal({sessionId:'streaming',systemPrompt:'streaming',toolDefinitions:[],messages:[{role:'user',parts:[{text:String(index)}]}],requestedModelKey:'fixture/model',promptCacheKey:'stream-cache'});
      j.resetLlmRequestJournalForTests();
      await fs.remove(j.LLM_REQUEST_JOURNAL_DB_PATH); await fs.remove(j.LLM_REQUEST_JOURNAL_DB_PATH+'-wal'); await fs.remove(j.LLM_REQUEST_JOURNAL_DB_PATH+'-shm');
      const rebuilt=await j.reconstructLlmRequest(latest.requestId);
      if(j.getLastLlmRequestJournalImportCountForTests()<=200||rebuilt.completeness!=='complete'||rebuilt.messages[0].parts[0].text!=='224') throw new Error(JSON.stringify({count:j.getLastLlmRequestJournalImportCountForTests(),rebuilt}));
    })().then(()=>console.log('__STREAM_BOOTSTRAP_OK__'),e=>{console.error(e);process.exit(1)});`;
  const child = spawn(process.execPath, ['-e', childCode], { cwd: process.cwd(), env: { ...process.env, FOXWARM_DATA_DIR: isolatedRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errorText = '';
  const childDone = new Promise<void>((resolve, reject) => {
    let succeeded = false;
    child.stdout.on('data', chunk => { if (!succeeded && String(chunk).includes('__STREAM_BOOTSTRAP_OK__')) { succeeded = true; child.kill(); } });
    child.on('exit', code => { if (succeeded) resolve(); else reject(new Error(errorText || `child exit ${code}`)); });
  });
  child.stderr.on('data', chunk => { errorText += String(chunk); });
  await childDone;
  await fs.remove(isolatedRoot);
});

test('successful live appends advance the shared import cursor', async () => {
  const isolatedRoot = path.join(process.cwd(), '.temp', unique('journal_cursor_root'));
  const modulePath = path.join(__dirname, 'llmRequestJournal.js');
  const childCode = `
    const j=require(${JSON.stringify(modulePath)});
    (async()=>{
      let latest;
      for(let index=0;index<40;index+=1) latest=await j.beginLlmRequestJournal({sessionId:'cursor',systemPrompt:'live-cursor',toolDefinitions:[],messages:[{role:'user',parts:[{text:String(index)}]}],requestedModelKey:'fixture/model',promptCacheKey:'cursor-cache'});
      j.resetLlmRequestJournalForTests();
      const rebuilt=await j.reconstructLlmRequest(latest.requestId);
      if(j.getLastLlmRequestJournalImportCountForTests()!==0||rebuilt.completeness!=='complete'||rebuilt.messages[0].parts[0].text!=='39') throw new Error(JSON.stringify({count:j.getLastLlmRequestJournalImportCountForTests(),rebuilt}));
    })().then(()=>console.log('__LIVE_CURSOR_OK__'),e=>{console.error(e);process.exit(1)});`;
  const child = spawn(process.execPath, ['-e', childCode], { cwd: process.cwd(), env: { ...process.env, FOXWARM_DATA_DIR: isolatedRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errorText = '';
  const childDone = new Promise<void>((resolve, reject) => {
    let succeeded = false;
    child.stdout.on('data', chunk => {
      if (!succeeded && String(chunk).includes('__LIVE_CURSOR_OK__')) { succeeded = true; child.kill(); }
    });
    child.on('exit', code => { if (succeeded) resolve(); else reject(new Error(errorText || `child exit ${code}`)); });
  });
  child.stderr.on('data', chunk => { errorText += String(chunk); });
  await childDone;
  await fs.remove(isolatedRoot);
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

test('torn JSONL tail is truncated before append and remains recoverable after SQLite loss', async () => {
  const isolatedRoot = path.join(process.cwd(), '.temp', unique('journal_torn_root'));
  const modulePath = path.join(__dirname, 'llmRequestJournal.js');
  const childCode = `
    const fs=require('fs-extra');
    const j=require(${JSON.stringify(modulePath)});
    (async()=>{
      await j.beginLlmRequestJournal({sessionId:'torn',systemPrompt:'one',toolDefinitions:[],messages:[{role:'user',parts:[{text:'one'}]}],requestedModelKey:'fixture/model',promptCacheKey:'cache'});
      await fs.appendFile(j.LLM_REQUEST_JOURNAL_JSONL_PATH, '{"v":1,"kind":"object"}\\n{"v":1,"kind":"request"');
      const second=await j.beginLlmRequestJournal({sessionId:'torn',systemPrompt:'two',toolDefinitions:[],messages:[{role:'user',parts:[{text:'two'}]}],requestedModelKey:'fixture/model',promptCacheKey:'cache'});
      j.resetLlmRequestJournalForTests();
      await fs.remove(j.LLM_REQUEST_JOURNAL_DB_PATH);
      await fs.remove(j.LLM_REQUEST_JOURNAL_DB_PATH+'-wal');
      await fs.remove(j.LLM_REQUEST_JOURNAL_DB_PATH+'-shm');
      const rebuilt=await j.reconstructLlmRequest(second.requestId);
      if(rebuilt.completeness!=='complete'||rebuilt.systemPrompt!=='two'||rebuilt.messages[0].parts[0].text!=='two') throw new Error(JSON.stringify(rebuilt));
    })().then(()=>console.log('__TORN_JOURNAL_OK__'),e=>{console.error(e);process.exit(1)});`;
  const child = spawn(process.execPath, ['-e', childCode], { cwd: process.cwd(), env: { ...process.env, FOXWARM_DATA_DIR: isolatedRoot }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errorText = '';
  const childDone = new Promise<void>((resolve, reject) => {
    let succeeded = false;
    child.stdout.on('data', chunk => {
      if (!succeeded && String(chunk).includes('__TORN_JOURNAL_OK__')) { succeeded = true; child.kill(); }
    });
    child.on('exit', code => { if (succeeded) resolve(); else reject(new Error(errorText || `child exit ${code}`)); });
  });
  child.stderr.on('data', chunk => { errorText += String(chunk); });
  await childDone;
  await fs.remove(isolatedRoot);
});
