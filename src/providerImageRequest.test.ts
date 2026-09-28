import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import crypto from 'crypto';
import sharp from 'sharp';
import axios from 'axios';
import { PassThrough } from 'node:stream';
import type { Message } from './types';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-image-request-'));
fs.ensureDirSync(path.join(dataRoot, 'state'));
process.env.FOXWARM_DATA_DIR = dataRoot;
after(() => {
  fs.removeSync(dataRoot);
  delete process.env.FOXWARM_DATA_DIR;
});

function responseStream(): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
      id: 'resp_1', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    } })}\n\ndata: [DONE]\n\n`);
  });
  return stream;
}

function chatStream(): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    stream.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  return stream;
}

const entry = (providerType: string) => ({
  providerKey: 'fixture', providerType, baseUrl: 'https://fixture.invalid/v1', model: 'model',
  apiKey: '', extraFields: {}, extraHeaders: {},
});

const decodeDataUri = (url: string): { mime: string; bytes: Buffer } => {
  const match = /^data:(image\/[^;]+);base64,([A-Za-z0-9+/=]+)$/.exec(url);
  assert.ok(match);
  return { mime: match[1], bytes: Buffer.from(match[2], 'base64') };
};

test('all three physical request bodies use optimized bytes, preserve canonical refs and deduplicate final MIME/bytes', async () => {
  const { putImageBlob, readImageRef } = await import('./imageBlobs');
  const { requestLlmOnce } = await import('./llm');
  const originalPost = axios.post;
  const source = await sharp(crypto.randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
  const ref = await putImageBlob({ buffer: source, mimeType: 'image/png', imageId: 'upload' });
  const canonical: Message[] = [
    { role: 'user', parts: [{ text: 'edit this' }, { inlineDataRef: ref }] },
    { role: 'user', parts: [{ inlineDataRef: ref }] },
  ];
  const snapshot = structuredClone(canonical);
  try {
    for (const providerType of ['openai-responses', 'openai-completions', 'anthropic']) {
      let wire: any;
      (axios as any).post = async (_url: string, data: any) => {
        wire = typeof data === 'string' ? JSON.parse(data) : data;
        return providerType === 'anthropic'
          ? { status: 200, statusText: 'OK', headers: {}, data: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } }
          : { status: 200, statusText: 'OK', headers: {}, data: providerType === 'openai-completions' ? chatStream() : responseStream() };
      };
      await requestLlmOnce({
        contents: canonical, systemPrompt: '', modelEntryOverride: entry(providerType) as any,
        toolDefinitions: [], notifySessionEvents: false, registerAbortController: false, maxRetries: 1,
      });
      const serialized = JSON.stringify(wire);
      assert.equal((serialized.match(/base64,/g) || []).length, providerType === 'anthropic' ? 0 : 1);
      assert.match(serialized, /deduplicated=true/);
      const inputUri = serialized.match(/data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+/);
      const image = providerType === 'anthropic'
        ? { mime: wire.messages[0].content.find((part: any) => part.type === 'image').source.media_type,
            bytes: Buffer.from(wire.messages[0].content.find((part: any) => part.type === 'image').source.data, 'base64') }
        : decodeDataUri(inputUri![0]);
      assert.equal(image.mime, 'image/webp');
      assert.ok(image.bytes.length < source.length);
      assert.deepEqual(await sharp(image.bytes).metadata().then(meta => [meta.width, meta.height]), [512, 512]);
      assert.equal(serialized.includes(source.toString('base64')), false);
    }
    assert.deepEqual(await readImageRef(ref), source);
    assert.deepEqual(canonical, snapshot);
  } finally {
    (axios as any).post = originalPost;
  }
});

test('same-model generated call replays raw result, while ordinary tool-result use of its blob is optimized', async () => {
  const { putImageBlob } = await import('./imageBlobs');
  const { requestLlmOnce } = await import('./llm');
  const originalPost = axios.post;
  const source = await sharp(crypto.randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png().toBuffer();
  const ref = await putImageBlob({ buffer: source, mimeType: 'image/png', imageId: 'ig_1' });
  const history: Message[] = [
    { role: 'model', parts: [{
      inlineDataRef: ref,
      imageMeta: { origin: 'generated', imageId: 'ig_1', mimeType: 'image/png' },
      providerMeta: { openaiResponses: { sourceModelId: 'fixture/model', outputItem: { type: 'image_generation_call', id: 'ig_1', status: 'completed', output_format: 'png' } } },
    }, { functionCall: { id: 'call_1', name: 'read', args: {} } }] },
    { role: 'tool', parts: [
      { functionResponse: { tool_use_id: 'call_1', name: 'read', response: { ok: true } } },
      { inlineDataRef: ref, toolUseId: 'call_1', imageMeta: { origin: 'generated', imageId: 'tool-ig', mimeType: 'image/png' } },
    ] },
  ];
  const snapshot = structuredClone(history);
  try {
    let wire: any;
    (axios as any).post = async (_url: string, data: any) => {
      wire = typeof data === 'string' ? JSON.parse(data) : data;
      return { status: 200, statusText: 'OK', headers: {}, data: responseStream() };
    };
    await requestLlmOnce({ contents: history, systemPrompt: '', modelEntryOverride: entry('openai-responses') as any,
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false, maxRetries: 1 });
    const replay = wire.input.find((item: any) => item.type === 'image_generation_call');
    assert.equal(replay.result, source.toString('base64'));
    const tool = wire.input.find((item: any) => item.type === 'function_call_output');
    const visual = tool.output.find((item: any) => item.type === 'input_image');
    const image = decodeDataUri(visual.image_url);
    assert.equal(image.mime, 'image/webp');
    assert.ok(image.bytes.length < source.length);
    assert.deepEqual(history, snapshot);
  } finally { (axios as any).post = originalPost; }
});

test('corrupt original image fails locally before HTTP and never retries or silently changes generated-image history', async () => {
  const { putImageBlob, resolveImageBlobPath } = await import('./imageBlobs');
  const { requestLlmOnce } = await import('./llm');
  const originalPost = axios.post;
  const source = await sharp({ create: { width: 80, height: 80, channels: 3, background: 'blue' } }).png().toBuffer();
  const ref = await putImageBlob({ buffer: source, mimeType: 'image/png', imageId: 'lost' });
  const filename = resolveImageBlobPath(ref.blobId!);
  const retries: unknown[] = [];
  let calls = 0;
  (axios as any).post = async () => { calls += 1; throw new Error('must not call provider'); };
  try {
    await fs.writeFile(filename, Buffer.from('damaged'));
    const input: Message[] = [{ role: 'model', parts: [{
      inlineDataRef: ref,
      imageMeta: { origin: 'generated', imageId: 'lost', mimeType: 'image/png' },
      providerMeta: { openaiResponses: { sourceModelId: 'other/model', outputItem: { type: 'image_generation_call', id: 'ig_lost', status: 'completed' } } },
    }] }];
    await assert.rejects(() => requestLlmOnce({
      contents: input, systemPrompt: '', modelEntryOverride: entry('openai-responses') as any,
      toolDefinitions: [], notifySessionEvents: false, registerAbortController: false, maxRetries: 3,
      onRetry: item => { retries.push(item); },
    }), /failed byte-length validation/);
    assert.equal(calls, 0);
    assert.equal(retries.length, 0);
    assert.ok(input[0].parts[0].inlineDataRef);
  } finally {
    (axios as any).post = originalPost;
    await fs.remove(filename);
  }
});
