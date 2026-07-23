import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sharp from 'sharp';
import * as sessionManager from '../sessionManager';
import { image_crop, image_write_to_file } from '../tools';
import { normalizeToolResultImages } from '../toolImages';

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

  try {
    const base64 = await makePngBase64(5, 2);
    (sessionManager as any).getExistingSession = async () => ({
      id: 'image-write-session',
      history: [
        {
          role: 'tool',
          parts: [
            {
              toolUseId: 'call_source',
              inlineData: { mimeType: 'image/png', data: base64 },
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
  }
});
