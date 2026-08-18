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
import { convertToOpenAIFormat } from './llmProviders/openai';
import type { Message } from './types';

const TEST_FIXTURES_DIR = path.resolve(__dirname, '..', 'src', 'testFixtures');
const SYNTHETIC_HEIC_FIXTURE = path.join(TEST_FIXTURES_DIR, 'synthetic-3x2.heic');
const SYNTHETIC_ALPHA_HEIC_FIXTURE = path.join(TEST_FIXTURES_DIR, 'synthetic-alpha-3x2.heic');

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

test('provider hydration normalizes real HEIC bytes for both MIME aliases without mutating canonical state', async () => {
  const cases = [
    {
      buffer: await fs.readFile(SYNTHETIC_HEIC_FIXTURE),
      mimeType: 'image/heic',
      expectedProviderMime: 'image/jpeg',
    },
    {
      buffer: await fs.readFile(SYNTHETIC_ALPHA_HEIC_FIXTURE),
      mimeType: 'image/heif',
      expectedProviderMime: 'image/png',
    },
  ];
  const refs = await Promise.all(cases.map((item, index) => (
    putImageBlob({ buffer: item.buffer, mimeType: item.mimeType, imageId: `synthetic-${index + 1}` })
  )));
  try {
    for (let index = 0; index < refs.length; index += 1) {
      const ref = refs[index];
      const original: Message = {
        role: 'tool',
        parts: [{
          toolUseId: 'call_synthetic',
          inlineDataRef: ref,
          imageMeta: { imageId: ref.imageId, mimeType: ref.mimeType, width: 3, height: 2 },
        }],
      };
      const originalSnapshot = structuredClone(original);
      const originalBlob = await readImageRef(ref);

      const hydrated = await hydrateMessagesForProvider([original]);
      const hydratedPart = hydrated[0].parts[0];
      const providerBuffer = Buffer.from(hydratedPart.inlineData!.data, 'base64');
      const metadata = await sharp(providerBuffer).metadata();
      const pixels = await sharp(providerBuffer).ensureAlpha().raw().toBuffer();

      assert.equal(hydratedPart.inlineData?.mimeType, cases[index].expectedProviderMime);
      assert.deepEqual({ width: metadata.width, height: metadata.height, format: metadata.format }, {
        width: 3,
        height: 2,
        format: cases[index].expectedProviderMime === 'image/png' ? 'png' : 'jpeg',
      });
      if (cases[index].expectedProviderMime === 'image/png') {
        assert.equal(metadata.hasAlpha, true);
        assert.ok(Array.from(pixels).filter((_value, offset) => offset % 4 === 3).some(alpha => alpha === 0));
      } else {
        assert.ok(pixels[0] > pixels[1] * 3 && pixels[0] > pixels[2] * 3, 'synthetic red pixels remain red-dominant');
      }
      assert.equal(hydratedPart.toolUseId, 'call_synthetic');
      assert.strictEqual(hydratedPart.inlineDataRef, original.parts[0].inlineDataRef);
      assert.deepEqual(hydratedPart.imageMeta, original.parts[0].imageMeta);
      assert.deepEqual(original, originalSnapshot, 'canonical message and reference remain unchanged');
      assert.deepEqual(await readImageRef(ref), originalBlob, 'canonical blob bytes remain unchanged');

      const openAiPayload = convertToOpenAIFormat(hydrated);
      const serialized = JSON.stringify(openAiPayload);
      assert.match(serialized, new RegExp(`data:${cases[index].expectedProviderMime.replace('/', '\\/')};base64,`));
      assert.doesNotMatch(serialized, /image\/(?:heic|heif)/);
    }
  } finally {
    for (const blobId of new Set(refs.map(ref => ref.blobId).filter(Boolean) as string[])) {
      await fs.remove(resolveImageBlobPath(blobId));
    }
  }
});

test('provider hydration rejects malformed claimed HEIC before serialization', async () => {
  const ref = await putImageBlob({
    buffer: Buffer.from('not an ISO BMFF image'),
    mimeType: 'image/heic',
    imageId: 'malformed-heic',
  });
  try {
    await assert.rejects(
      () => hydrateMessagesForProvider([{ role: 'user', parts: [{ inlineDataRef: ref }] }]),
      /Unable to normalize HEIC\/HEIF image malformed-heic for provider: invalid or unsupported HEIF data\./,
    );
  } finally {
    if (ref.blobId) await fs.remove(resolveImageBlobPath(ref.blobId));
  }
});

test('provider hydration leaves native provider raster formats byte-identical', async () => {
  const formats = [
    { mimeType: 'image/png', buffer: await sharp({ create: { width: 2, height: 1, channels: 4, background: '#123456' } }).png().toBuffer() },
    { mimeType: 'image/jpeg', buffer: await sharp({ create: { width: 2, height: 1, channels: 3, background: '#123456' } }).jpeg().toBuffer() },
    { mimeType: 'image/gif', buffer: await sharp({ create: { width: 2, height: 1, channels: 4, background: '#123456' } }).gif().toBuffer() },
    { mimeType: 'image/webp', buffer: await sharp({ create: { width: 2, height: 1, channels: 4, background: '#123456' } }).webp().toBuffer() },
  ];
  const refs = await Promise.all(formats.map((item, index) => putImageBlob({
    buffer: item.buffer,
    mimeType: item.mimeType,
    imageId: `native-${index + 1}`,
  })));
  try {
    const hydrated = await hydrateMessagesForProvider([{
      role: 'user',
      parts: refs.map(ref => ({ inlineDataRef: ref })),
    }]);
    for (let index = 0; index < formats.length; index += 1) {
      const inline = hydrated[0].parts[index].inlineData!;
      assert.equal(inline.mimeType, formats[index].mimeType);
      assert.deepEqual(Buffer.from(inline.data, 'base64'), formats[index].buffer);
    }
  } finally {
    for (const ref of refs) {
      if (ref.blobId) await fs.remove(resolveImageBlobPath(ref.blobId));
    }
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