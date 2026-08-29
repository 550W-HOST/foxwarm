import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

function messageRecord(sessionId: string, seq: number, text: string, options: { toolOnly?: boolean; displayOnly?: boolean; system?: boolean; mixedTool?: boolean; dualSystem?: boolean; channelSiblingNoise?: boolean } = {}) {
  const message = options.toolOnly
    ? { role: 'model' as const, parts: [{ functionCall: { id: `call-${seq}`, name: 'search', args: { query: text } } }], __meta: { seq, timestamp: seq * 1000 } }
    : options.mixedTool
      ? { role: 'model' as const, parts: [{ text: `ordinary narration ${seq}` }, { functionCall: { id: `call-${seq}`, name: 'search', args: { query: text } } }], __meta: { seq, timestamp: seq * 1000 } }
    : options.dualSystem
      ? { role: 'user' as const, parts: [{ text: `ordinary narration ${seq}`, system: text }], __meta: { seq, timestamp: seq * 1000 } }
    : options.channelSiblingNoise
      ? { role: 'user' as const, parts: [{ text, system: `<foxwarm-message type="channel">\nwrapped channel content ${seq}\n</foxwarm-message>` }], __meta: { seq, timestamp: seq * 1000 } }
    : { role: 'user' as const, modelVisible: options.displayOnly ? false : undefined, parts: [options.system ? { system: text } : { text }], __meta: { seq, timestamp: seq * 1000 } };
  return {
    v: 1, kind: 'message' as const, sessionId, agent: 'main', seq, timestamp: seq * 1000,
    role: message.role, message,
  };
}

function blockRecord(sessionId: string, id: number, summary: string, rawStartSeq: number, rawEndSeq: number) {
  return {
    v: 1, kind: 'block' as const, sessionId, agent: 'main', id, level: 1,
    sourceKind: 'message' as const, sourceStart: rawStartSeq, sourceEnd: rawEndSeq,
    rawStartSeq, rawEndSeq, rawStartTimestamp: rawStartSeq * 1000, rawEndTimestamp: rawEndSeq * 1000,
    summary, createdAt: id * 1000,
  };
}

