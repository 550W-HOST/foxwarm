import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import sharp from 'sharp';
import { STATE_DIR } from './config';
import {
  externalizeMessages,
  hydrateMessagesForProvider,
  putImageBlob,
  readImageRef,
  resolveImageBlobPath,
} from './imageBlobs';

async function makePng(): Promise<Buffer> {
  return sharp({ create: { width: 3, height: 2, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 1 } } })
    .png()
    .toBuffer();
}

test('image blob store atomically deduplicates validated content and rejects traversal ids', async () => {
  const buffer = await makePng();
  const first = await putImageBlob({ buffer, mimeType: 'image/png', imageId: 'first' });
  const second = await putImageBlob({ buffer, mimeType: 'image/png', imageId: 'second' });
  try {
    assert.equal(first.blobId, second.blobId);
    assert.equal(first.sha256, crypto.createHash('sha256').update(buffer).digest('hex'));
    assert.equal(first.width, 3);
    assert.equal(first.height, 2);
    assert.deepEqual(await readImageRef(first), buffer);
    assert.throws(() => resolveImageBlobPath('../outside.png'), /Invalid image blob id/);
    await assert.rejects(
      () => putImageBlob({ buffer, mimeType: 'image/jpeg', imageId: 'wrong-mime' }),
      /do not match declared MIME type/,
    );
  } finally {
    if (first.blobId) await fs.remove(resolveImageBlobPath(first.blobId));
  }
});

test('externalization is idempotent, provider hydration is clone-only, and failure keeps legacy bytes', async () => {
  const buffer = await makePng();
  const base64 = buffer.toString('base64');
  const legacy = [{ role: 'user' as const, parts: [{ inlineData: { data: base64, mimeType: 'image/png' } }], __meta: { seq: 7 } }];
  const converted = await externalizeMessages(legacy);
  const ref = converted.messages[0].parts[0].inlineDataRef!;
  try {
    assert.equal(converted.changed, true);
    assert.equal(converted.messages[0].parts[0].inlineData, undefined);
    assert.match(ref.imageId, /^msg00000007_part1$/);
    assert.equal((await externalizeMessages(converted.messages)).changed, false);

    const hydrated = await hydrateMessagesForProvider(converted.messages);
    assert.equal(hydrated[0].parts[0].inlineData?.data, base64);
    assert.equal(converted.messages[0].parts[0].inlineData, undefined, 'canonical message must not be mutated');

    const broken = [{ role: 'user' as const, parts: [{ inlineData: { data: '***not-base64***', mimeType: 'image/png' } }] }];
    await assert.rejects(() => externalizeMessages(broken), /Invalid inline image base64/);
    assert.equal(broken[0].parts[0].inlineData.data, '***not-base64***');
  } finally {
    if (ref.blobId) await fs.remove(resolveImageBlobPath(ref.blobId));
  }
});

test('nested function response images are durably promoted in order with tool association', async () => {
  const buffer = await makePng();
  const base64 = buffer.toString('base64');
  const message = {
    role: 'tool' as const,
    parts: [{
      functionResponse: {
        tool_use_id: 'call_nested',
        name: 'screenshot',
        response: {
          status: 'ok',
          inlineData: { data: base64, mimeType: 'image/png' },
          inlineDataItems: [
            { data: base64, mimeType: 'image/png' },
            { data: base64, mimeType: 'image/png' },
          ],
          tail: 'preserved',
        },
      },
    }],
  };
  const converted = await externalizeMessages([message]);
  const blobIds = converted.messages[0].parts.slice(1).map(part => part.inlineDataRef?.blobId).filter(Boolean) as string[];
  try {
    assert.equal(converted.changed, true);
    assert.equal(converted.messages[0].parts.length, 4);
    assert.deepEqual(converted.messages[0].parts[0].functionResponse?.response, { status: 'ok', tail: 'preserved' });
    assert.deepEqual(converted.messages[0].parts.slice(1).map(part => part.toolUseId), [
      'call_nested', 'call_nested', 'call_nested',
    ]);
    assert.deepEqual(converted.messages[0].parts.slice(1).map(part => part.imageMeta?.imageId), [
      'call_nested#1', 'call_nested#2', 'call_nested#3',
    ]);
    assert.equal(JSON.stringify(converted.messages).includes(base64), false);
    assert.equal((await externalizeMessages(converted.messages)).changed, false);
    assert.deepEqual(message.parts[0].functionResponse.response.inlineData, { data: base64, mimeType: 'image/png' }, 'input remains intact until all writes succeed');
  } finally {
    for (const blobId of new Set(blobIds)) await fs.remove(resolveImageBlobPath(blobId));
  }
});

test('legacy archive paths import read-old/write-new without exposing the path in the new ref', async () => {
  const buffer = await makePng();
  const legacyDir = path.join(STATE_DIR, 'sessions-blob', `image-blob-test-${Date.now()}.images`);
  const legacyPath = path.join(legacyDir, 'legacy.png');
  await fs.outputFile(legacyPath, buffer);
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const message = [{
    role: 'tool' as const,
    parts: [{
      inlineDataRef: {
        imageId: 'legacy-image',
        format: 'png',
        path: path.relative(path.join(__dirname), legacyPath),
        mimeType: 'image/png',
        byteLength: buffer.length,
        sha256,
      },
    }],
  }];
  let blobId: string | undefined;
  try {
    const converted = await externalizeMessages(message);
    const ref = converted.messages[0].parts[0].inlineDataRef!;
    blobId = ref.blobId;
    assert.equal(converted.changed, true);
    assert.equal(ref.path, undefined);
    assert.deepEqual(await readImageRef(ref), buffer);
  } finally {
    await fs.remove(legacyDir);
    if (blobId) await fs.remove(resolveImageBlobPath(blobId));
  }
});