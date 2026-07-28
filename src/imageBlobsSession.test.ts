import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import sharp from 'sharp';
import * as sessionManager from './sessionManager';
import { resolveImageBlobPath } from './imageBlobs';
import { loadSessionsMetadataSnapshot, readSessionHistorySnapshot } from './session/metadataStore';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('session append persists refs in live/archive history and fork preserves the same canonical blob', async () => {
  const sourceId = makeId('image_blob_fork_source');
  const session = await sessionManager.getSession(sourceId);
  session.history = [];
  session.queue = [];
  session.persistentMemorySnapshot = '';
  session.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  session.meta = { lastMessageTime: Date.now() };
  const buffer = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 1, g: 2, b: 3 } } }).png().toBuffer();
  const base64 = buffer.toString('base64');
  let forkId: string | undefined;
  let blobId: string | undefined;

  try {
    await sessionManager.appendSessionMessage(session, {
      role: 'user',
      parts: [{ text: 'look' }, { inlineData: { data: base64, mimeType: 'image/png' } }],
    });
    const ref = session.history[0].parts[1].inlineDataRef!;
    blobId = ref.blobId;
    assert.ok(blobId);
    assert.equal(session.history[0].parts[1].inlineData, undefined);

    await sessionManager.appendSessionMessage(session, {
      role: 'tool',
      parts: [{
        functionResponse: {
          tool_use_id: 'nested_session_tool',
          name: 'screenshot',
          response: {
            output: 'kept',
            inlineDataItems: [
              { data: base64, mimeType: 'image/png' },
              { data: base64, mimeType: 'image/png' },
            ],
          },
        },
      }],
    });
    assert.equal(JSON.stringify(session.history).includes(base64), false);
    assert.deepEqual(session.history[1].parts.slice(1).map(part => part.toolUseId), ['nested_session_tool', 'nested_session_tool']);

    session.queue = [{
      type: 'user',
      parts: [{
        functionResponse: {
          tool_use_id: 'nested_queue_tool',
          name: 'queued-image',
          response: { inlineData: { data: base64, mimeType: 'image/png' }, marker: 'queue-business-field' },
        },
      }],
    }];
    await sessionManager.saveSession(sourceId);

    const disk = await readSessionHistorySnapshot(sourceId);
    assert.equal(disk?.history[0].parts[1].inlineDataRef.blobId, blobId);
    assert.equal(JSON.stringify(disk).includes(base64), false);
    const metadata = (await loadSessionsMetadataSnapshot()).data as any;
    assert.equal(JSON.stringify(metadata.sessions[sourceId].queue).includes(base64), false);
    assert.equal(metadata.sessions[sourceId].queue[0].parts[0].functionResponse.response.marker, 'queue-business-field');
    assert.equal(metadata.sessions[sourceId].queue[0].parts[1].toolUseId, 'nested_queue_tool');

    const archived = await sessionManager.getArchivedMessages(sourceId, { startSeq: 1, endSeq: 1 });
    assert.equal((archived.records[0] as any).message.parts[1].inlineDataRef.blobId, blobId);
    assert.equal((archived.records[0] as any).message.parts[1].inlineDataRef.path, undefined);
    assert.equal(JSON.stringify(archived.records).includes(base64), false);
    const nestedArchive = await sessionManager.getArchivedMessages(sourceId, { startSeq: 2, endSeq: 2 });
    assert.equal(JSON.stringify(nestedArchive.records).includes(base64), false);
    assert.deepEqual((nestedArchive.records[0] as any).message.parts.slice(1).map((part: any) => part.toolUseId), [
      'nested_session_tool', 'nested_session_tool',
    ]);

    forkId = await sessionManager.forkSession(sourceId, 'imagecopy');
    const fork = await sessionManager.getSession(forkId);
    assert.equal(fork.history[0].parts[1].inlineDataRef?.blobId, blobId);
    assert.equal(fork.history[0].parts[1].inlineData, undefined);

    await sessionManager.deleteSession(forkId);
    forkId = undefined;
    await sessionManager.deleteSession(sourceId);
    assert.equal(await fs.pathExists(resolveImageBlobPath(blobId!)), true, 'live session deletion must not collect archive-owned blobs');
  } finally {
    if (forkId) await sessionManager.deleteSession(forkId).catch(() => {});
    await sessionManager.deleteSession(sourceId).catch(() => {});
    if (blobId) await fs.remove(resolveImageBlobPath(blobId));
  }
});