test('bounded Archive lexical lookup preserves alias lineage caps, authority, noise rejection, and SQL parameter safety', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-archive-lexical-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;
  try {
    const store = await import('./archiveStore');
    const lexical = await import('../toolsSessionAgent/archiveLexicalRecall');
    await store.initArchiveStore();

    await store.ensureSessionBranch('lex-parent');
    await store.writeArchiveMessages([
      messageRecord('lex-parent', 1, 'AlphaNode_42 pre-fork authority'),
      messageRecord('lex-parent', 8, 'AlphaNode_42 post-fork hidden'),
    ] as any);
    await store.writeArchiveBlocks([
      blockRecord('lex-parent', 1, 'Block summary preserves AlphaNode_42.', 1, 1),
      blockRecord('lex-parent', 4, 'Post-fork AlphaNode_42 block hidden.', 8, 8),
    ] as any);
    await store.ensureSessionBranch('lex-child', {
      parentSessionId: 'lex-parent', forkMessageSeq: 3, forkBlockId: 2,
    });
    await store.writeArchiveMessages([
      messageRecord('lex-child', 4, 'Use path src/tools/foo_bar.ts and command /compact tools with threshold 16384.'),
      messageRecord('lex-child', 5, 'AlphaNode_42', { toolOnly: true }),
      messageRecord('lex-child', 6, 'AlphaNode_42 display-only noise', { displayOnly: true }),
    ] as any);
    await store.commitSessionIdRename('lex-historical-alias', 'lex-child');

    const alphaHits = await lexical.searchArchiveLexicalSideChannel('lex-historical-alias', 'find AlphaNode_42', 20);
    assert.ok(alphaHits.some(hit => hit.source_family === 'lex-parent:raw:1-1'));
    assert.ok(alphaHits.some(hit => hit.source_family === 'lex-parent:block:1'));
    assert.ok(!alphaHits.some(hit => hit.source_family === 'lex-parent:raw:8-8'));
    assert.ok(!alphaHits.some(hit => hit.source_family === 'lex-parent:block:4'));
    assert.ok(!alphaHits.some(hit => hit.source_family === 'lex-child:raw:5-5'), 'tool search arguments are not result authority');
    assert.ok(!alphaHits.some(hit => hit.source_family === 'lex-child:raw:6-6'), 'display-only rows are discarded');

    for (const query of ['src/tools/foo_bar.ts', '/compact tools', '16384']) {
      const hits = await lexical.searchArchiveLexicalSideChannel('lex-historical-alias', query, 5);
      assert.ok(hits.some(hit => hit.source_family === 'lex-child:raw:4-4'), `fixture ${query}`);
    }

    await store.ensureSessionBranch('lex-noise');
    await store.writeArchiveMessages([
      messageRecord('lex-noise', 1, 'AlphaNode_42 substantive authority survives candidate caps'),
      ...Array.from({ length: 70 }, (_, index) => messageRecord('lex-noise', index + 2, 'AlphaNode_42', { toolOnly: true })),
      ...Array.from({ length: 70 }, (_, index) => messageRecord('lex-noise', index + 72, 'AlphaNode_42 display noise', { displayOnly: true })),
      ...Array.from({ length: 70 }, (_, index) => messageRecord('lex-noise', index + 142, '<foxwarm-system kind="time" value="AlphaNode_42" />', { system: true })),
      ...Array.from({ length: 70 }, (_, index) => messageRecord('lex-noise', index + 212, '--- RELEVANT MEMORY SNIPPETS (RAG) --- AlphaNode_42')),
      ...Array.from({ length: 70 }, (_, index) => messageRecord('lex-noise', index + 282, 'AlphaNode_42', { mixedTool: true })),
      ...Array.from({ length: 70 }, (_, index) => messageRecord('lex-noise', index + 352, 'AlphaNode_42', { channelSiblingNoise: true })),
    ] as any);
    const noiseHits = await lexical.searchArchiveLexicalSideChannel('lex-noise', 'AlphaNode_42', 10);
    assert.ok(noiseHits.some(hit => hit.source_family === 'lex-noise:raw:1-1'));
    assert.equal(noiseHits.filter(hit => hit.kind === 'raw').length, 1, 'tool/display/ephemeral/RAG/channel-sibling rows cannot consume or survive the raw candidate cap');

    await store.writeArchiveMessages([
      messageRecord('lex-child', 7, 'Stored Unicode identifier äöüß_名 is authoritative.'),
      ...Array.from({ length: 70 }, (_, index) => messageRecord('lex-child', index + 8, 'ÄÖÜß_名', { mixedTool: true })),
    ] as any);
    const unicodeHits = await lexical.searchArchiveLexicalSideChannel('lex-historical-alias', 'ÄÖÜß_名', 5);
    assert.ok(unicodeHits.some(hit => hit.source_family === 'lex-child:raw:7-7'));
    assert.equal(unicodeHits.filter(hit => hit.kind === 'raw').length, 1, 'Unicode tool-call arguments cannot consume the candidate cap');

    await store.ensureSessionBranch('lex-dual-part');
    await store.writeArchiveMessages([
      messageRecord('lex-dual-part', 1, 'AlphaNode_42 dual-field system authority', { dualSystem: true }),
      messageRecord('lex-dual-part', 2, 'äöüß_名 dual-field system authority', { dualSystem: true }),
    ] as any);
    const dualAsciiHits = await lexical.searchArchiveLexicalSideChannel('lex-dual-part', 'AlphaNode_42', 5);
    assert.ok(dualAsciiHits.some(hit => hit.source_family === 'lex-dual-part:raw:1-1'));
    const dualUnicodeHits = await lexical.searchArchiveLexicalSideChannel('lex-dual-part', 'ÄÖÜß_名', 5);
    assert.ok(dualUnicodeHits.some(hit => hit.source_family === 'lex-dual-part:raw:2-2'));

    const injected = await store.locateEffectiveArchiveCandidatesBySubstring('lex-historical-alias', ["x') OR 1=1 --"]);
    assert.deepEqual(injected, []);
    assert.ok((await store.locateEffectiveArchiveCandidatesBySubstring('lex-historical-alias', ['AlphaNode_42'])).length > 0);

    assert.deepEqual(await store.locateEffectiveArchiveCandidatesBySubstring('unknown-lexical-session', ['AlphaNode_42']), []);
    assert.equal(await store.getSessionBranch('unknown-lexical-session'), null, 'lexical reads must not create Archive branches');

    let deepParent: string | undefined;
    for (let index = 0; index < 25; index += 1) {
      const id = `lex-deep-${index}`;
      await store.ensureSessionBranch(id, deepParent ? { parentSessionId: deepParent, forkMessageSeq: 100, forkBlockId: 100 } : undefined);
      deepParent = id;
    }
    let branchReads = 0;
    store.setArchiveBranchReadObserverForTests(() => { branchReads += 1; });
    try {
      assert.deepEqual(await store.locateEffectiveArchiveCandidatesBySubstring(deepParent!, ['AlphaNode_42']), []);
    } finally {
      store.setArchiveBranchReadObserverForTests();
    }
    assert.equal(branchReads, 15, '16 lineage entries require only 15 current-to-parent branch reads');
  } finally {
    await fs.remove(tempRoot);
    delete process.env.FOXWARM_DATA_DIR;
  }
});
