import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import sharp from 'sharp';
import { resolveImageBlobPath, readImageRef } from '../imageBlobs';
import fs from 'fs-extra';
import {
  buildImageGenerationReplayItem,
  buildOpenAIImageGenerationTool,
  decodeStrictImageBase64,
  deriveGeneratedImageId,
  externalizeGeneratedImageItems,
  formatGeneratedImageFailureNote,
  formatGeneratedImageModelPlaceholder,
  isCompletedImageGenerationItem,
  isImageGenerationCallItem,
  sanitizeImageGenerationOutputItem,
  IMAGE_GENERATION_MAX_DECODED_BYTES,
} from './openaiImages';

async function makeRaster(format: 'png' | 'jpeg' | 'webp', width = 3, height = 2): Promise<Buffer> {
  const image = sharp({ create: { width, height, channels: 3, background: { r: 10, g: 20, b: 30 } } });
  if (format === 'png') return image.png().toBuffer();
  if (format === 'jpeg') return image.jpeg().toBuffer();
  return image.webp().toBuffer();
}

test('image generation tool maps config fields and omits enablement', () => {
  assert.equal(buildOpenAIImageGenerationTool(undefined), undefined);
  assert.equal(buildOpenAIImageGenerationTool({ enabled: false }), undefined);

  const tool = buildOpenAIImageGenerationTool({
    enabled: true,
    model: 'gpt-image-1',
    action: 'edit',
    size: '1024x1024',
    quality: 'high',
    background: 'opaque',
    outputFormat: 'webp',
    outputCompression: 80,
  });
  assert.deepEqual(tool, {
    type: 'image_generation',
    model: 'gpt-image-1',
    action: 'edit',
    size: '1024x1024',
    quality: 'high',
    background: 'opaque',
    output_format: 'webp',
    output_compression: 80,
    partial_images: 0,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(tool, 'enabled'), false);

  const bare = buildOpenAIImageGenerationTool({ enabled: true });
  assert.deepEqual(bare, { type: 'image_generation', partial_images: 0 });
});

test('strict base64 decoding rejects malformed, non-canonical, empty and oversized payloads', async () => {
  const png = await makeRaster('png');
  const base64 = png.toString('base64');
  assert.deepEqual(decodeStrictImageBase64(base64, IMAGE_GENERATION_MAX_DECODED_BYTES), png);
  // Whitespace inside the payload is tolerated like the existing blob decoder.
  assert.deepEqual(decodeStrictImageBase64(`${base64.slice(0, 8)}\n${base64.slice(8)}`, IMAGE_GENERATION_MAX_DECODED_BYTES), png);

  assert.throws(() => decodeStrictImageBase64('', 1024), /non-empty base64/);
  assert.throws(() => decodeStrictImageBase64(undefined, 1024), /non-empty base64/);
  assert.throws(() => decodeStrictImageBase64('not base64!!', 1024), /non-base64/);
  assert.throws(() => decodeStrictImageBase64('QQ==ZZ', 1024), /non-base64/);
  assert.throws(() => decodeStrictImageBase64(Buffer.from('hello').toString('base64'), 2), /decoded limit/);
});

test('externalization validates bytes, persists blobs and strips binary output metadata', async () => {
  const png = await makeRaster('png');
  const jpeg = await makeRaster('jpeg');
  const webp = await makeRaster('webp');
  const output = [
    { type: 'image_generation_call', id: 'ig_one', status: 'completed', output_format: 'png', result: png.toString('base64'), revised_prompt: 'a cat' },
    { type: 'image_generation_call', id: 'ig_two', status: 'completed', output_format: 'jpeg', result: jpeg.toString('base64') },
    { type: 'image_generation_call', id: 'ig_three', status: 'completed', output_format: 'webp', result: webp.toString('base64') },
  ];
  const result = await externalizeGeneratedImageItems(output, { sourceModelId: 'openai/gpt-5' });
  try {
    assert.equal(result.failures.length, 0);
    assert.equal(result.images.length, 3);
    assert.deepEqual(result.images.map(entry => entry.index), [0, 1, 2]);

    const mimes = result.images.map(entry => entry.part.inlineDataRef!.mimeType);
    assert.deepEqual(mimes, ['image/png', 'image/jpeg', 'image/webp']);
    for (const entry of result.images) {
      const ref = entry.part.inlineDataRef!;
      const blob = await readImageRef(ref);
      assert.equal(ref.sha256, crypto.createHash('sha256').update(blob).digest('hex'));
      assert.equal(entry.part.imageMeta?.origin, 'generated');
      assert.equal(entry.part.imageMeta?.sha256, ref.sha256);
      const outputItem = entry.part.providerMeta!.openaiResponses!.outputItem!;
      assert.equal(outputItem.result, undefined);
      assert.equal(Object.prototype.hasOwnProperty.call(outputItem, 'result'), false);
      assert.equal(outputItem.id, output[entry.index].id);
      assert.equal(entry.part.inlineData, undefined);
    }
    assert.equal(result.images[0].part.providerMeta!.openaiResponses!.outputItem!.revised_prompt, 'a cat');
  } finally {
    for (const entry of result.images) await fs.remove(resolveImageBlobPath(entry.part.inlineDataRef!.blobId!));
  }
});

test('externalization reports failures without fabricating images', async () => {
  const png = await makeRaster('png');
  const output = [
    { type: 'image_generation_call', id: 'ig_pending', status: 'generating', result: png.toString('base64') },
    { type: 'image_generation_call', id: 'ig_empty', status: 'completed', result: '' },
    { type: 'image_generation_call', id: 'ig_mime', status: 'completed', output_format: 'png', result: (await makeRaster('jpeg')).toString('base64') },
    { type: 'image_generation_call', id: 'ig_ok', status: 'completed', output_format: 'png', result: png.toString('base64') },
  ];
  const result = await externalizeGeneratedImageItems(output, { sourceModelId: 'm' });
  try {
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].part.imageMeta?.imageId, 'ig_ig_ok');
    assert.equal(result.failures.length, 3);
    assert.match(result.failures[0].reason, /status generating/);
    assert.match(result.failures[1].reason, /missing or empty/);
    assert.match(result.failures[2].reason, /did not match declared output_format/);
    const note = formatGeneratedImageFailureNote(result.failures)!;
    assert.match(note, /did not produce a usable image/);
  } finally {
    for (const entry of result.images) await fs.remove(resolveImageBlobPath(entry.part.inlineDataRef!.blobId!));
  }
});

