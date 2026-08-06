import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import * as sessionManager from '../sessionManager';
import * as sessionArchive from '../session/archive';
import { image_crop, image_write_to_file } from '../tools';
import { normalizeToolResultImages } from '../toolImages';
import { putImageBlob, resolveImageBlobPath } from '../imageBlobs';
import { nodesManager } from '../nodes/manager';
import type { Session } from '../types';
import * as nodeExecution from '../nodeExecution';

async function makePngBase64(width: number, height: number, rgb: { r: number; g: number; b: number } = { r: 32, g: 96, b: 192 }): Promise<string> {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: rgb,
    },
  }).png().toBuffer();

  return buffer.toString('base64');
}

test('normalizeToolResultImages extracts canonical structured image payloads', async () => {
  const base64 = await makePngBase64(4, 3);
  const normalized = await normalizeToolResultImages({
    inlineData: { data: base64, mimeType: 'image/png' },
    tabId: 'demo-tab',
  }, 'call_image', '[Inline data returned by browser_screenshot]');

  assert.equal(normalized.imageParts.length, 1);
  assert.equal(normalized.imageParts[0].imageMeta?.imageId, 'call_image#1');
  assert.equal(normalized.imageParts[0].imageMeta?.width, 4);
  assert.equal(normalized.imageParts[0].imageMeta?.height, 3);
  assert.equal(normalized.result.output, '[Inline data returned by browser_screenshot]');
  assert.equal(normalized.result.tabId, 'demo-tab');
  assert.equal(Object.prototype.hasOwnProperty.call(normalized.result, 'inlineData'), false);
});

test('generic image extraction does not interpret remote-node compatibility shapes', async () => {
  const results = [
    { output: '__IMAGE__:image/png:ordinary-text-payload' },
    { output: '__SCREENSHOT__:ordinary-text-payload' },
    { image: 'ordinary-image-field', format: 'png', encoding: 'base64' },
    { screenshot: 'ordinary-screenshot-field', mimeType: 'image/png' },
    { inlineData: { data: 'old-mime-field', mime_type: 'image/png' } },
  ];

  for (const result of results) {
    const normalized = await normalizeToolResultImages(result, 'call_plain', '[fallback]');
    assert.strictEqual(normalized.result, result);
    assert.deepEqual(normalized.imageParts, []);
  }
});

test('generic image extraction keeps multiple canonical images and non-image metadata', async () => {
  const first = await makePngBase64(2, 2);
  const second = await makePngBase64(3, 1);
  const normalized = await normalizeToolResultImages({
    output: 'two images',
    source: 'canonical fixture',
    inlineDataItems: [
      { data: first, mimeType: 'image/png' },
      { data: second, mimeType: 'image/png' },
    ],
  }, 'call_multiple', '[fallback]');

  assert.equal(normalized.imageParts.length, 2);
  assert.deepEqual(normalized.imageParts.map(part => part.imageMeta?.imageId), ['call_multiple#1', 'call_multiple#2']);
  assert.deepEqual(normalized.result, { output: 'two images', source: 'canonical fixture' });
});

test('generic image extraction leaves an invalid-only canonical field untouched', async () => {
  const result = {
    output: 'invalid image remains structured',
    inlineData: { data: 'not-an-image', mimeType: 'application/octet-stream' },
  };
  const normalized = await normalizeToolResultImages(result, 'call_invalid', '[fallback]');
  assert.strictEqual(normalized.result, result);
  assert.deepEqual(normalized.imageParts, []);
});

test.todo('Phase 2: preserve invalid entries when inlineDataItems mixes valid and invalid canonical items');

test('image_crop loads prior tool image by id and returns another inline image', async () => {
  const originalGetExistingSession = sessionManager.getExistingSession;
  const originalGetArchivedMessages = sessionManager.getArchivedMessages;

  try {
    const base64 = await makePngBase64(4, 4);
    (sessionManager as any).getExistingSession = async () => ({
      id: 'image-crop-session',
      history: [
        {
          role: 'tool',
          parts: [
            {
              toolUseId: 'call_source',
              inlineData: { mimeType: 'image/png', data: base64 },
              imageMeta: { imageId: 'call_source#1', mimeType: 'image/png', width: 4, height: 4, sizeBytes: Buffer.byteLength(base64, 'base64') },
            },
          ],
        },
      ],
    });
    (sessionManager as any).getArchivedMessages = async () => ({ records: [] as any[] });

    const result: any = await image_crop({
      id: 'call_source#1',
      x: 1,
      y: 1,
      width: 2,
      height: 2,
    }, {
      sessionId: 'image-crop-session',
      session: { agent: 'main' },
    } as any);

    assert.equal(result.sourceImageId, 'call_source#1');
    assert.equal(result.inlineData.mimeType, 'image/png');

    const metadata = await sharp(Buffer.from(result.inlineData.data, 'base64')).metadata();
    assert.equal(metadata.width, 2);
    assert.equal(metadata.height, 2);
  } finally {
    (sessionManager as any).getExistingSession = originalGetExistingSession;
    (sessionManager as any).getArchivedMessages = originalGetArchivedMessages;
  }
});

