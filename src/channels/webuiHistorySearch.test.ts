import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const parent = 'viewer-a/parent';
const child = 'viewer-a/child';
const other = 'viewer-b/other';
const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function record(sessionId: string, agent: string, seq: number, text: string, extras: any = {}) {
  return {
    v: 1, kind: 'message' as const, sessionId, agent, seq, timestamp: seq * 1000,
    role: 'user' as const,
    message: { role: 'user' as const, parts: [{ text, ...(seq === 2 && sessionId === parent ? { inlineData: { data: image, mimeType: 'image/png' } } : {}) }],
      __meta: { seq, timestamp: seq * 1000 }, ...extras },
  };
}

test('authenticated history viewer scopes sources, pages sparse lineage, and keeps model replay metadata out of its DTO', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-history-viewer-'));
  process.env.FOXWARM_DATA_DIR = temp;
  const store = await import('../session/archiveStore');
  const vector = await import('../vector');
  const archiveRecall = await import('../toolsSessionAgent/archiveRecall');
  const { HttpServer, setHttpServer } = await import('../httpServer');
  const { WebUIChannel } = await import('./webuiChannel');
  const { resolveImageBlobPath } = await import('../imageBlobs');
  await store.initArchiveStore();
  await store.writeArchiveMessages([record(parent, 'viewer-a', 1, 'find narrative'), record(parent, 'viewer-a', 2, 'find historical context', {
    providerMeta: { sourceModelId: 'test/model', providerSpecificFields: { reasoning_signature: 'OPAQUE_MESSAGE_REPLAY' } },
  }), record(parent, 'viewer-a', 3, 'find third'), record(parent, 'viewer-a', 50, 'future parent must not appear')]);
  await store.ensureSessionBranch(child, { parentSessionId: parent, forkMessageSeq: 3, forkBlockId: 0 });
  await store.writeArchiveMessages([4, 8, 20, 28, 70].map(seq => record(child, 'viewer-a', seq, `find child ${seq}`, {
    parts: [{ text: `find child ${seq}`, providerMeta: { encryptedThinking: 'OPAQUE_ENCRYPTED_THINKING', signature: 'OPAQUE_PART_SIGNATURE', thinkingSummaries: ['visible summary'], openaiResponses: { sourceModelId: 'test/model', outputItem: { type: 'opaque', secret: 'OPAQUE_ITEM' }, annotations: [{ type: 'url_citation', url: 'https://example.org', title: 'Example' }] } } }],
  })));
  await store.writeArchiveMessages([record(other, 'viewer-b', 1, 'find second agent')]);
  await store.writeArchiveBlocks([{
    v: 1, kind: 'block', sessionId: parent, agent: 'viewer-a', id: 3, level: 1,
    sourceKind: 'message', sourceStart: 1, sourceEnd: 3, rawStartSeq: 1, rawEndSeq: 3,
    summary: 'remember the useful summary', createdAt: 3000,
  }]);
  await store.commitSessionIdRename('viewer-a/old-child', 'viewer-a/intermediate');
  await store.commitSessionIdRename('viewer-a/intermediate', child);

  const generatedId = 'viewer-a/generated-short-messages';
  const marker = 'TARGET-UNIQUE-ROW-180';
  const generated = Array.from({ length: 440 }, (_, index) => {
    const seq = index + 1;
    const role = index % 2 ? 'model' as const : 'user' as const;
    return { ...record(generatedId, 'viewer-a', seq, seq === 180 ? `yes ${marker}` : index % 3 ? 'yes' : 'okay'),
      role, message: { role, parts: [{ text: seq === 180 ? `yes ${marker}` : index % 3 ? 'yes' : 'okay' }], __meta: { seq, timestamp: seq * 1000 } } };
  });
  await store.writeArchiveMessages(generated);
  const segments = vector.buildArchiveSegments(generated);
  const indexedSegment = segments.find(segment => segment.startSeq <= 180 && segment.endSeq >= 180)!;
  assert.ok(indexedSegment.messageCount > 100);
  const generatedHit = vector.createRowsFromSegment(indexedSegment).find(row => row.chunk_text.includes(marker))!;
  const rankedGeneratedHit = { ...generatedHit, kind: 'raw', source_family: `${generatedId}:raw:${generatedHit.start_seq}-${generatedHit.end_seq}` };
  const fullGeneratedRecords = await store.readEffectiveArchiveMessages(generatedId, generatedHit.start_seq, generatedHit.end_seq);
  const originalWindow = archiveRecall.selectVectorRawMessageWindow(fullGeneratedRecords, marker, generatedHit.chunk_text);
  const boundedWindow = await archiveRecall.selectBoundedVectorRawMessageWindow(generatedId,
    { startSeq: generatedHit.start_seq, endSeq: generatedHit.end_seq }, marker, generatedHit.chunk_text);
  assert.deepEqual(originalWindow.records.map(row => row.seq), [177, 178, 179, 180, 181, 182, 183]);
  assert.deepEqual(boundedWindow.records.map(row => row.seq), originalWindow.records.map(row => row.seq));
  const fallbackOriginal = archiveRecall.selectVectorRawMessageWindow(fullGeneratedRecords, 'no-match-token', '');
  const fallbackBounded = await archiveRecall.selectBoundedVectorRawMessageWindow(generatedId,
    { startSeq: generatedHit.start_seq, endSeq: generatedHit.end_seq }, 'no-match-token', '');
  assert.deepEqual(fallbackBounded.records.map(row => row.seq), fallbackOriginal.records.map(row => row.seq));

  const boundaryId = 'viewer-a/tool-boundary';
  const boundaryRecords = Array.from({ length: 210 }, (_, index) => {
    const seq = index + 1;
    if (seq === 100) return { ...record(boundaryId, 'viewer-a', seq, 'boundary marker'),
      role: 'model' as const, message: { role: 'model' as const,
        parts: [{ text: 'boundary marker' }, { functionCall: { id: 'tool-id-100', name: 'read', args: {} } }], __meta: { seq } } };
    if (seq === 101) return { ...record(boundaryId, 'viewer-a', seq, 'tool reply'),
      role: 'tool' as const, message: { role: 'tool' as const,
        parts: [{ functionResponse: { tool_use_id: 'tool-id-100', name: 'read', response: { output: 'tool reply' } } }], __meta: { seq } } };
    if (seq === 129 || seq === 180) return record(boundaryId, 'viewer-a', seq, seq === 129 ? 'tie-foo' : 'tie-bar');
    return record(boundaryId, 'viewer-a', seq, 'ordinary');
  });
  await store.writeArchiveMessages(boundaryRecords);
  const boundaryRange = { startSeq: 1, endSeq: 210 };
  const boundaryFull = archiveRecall.selectVectorRawMessageWindow(boundaryRecords, 'boundary marker', 'boundary marker');
  const boundaryBounded = await archiveRecall.selectBoundedVectorRawMessageWindow(boundaryId, boundaryRange, 'boundary marker', 'boundary marker');
  assert.deepEqual(boundaryBounded.records.map(row => row.seq), boundaryFull.records.map(row => row.seq));
  assert.ok(boundaryBounded.records.some(row => row.seq === 101), 'complete call/response crosses the SQL page boundary');
  const tieFull = archiveRecall.selectVectorRawMessageWindow(boundaryRecords, 'tie', '');
  const tieBounded = await archiveRecall.selectBoundedVectorRawMessageWindow(boundaryId, boundaryRange, 'tie', '');
  assert.deepEqual(tieBounded.records.map(row => row.seq), tieFull.records.map(row => row.seq));
  assert.ok(tieBounded.records.some(row => row.seq === 129), 'equal score and length choose earlier archive position');
  const effectiveChildRows = await store.readEffectiveArchiveMessages(child, 1, 70);
  const effectiveChildFull = archiveRecall.selectVectorRawMessageWindow(effectiveChildRows, 'find child 70', 'find child 70');
  const effectiveChildBounded = await archiveRecall.selectBoundedVectorRawMessageWindow('viewer-a/old-child',
    { startSeq: 1, endSeq: 70 }, 'find child 70', 'find child 70');
  assert.deepEqual(effectiveChildBounded.records.map(row => row.seq), effectiveChildFull.records.map(row => row.seq));
  assert.equal(effectiveChildBounded.records.some(row => row.seq === 50), false, 'inherited parent rows stop at fork cap');

  const originalSearch = vector.searchDetailed;
  const seenOptions: unknown[] = [];
  const hits = [
    { id: 'a-1', session_id: parent, agent: 'viewer-a', kind: 'raw', source_family: `${parent}:raw:1-3`, start_seq: 1, end_seq: 3, chunk_text: 'find historical context' },
    { id: 'a-2', session_id: child, agent: 'viewer-a', kind: 'raw', source_family: `${child}:raw:4-28`, start_seq: 4, end_seq: 28, chunk_text: 'find child 20' },
    { id: 'b-1', session_id: other, agent: 'viewer-b', kind: 'raw', source_family: `${other}:raw:1-1`, start_seq: 1, end_seq: 1, chunk_text: 'find second agent' },
  ];
  const factHit = { id: 'fact-1', session_id: parent, agent: 'viewer-a', kind: 'fact',
    source_family: `${parent}:block:3`, block_id: 3,
    matched_facts: [{ fact_kind: 'decision', text: 'Stored fact from source block.' }] };
  const staleHit = { id: 'stale-1', session_id: parent, agent: 'viewer-a', kind: 'legacy',
    source_family: `${parent}:legacy:stale`, text: 'Cached legacy excerpt.' };
  (vector as any).searchDetailed = async (_query: string, _limit: number, _format: boolean, options: any) => {
    seenOptions.push(options);
    return { hits: (_query === marker ? [rankedGeneratedHit] : _query === 'memoryfact' ? [factHit] : _query === 'stale' ? [staleHit] : hits).filter(hit => !options.agent || hit.agent === options.agent)
      .filter(hit => !options.lineageSessions || options.lineageSessions.some((item: any) => item.sessionId === hit.session_id
        && (item.maxMessageSeq === undefined || ('start_seq' in hit && Number(hit.start_seq) <= item.maxMessageSeq)))),
      lexical: { configured: true, ready: true, used: false, coverageComplete: true, backfilling: false } };
  };
  const port = 45100 + Math.floor(Math.random() * 250);
  const server = new HttpServer(port, 'viewer-test-token');
  setHttpServer(server);
  new WebUIChannel({ router: {} as any, token: 'viewer-test-token', enableTrigger: false, enableWebUI: true });
  await server.start();
  const request = (url: string, authorized = true) => fetch(`http://127.0.0.1:${port}${url}`, authorized ? { headers: { Authorization: 'Bearer viewer-test-token' } } : {});
  let blobId = '';
  try {
    assert.equal((await request('/api/history/search?query=find', false)).status, 401);
    const global = await request('/api/history/search?query=find');
    assert.equal(global.status, 200);
    const globalResult = await global.json() as any;
    assert.deepEqual(globalResult.results.map((item: any) => item.sessionId), [parent, child, other]);
    assert.equal(seenOptions[0] && Object.keys(seenOptions[0]).length, 1, 'global has only explicit preferBlocks option');
    assert.deepEqual(globalResult.results[0].messages.map((message: any) => message.__meta.seq), [1, 2, 3]);
    assert.equal(JSON.stringify(globalResult).includes('OPAQUE_MESSAGE_REPLAY'), false);
    assert.equal(JSON.stringify(globalResult).includes(image), false);
    blobId = globalResult.results[0].messages[1].parts[0].inlineDataRef.blobId;
    assert.match(globalResult.results[0].messages[1].parts[0].inlineDataRef.apiPath, /^\/blobs\//);
    assert.equal(globalResult.results[0].messages[1].parts[0].inlineDataRef.path, undefined);
    assert.equal(JSON.stringify(globalResult).includes('OPAQUE_ENCRYPTED_THINKING'), false);
    assert.equal(JSON.stringify(globalResult).includes('OPAQUE_PART_SIGNATURE'), false);
    assert.equal(JSON.stringify(globalResult).includes('OPAQUE_ITEM'), false);
    assert.equal(globalResult.results[1].messages[0].parts[0].providerMeta.thinkingSummaries[0], 'visible summary');
    assert.equal(globalResult.results[1].messages[0].parts[0].providerMeta.openaiResponses.annotations[0].title, 'Example');
    const blob = await request(`/api/blobs/${blobId}`);
    assert.equal(blob.status, 200);
    const fact = await (await request('/api/history/search?query=memoryfact')).json() as any;
    assert.equal(fact.results.length, 1);
    assert.equal(fact.results[0].kind, 'block');
    assert.equal(fact.results[0].messages[0].__meta.contextBlock.id, 3);
    assert.equal(fact.results[0].matchedFacts[0].kind, 'decision');
    const expanded = await (await request(`/api/sessions/${encodeURIComponent(parent)}/context-blocks/3/expand`)).json() as any;
    assert.deepEqual(expanded.messages.map((item: any) => item.__meta.seq), [1, 2, 3]);
    const stale = await (await request('/api/history/search?query=stale')).json() as any;
    assert.equal(stale.results[0].kind, 'unavailable');
    assert.deepEqual(stale.results[0].messages, []);
    assert.equal(stale.results[0].fallbackExcerpt, 'Cached legacy excerpt.');
    const generatedSearch = await (await request(`/api/history/search?query=${encodeURIComponent(marker)}&limit=20`)).json() as any;
    const generatedSource = generatedSearch.results.find((source: any) => source.key === rankedGeneratedHit.source_family);
    assert.ok(generatedSource, 'actual generated source-family candidate survives ranked source fusion');
    assert.deepEqual(generatedSource.messages.map((message: any) => message.__meta.seq), [177, 178, 179, 180, 181, 182, 183]);

    const agent = await (await request('/api/history/search?query=find&agentName=viewer-a')).json() as any;
    assert.deepEqual(agent.results.map((item: any) => item.sessionId), [parent, child]);
    const scoped = await (await request(`/api/history/search?query=find&sessionId=${encodeURIComponent('viewer-a/old-child')}`)).json() as any;
    assert.deepEqual(scoped.results.map((item: any) => item.sessionId), [child, child]);
    assert.deepEqual((seenOptions.at(-1) as any).lineageSessions.map((entry: any) => [entry.sessionId, entry.maxMessageSeq]), [[child, undefined], [parent, 3]]);
    assert.deepEqual(scoped.results[0].messages.map((item: any) => item.__meta.seq), [1, 2, 3]);
    assert.equal((await request(`/api/history/search?query=find&sessionId=${encodeURIComponent('viewer-a/old-child')}&agentName=viewer-b`)).status, 400);
    const scopedContinuation = await (await request(`/api/history/window?sessionId=${encodeURIComponent(scoped.results[0].sessionId)}&afterSeq=3`)).json() as any;
    assert.equal(scopedContinuation.messages[0].parts[0].text, 'find child 4');
    assert.equal(JSON.stringify(scopedContinuation).includes('future parent must not appear'), false);

    const exact = await request(`/api/history/window?sessionId=${encodeURIComponent('viewer-a/old-child')}&target=msg%231-28`);
    assert.equal(exact.status, 200);
    const exactBody = await exact.json() as any;
    assert.deepEqual(exactBody.messages.map((item: any) => item.__meta.seq), [1, 2, 3, 4, 8, 20, 28]);
    assert.equal(exactBody.messages[0].__meta.contextArchiveItem.inherited, true);
    assert.equal(exactBody.messages[3].__meta.contextArchiveItem.inherited, false);
    assert.equal(exactBody.hasLater, true);
    const next = await (await request(`/api/history/window?sessionId=${encodeURIComponent(child)}&afterSeq=28`)).json() as any;
    assert.deepEqual(next.messages.map((item: any) => item.__meta.seq), [70]);
    assert.equal(next.hasLater, false);
    const earlier = await (await request(`/api/history/window?sessionId=${encodeURIComponent(child)}&beforeSeq=20`)).json() as any;
    assert.deepEqual(earlier.messages.map((item: any) => item.__meta.seq), [1, 2, 3, 4, 8]);
    assert.equal(earlier.hasEarlier, false);
    const wideRange = await (await request(`/api/history/window?sessionId=${encodeURIComponent(child)}&target=msg%231-1000000`)).json() as any;
    assert.deepEqual(wideRange.requestedRange, { startSeq: 1, endSeq: 1000000 });
    assert.deepEqual(wideRange.shownRange, { startSeq: 1, endSeq: 70 });
    assert.equal(wideRange.hasMoreInTarget, false);
    assert.equal((await request('/api/history/window?sessionId=missing&target=msg%231')).status, 404);

    const longId = 'viewer-a/sparse';
    await store.writeArchiveMessages(Array.from({ length: 35 }, (_, index) => record(longId, 'viewer-a', (index + 1) * 10, `sparse ${index}`)));
    const firstPage = await (await request(`/api/history/window?sessionId=${encodeURIComponent(longId)}&target=msg%231-50`)).json() as any;
    assert.deepEqual(firstPage.messages.map((item: any) => item.__meta.seq), [10, 20, 30, 40, 50]);
    const following = await (await request(`/api/history/window?sessionId=${encodeURIComponent(longId)}&afterSeq=50`)).json() as any;
    assert.equal(following.messages.length, 20);
    assert.equal(following.messages[0].__meta.seq, 60);
    assert.equal(following.messages.at(-1).__meta.seq, 250);
    assert.equal(following.hasLater, true);
    const finalPage = await (await request(`/api/history/window?sessionId=${encodeURIComponent(longId)}&afterSeq=250`)).json() as any;
    assert.deepEqual(finalPage.messages.map((item: any) => item.__meta.seq), [260, 270, 280, 290, 300, 310, 320, 330, 340, 350]);
    assert.equal(finalPage.hasLater, false);
    assert.equal(new Set([...firstPage.messages, ...following.messages, ...finalPage.messages].map((item: any) => item.__meta.seq)).size, 35);
    const largeSelection = await (await request(`/api/history/window?sessionId=${encodeURIComponent(longId)}&target=msg%231-1000000`)).json() as any;
    assert.equal(largeSelection.messages.length, 20);
    assert.equal(largeSelection.hasMoreInTarget, true);
    assert.deepEqual(largeSelection.shownRange, { startSeq: 10, endSeq: 200 });
    const selectedContinuation = await (await request(`/api/history/window?sessionId=${encodeURIComponent(longId)}&afterSeq=200&targetEndSeq=1000000`)).json() as any;
    assert.deepEqual(selectedContinuation.messages.map((item: any) => item.__meta.seq), Array.from({ length: 15 }, (_, index) => (index + 21) * 10));
    assert.equal(selectedContinuation.hasMoreInTarget, false);
    const selectedCutoff = await (await request(`/api/history/window?sessionId=${encodeURIComponent(longId)}&afterSeq=200&targetEndSeq=250`)).json() as any;
    assert.deepEqual(selectedCutoff.messages.map((item: any) => item.__meta.seq), [210, 220, 230, 240, 250]);
    assert.equal(selectedCutoff.hasMoreInTarget, false);
    assert.equal(selectedCutoff.hasLater, true);
  } finally {
    (vector as any).searchDetailed = originalSearch;
    const disabled = await request('/api/history/search?query=find');
    assert.equal(disabled.status, 503);
    assert.equal((await disabled.json() as any).code, 'VECTOR_DISABLED');
    assert.equal((await request(`/api/history/window?sessionId=${encodeURIComponent(child)}&target=msg%234`)).status, 200);
    await server.stop();
    setHttpServer(null);
    if (blobId) await fs.remove(resolveImageBlobPath(blobId));
    await fs.remove(temp);
  }
});