test('non-raster and SVG-like payloads are rejected', async () => {
  const notAnImage = Buffer.from('<!doctype html><svg></svg>');
  const result = await externalizeGeneratedImageItems(
    [{ type: 'image_generation_call', id: 'ig_svg', status: 'completed', output_format: 'png', result: notAnImage.toString('base64') }],
    { sourceModelId: 'm' },
  );
  assert.equal(result.images.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /recognized raster image/);
});

test('sanitizer keeps safe replay fields and drops binary fields', () => {
  const item = {
    type: 'image_generation_call',
    id: 'ig_x',
    status: 'completed',
    output_format: 'png',
    size: '1024x1024',
    result: 'AAAA',
    b64_json: 'BBBB',
    unknown_binary: 'CCCC',
  };
  const sanitized = sanitizeImageGenerationOutputItem(item);
  assert.equal(sanitized.result, undefined);
  assert.equal((sanitized as any).b64_json, undefined);
  assert.equal((sanitized as any).unknown_binary, undefined);
  assert.equal(sanitized.id, 'ig_x');
  assert.equal(sanitized.size, '1024x1024');
  // Non-destructive: the provider object is unchanged.
  assert.equal(item.result, 'AAAA');

  const replay = buildImageGenerationReplayItem(sanitized, 'RESULTBASE64');
  assert.equal(replay.result, 'RESULTBASE64');
  assert.equal(replay.type, 'image_generation_call');
  assert.equal(replay.quality, undefined);
});

test('call detection, id derivation and bounded helpers behave deterministically', () => {
  assert.equal(isImageGenerationCallItem({ type: 'image_generation_call' }), true);
  assert.equal(isImageGenerationCallItem({ type: 'message' }), false);
  assert.equal(isImageGenerationCallItem(null), false);
  assert.equal(isCompletedImageGenerationItem({ type: 'image_generation_call', status: 'completed', result: 'abc' }), true);
  assert.equal(isCompletedImageGenerationItem({ type: 'image_generation_call', status: 'in_progress', result: 'abc' }), false);
  assert.equal(isCompletedImageGenerationItem({ type: 'image_generation_call', result: '' }), false);

  assert.equal(deriveGeneratedImageId('ig_ABC-123', 0), 'ig_ig_ABC-123');
  assert.equal(deriveGeneratedImageId('weird/../id', 0), 'ig_weirdid');
  assert.equal(deriveGeneratedImageId(undefined, 4), 'ig_image5');

  const longFailures = Array.from({ length: 40 }, (_, index) => ({ imageId: `ig_${index}`, reason: 'x'.repeat(40) }));
  const note = formatGeneratedImageFailureNote(longFailures)!;
  assert.ok(note.length < 720);
  assert.match(formatGeneratedImageModelPlaceholder(), /does not receive its image content/);
});