test('image_write_to_file writes prior tool image by id into the session workspace', async () => {
  const originalGetExistingSession = sessionManager.getExistingSession;
  const originalGetArchivedMessages = sessionManager.getArchivedMessages;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-image-write-'));
  let blobId: string | undefined;

  try {
    const base64 = await makePngBase64(5, 2);
    const ref = await putImageBlob({ buffer: Buffer.from(base64, 'base64'), mimeType: 'image/png', imageId: 'call_source#1', width: 5, height: 2 });
    blobId = ref.blobId;
    (sessionManager as any).getExistingSession = async () => ({
      id: 'image-write-session',
      history: [
        {
          role: 'tool',
          parts: [
            {
              toolUseId: 'call_source',
              inlineDataRef: ref,
              imageMeta: { imageId: 'call_source#1', mimeType: 'image/png', width: 5, height: 2, sizeBytes: Buffer.byteLength(base64, 'base64') },
            },
          ],
        },
      ],
    });
    (sessionManager as any).getArchivedMessages = async () => ({ records: [] as any[] });

    const result = await image_write_to_file({
      id: 'call_source#1',
      filePath: 'saved-image.png',
      overwrite: true,
    }, {
      sessionId: 'image-write-session',
      session: { agent: 'main', cwd: tempDir },
    } as any);

    const writtenFile = path.join(tempDir, 'saved-image.png');
    assert.equal(await fs.pathExists(writtenFile), true);
    const metadata = await sharp(await fs.readFile(writtenFile)).metadata();
    assert.equal(metadata.width, 5);
    assert.equal(metadata.height, 2);
    assert.match(String(result), /send_file/);
  } finally {
    (sessionManager as any).getExistingSession = originalGetExistingSession;
    (sessionManager as any).getArchivedMessages = originalGetArchivedMessages;
    await fs.remove(tempDir);
    if (blobId) await fs.remove(resolveImageBlobPath(blobId));
  }
});

test('detached current owner resolves live and archived images and writes master-local bytes', async () => {
  const sessionId = `detached_images_${Date.now()}`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-detached-image-'));
  const inlineBase64 = await makePngBase64(4, 4, { r: 10, g: 20, b: 30 });
  const blobBase64 = await makePngBase64(5, 3, { r: 40, g: 50, b: 60 });
  const archiveBase64 = await makePngBase64(6, 2, { r: 70, g: 80, b: 90 });
  const blobRef = await putImageBlob({
    buffer: Buffer.from(blobBase64, 'base64'), mimeType: 'image/png', imageId: 'live-blob', width: 5, height: 3,
  });
  const session: Session = {
    id: sessionId,
    agent: 'main',
    cwd: tempDir,
    history: [{ role: 'tool', parts: [
      { inlineData: { mimeType: 'image/png', data: inlineBase64 }, imageMeta: { imageId: 'live-inline', mimeType: 'image/png' } },
      { inlineDataRef: blobRef, imageMeta: { imageId: 'live-blob', mimeType: 'image/png' } },
    ] }],
    persistentMemorySnapshot: '',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: Date.now() },
  } as Session;
  const archiveRecords: any[] = [{
    sessionId,
    seq: 1,
    message: { role: 'tool', parts: [
      { inlineData: { mimeType: 'image/png', data: archiveBase64 }, imageMeta: { imageId: 'archive-inline', mimeType: 'image/png' } },
    ] },
  }];
  const originals = {
    getExisting: sessionManager.getExistingSession,
    getArchived: sessionManager.getArchivedMessages,
    readArchive: sessionArchive.readArchiveMessages,
    getCurrentNode: nodesManager.getCurrentNode,
    writeFileToNode: nodesManager.writeFileToNode,
    isolated: sessionManager.isSessionEffectivelyIsolated,
    copy: nodeExecution.copyBetweenNodes,
  };
  (sessionManager as any).getExistingSession = async () => { throw new Error('global session lookup forbidden'); };
  (sessionManager as any).getArchivedMessages = async () => { throw new Error('archive facade forbidden'); };
  (sessionArchive as any).readArchiveMessages = async (id: string) => id === sessionId ? archiveRecords : [];
  (nodesManager as any).getCurrentNode = async () => { throw new Error('global node lookup forbidden'); };
  const remoteWrites: any[][] = [];
  (nodesManager as any).writeFileToNode = async (...args: any[]) => { remoteWrites.push(args); };
  (sessionManager as any).isSessionEffectivelyIsolated = () => false;
  const ctx: any = { sessionId, session, persistCurrentSession: async () => {} };

  try {
    for (const id of ['live-inline', 'live-blob', 'archive-inline']) {
      const result: any = await image_crop({ id, x: 0, y: 0, width: 1, height: 1 }, ctx);
      assert.equal(result.sourceImageId, id);
      const metadata = await sharp(Buffer.from(result.inlineData.data, 'base64')).metadata();
      assert.deepEqual([metadata.width, metadata.height], [1, 1]);
    }
    await assert.rejects(() => image_crop({ id: 'missing', x: 0, y: 0, width: 1, height: 1 }, ctx),
      new RegExp(`Image id .*missing.* not found in session .*${sessionId}`));

    await image_write_to_file({ id: 'live-blob', filePath: 'written.png', overwrite: true }, ctx);
    assert.deepEqual(await fs.readFile(path.join(tempDir, 'written.png')), Buffer.from(blobBase64, 'base64'));
    await assert.rejects(() => image_write_to_file({ id: 'live-blob', filePath: 'written.png' }, ctx), /File already exists/);

    await image_write_to_file({ id: 'live-inline', filePath: 'remote.png', overwrite: true }, {
      ...ctx, runtimeNodeId: 'remote-a',
    });
    assert.deepEqual(remoteWrites, [[
      'remote-a', 'remote.png', inlineBase64, true, sessionId,
    ]]);

    const handoffs: any[] = [];
    (nodeExecution as any).copyBetweenNodes = async (_sourceId: string, request: any) => {
      handoffs.push({ ...request, bytes: await fs.readFile(request.sourcePath) });
      return { sha256: 'a'.repeat(64), sizeBytes: Buffer.byteLength(inlineBase64, 'base64'), overwritten: false };
    };
    await image_write_to_file({ id: 'live-inline', filePath: 'worker-remote.png', overwrite: true }, {
      ...ctx, runtimeNodeId: 'remote-a', sessionPlacement: 'session-worker',
    });
    assert.deepEqual(handoffs[0].bytes, Buffer.from(inlineBase64, 'base64'));
    assert.equal(handoffs[0].sourceNode, 'master'); assert.equal(handoffs[0].targetNode, 'remote-a');
    assert.equal(JSON.stringify({ ...handoffs[0], bytes: undefined }).includes(inlineBase64), false);
    assert.equal(await fs.pathExists(handoffs[0].sourcePath), false);

    let failedTemp = '';
    (nodeExecution as any).copyBetweenNodes = async (_sourceId: string, request: any) => { failedTemp = request.sourcePath; throw new Error('copy failed'); };
    await assert.rejects(() => image_write_to_file({ id: 'live-inline', filePath: 'worker-fail.png' }, {
      ...ctx, runtimeNodeId: 'remote-a', sessionPlacement: 'session-worker',
    }), /copy failed/);
    assert.equal(await fs.pathExists(failedTemp), false);

    (sessionManager as any).isSessionEffectivelyIsolated = () => true;
    await assert.rejects(() => image_write_to_file({
      id: 'live-inline', filePath: path.join(tempDir, 'isolated-denied.png'), overwrite: true,
    }, ctx), /only access|Access denied/);
  } finally {
    (sessionManager as any).getExistingSession = originals.getExisting;
    (sessionManager as any).getArchivedMessages = originals.getArchived;
    (sessionArchive as any).readArchiveMessages = originals.readArchive;
    (nodesManager as any).getCurrentNode = originals.getCurrentNode;
    (nodesManager as any).writeFileToNode = originals.writeFileToNode;
    (sessionManager as any).isSessionEffectivelyIsolated = originals.isolated;
    (nodeExecution as any).copyBetweenNodes = originals.copy;
    await fs.remove(tempDir);
    if (blobRef.blobId) await fs.remove(resolveImageBlobPath(blobRef.blobId));
  }
});

test('image tools keep legacy ID lookup for no-hook and mismatched contexts', async () => {
  const base64 = await makePngBase64(2, 2);
  const detachedClone: any = {
    id: 'clone-id',
    history: [{ role: 'tool', parts: [
      { inlineData: { mimeType: 'image/png', data: base64 }, imageMeta: { imageId: 'clone-only', mimeType: 'image/png' } },
    ] }],
  };
  const originals = {
    getExisting: sessionManager.getExistingSession,
    readArchive: sessionArchive.readArchiveMessages,
  };
  let lookupCount = 0;
  (sessionManager as any).getExistingSession = async (): Promise<null> => { lookupCount += 1; return null; };
  (sessionArchive as any).readArchiveMessages = async (): Promise<any[]> => [];
  try {
    await assert.rejects(() => image_crop({ id: 'clone-only', x: 0, y: 0, width: 1, height: 1 }, {
      sessionId: 'target-id', session: detachedClone, persistCurrentSession: async () => {},
    } as any), /not found in session `target-id`/);
    await assert.rejects(() => image_crop({ id: 'clone-only', x: 0, y: 0, width: 1, height: 1 }, {
      sessionId: 'clone-id', session: detachedClone,
    } as any), /not found in session `clone-id`/);
    assert.equal(lookupCount, 2);
  } finally {
    (sessionManager as any).getExistingSession = originals.getExisting;
    (sessionArchive as any).readArchiveMessages = originals.readArchive;
  }
});
