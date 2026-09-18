import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import crypto from 'crypto';
import fs from 'fs-extra';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import sharp from 'sharp';
import { requestLlmOnce } from './llm';
import { LOGS_DIR } from './config';
import { resolveImageBlobPath, readImageRef } from './imageBlobs';
import { LLM_REQUEST_JOURNAL_DB_PATH } from './llmRequestJournal';
import type { Message } from './types';

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

async function makeRaster(format: 'png' | 'jpeg' | 'webp', width = 3, height = 2): Promise<Buffer> {
  const image = sharp({ create: { width, height, channels: 3, background: { r: 90, g: 120, b: 150 } } });
  if (format === 'png') return image.png().toBuffer();
  if (format === 'jpeg') return image.jpeg().toBuffer();
  return image.webp().toBuffer();
}

const MODEL_EFFORTS = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

function responsesEntry(overrides: Record<string, any> = {}): any {
  return {
    providerKey: 'fixture',
    providerType: 'openai-responses',
    baseUrl: 'https://fixture.example/v1',
    model: 'model',
    effort: { allowed: [...MODEL_EFFORTS], default: 'high' },
    extraFields: {},
    extraHeaders: {},
    ...overrides,
  };
}

async function runRequest(entry: any, options: Record<string, any> = {}) {
  return requestLlmOnce({
    contents: [{ role: 'user', parts: [{ text: 'draw a picture' }] }],
    systemPrompt: '',
    modelEntryOverride: entry,
    toolDefinitions: [],
    notifySessionEvents: false,
    registerAbortController: false,
    maxRetries: 1,
    ...options,
  });
}

function imageItem(id: string, resultBase64: string, outputFormat: string, extra: Record<string, any> = {}) {
  return {
    type: 'image_generation_call',
    id,
    status: 'completed',
    output_format: outputFormat,
    result: resultBase64,
    ...extra,
  };
}

function makeImageStream(options: {
  images?: Array<{ index: number; item: Record<string, any> }>;
  texts?: Array<{ index: number; text: string }>;
  functions?: Array<{ index: number; callId: string; name: string; args: string }>;
  searchIndexes?: number[];
}): PassThrough {
  const stream = new PassThrough();
  const output: any[] = [];
  process.nextTick(() => {
    for (const { index, item } of options.images || []) {
      stream.write(sse({ type: 'response.output_item.added', output_index: index, item: { type: 'image_generation_call', id: item.id, status: 'in_progress' } }));
      stream.write(sse({ type: 'response.image_generation_call.in_progress', output_index: index, item_id: item.id }));
      stream.write(sse({ type: 'response.image_generation_call.generating', output_index: index, item_id: item.id }));
      // A defensive partial preview that must never be persisted.
      stream.write(sse({ type: 'response.image_generation_call.partial_image', output_index: index, item_id: item.id, partial_image_b64: 'PARTIAL-CANARY' }));
      stream.write(sse({ type: 'response.image_generation_call.completed', output_index: index, item_id: item.id }));
      stream.write(sse({ type: 'response.output_item.done', output_index: index, item }));
      output[index] = item;
    }
    for (const { index, text } of options.texts || []) {
      stream.write(sse({ type: 'response.output_item.added', output_index: index, item: { type: 'message', role: 'assistant', content: [] } }));
      stream.write(sse({ type: 'response.content_part.added', output_index: index, content_index: 0, part: { type: 'output_text', text: '' } }));
      stream.write(sse({ type: 'response.output_text.done', output_index: index, content_index: 0, text }));
      output[index] = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] };
    }
    for (const index of options.searchIndexes || []) {
      output[index] = { type: 'web_search_call', id: `ws_${index}`, status: 'completed' };
    }
    for (const { index, callId, name, args } of options.functions || []) {
      stream.write(sse({ type: 'response.output_item.added', output_index: index, item: { type: 'function_call', call_id: callId, name, arguments: '' } }));
      stream.write(sse({ type: 'response.function_call_arguments.done', output_index: index, arguments: args }));
      output[index] = { type: 'function_call', call_id: callId, name, arguments: args, id: callId };
    }
    stream.write(sse({ type: 'response.completed', response: { output: output.filter(Boolean), usage: { input_tokens: 5, output_tokens: 7 } } }));
    stream.write('data: [DONE]\n\n');
    stream.end();
  });
  return stream;
}

function captureAxios(streamFactory: (url: string, body: any) => PassThrough) {
  const originalPost = axios.post;
  const captured: Array<{ url: string; body: any }> = [];
  (axios as any).post = async (url: string, body: any) => {
    captured.push({ url, body });
    return { status: 200, statusText: 'OK', headers: {}, data: streamFactory(url, body) };
  };
  return {
    captured,
    restore: () => { (axios as any).post = originalPost; },
  };
}

function imageTool(body: any): any {
  return (body.tools || []).find((tool: any) => tool?.type === 'image_generation');
}

async function collectLogEntries(): Promise<Array<{ file: string; text: string }>> {
  const root = LOGS_DIR;
  if (!await fs.pathExists(root)) return [];
  const entries: Array<{ file: string; text: string }> = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(target);
      else entries.push({ file: target, text: await fs.readFile(target, 'utf8').catch(() => '') });
    }
  };
  await walk(root);
  return entries;
}

test('function, web search, and image generation tools coexist without duplicates', async () => {
  const png = await makeRaster('png');
  const cap = captureAxios(() => makeImageStream({ images: [{ index: 0, item: imageItem('ig_q1', png.toString('base64'), 'png') }] }));
  try {
    const result = await runRequest(responsesEntry({
      imageGeneration: { enabled: true, outputFormat: 'png', size: '1024x1024' },
      webSearch: { enabled: true, toolChoice: 'auto' },
    }), {
      toolDefinitions: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
    });
    const tools = cap.captured[0].body.tools;
    assert.deepEqual(tools.map((tool: any) => tool.type), ['function', 'web_search', 'image_generation']);
    assert.deepEqual(imageTool(cap.captured[0].body), {
      type: 'image_generation',
      output_format: 'png',
      size: '1024x1024',
      partial_images: 0,
    });
    assert.equal(cap.captured.length, 1);
    assert.equal(result.allParts?.filter(part => !!part.inlineDataRef).length, 1);
    await fs.remove(resolveImageBlobPath(result.allParts![0].inlineDataRef!.blobId!));
  } finally {
    cap.restore();
  }
});

test('compact-plan and setup-test never inject the hosted image tool', async () => {
  const png = await makeRaster('png');
  for (const purpose of ['compact-plan', 'setup-test']) {
    const cap = captureAxios(() => makeImageStream({ images: [{ index: 0, item: imageItem('ig_q2', png.toString('base64'), 'png') }] }));
    try {
      await runRequest(responsesEntry({ imageGeneration: { enabled: true } }), {
        purpose,
        toolDefinitions: [{ name: 'read', description: 'Read a file', parameters: { type: 'object' } }],
      });
      assert.equal(imageTool(cap.captured[0].body), undefined);
      assert.equal(cap.captured.length, 1);
    } finally {
      cap.restore();
    }
  }
});

test('enabled image generation on an unsupported protocol fails before any request', async () => {
  const cap = captureAxios(() => makeImageStream({ images: [] }));
  try {
    await assert.rejects(
      () => runRequest(responsesEntry({ providerType: 'openai-completions', imageGeneration: { enabled: true } })),
      /provider type `openai-completions` does not support the OpenAI Responses image_generation tool/,
    );
    assert.equal(cap.captured.length, 0);
  } finally {
    cap.restore();
  }
});

test('extraFields cannot bypass or conflict with the image generation config', async () => {
  const cap = captureAxios(() => makeImageStream({ images: [] }));
  try {
    await assert.rejects(
      () => runRequest(responsesEntry({
        imageGeneration: { enabled: true },
        extraFields: { tools: [{ type: 'function', name: 'read' }] },
      })),
      /extraFields\.tools cannot replace the tool list/,
    );
    await assert.rejects(
      () => runRequest(responsesEntry({ extraFields: { tools: [{ type: 'image_generation' }] } })),
      /extraFields\.tools must not declare the hosted image_generation tool/,
    );
    await assert.rejects(
      () => runRequest(responsesEntry({ extraFields: { tool_choice: { type: 'image_generation' } } })),
      /extraFields\.tool_choice references the image_generation tool/,
    );
    assert.equal(cap.captured.length, 0);
  } finally {
    cap.restore();
  }
});

test('a pure image reply succeeds once, stores one blob, and is not treated as empty', async () => {
  const png = await makeRaster('png');
  const base64 = png.toString('base64');
  const cap = captureAxios(() => makeImageStream({ images: [{ index: 0, item: imageItem('ig_pure', base64, 'png', { revised_prompt: 'a small duck' }) }] }));
  try {
    const result = await runRequest(responsesEntry({ imageGeneration: { enabled: true }, disallowEmptyResponse: true }), { maxRetries: 3 });
    assert.equal(cap.captured.length, 1);
    assert.equal(result.text, '');
    assert.deepEqual(result.toolCalls, []);
    const imageParts = (result.allParts || []).filter(part => !!part.inlineDataRef);
    assert.equal(imageParts.length, 1);
    const part = imageParts[0];
    assert.equal(part.imageMeta?.origin, 'generated');
    assert.equal(part.imageMeta?.sha256, crypto.createHash('sha256').update(png).digest('hex'));
    assert.equal(await readImageRef(part.inlineDataRef!).then(buffer => buffer.length), png.length);
    // Persisted metadata never carries the provider result.
    const partJson = JSON.stringify(part);
    assert.equal(partJson.includes(base64), false);
    assert.equal((part.providerMeta!.openaiResponses!.outputItem as any).result, undefined);
    assert.equal((part.providerMeta!.openaiResponses!.outputItem as any).revised_prompt, 'a small duck');
    await fs.remove(resolveImageBlobPath(part.inlineDataRef!.blobId!));
  } finally {
    cap.restore();
  }
});

test('text, reasoning-style search, image, and function outputs are all preserved in order', async () => {
  const png = await makeRaster('png');
  const cap = captureAxios(() => makeImageStream({
    images: [{ index: 1, item: imageItem('ig_mix', png.toString('base64'), 'png') }],
    texts: [{ index: 0, text: 'Here is the picture:' }],
    searchIndexes: [],
    functions: [{ index: 2, callId: 'call_1', name: 'read', args: '{"filePath":"a.txt"}' }],
  }));
  try {
    const result = await runRequest(responsesEntry({ imageGeneration: { enabled: true } }));
    assert.equal(cap.captured.length, 1);
    assert.equal(result.text, 'Here is the picture:');
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'read');
    const order = (result.allParts || []).map(part =>
      part.text !== undefined ? 'text' : part.inlineDataRef ? 'image' : part.functionCall ? 'function' : 'other');
    assert.deepEqual(order, ['text', 'image', 'function']);
    await fs.remove(resolveImageBlobPath((result.allParts || []).find(part => part.inlineDataRef)!.inlineDataRef!.blobId!));
  } finally {
    cap.restore();
  }
});

test('surfaces png, jpeg, and webp results with matching MIME types', async () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const raster = await makeRaster(format);
    const cap = captureAxios(() => makeImageStream({ images: [{ index: 0, item: imageItem(`ig_${format}`, raster.toString('base64'), format) }] }));
    try {
      const result = await runRequest(responsesEntry({ imageGeneration: { enabled: true, outputFormat: format } }));
      const part = (result.allParts || []).find(entry => entry.inlineDataRef)!;
      const expectedMime = format === 'jpeg' ? 'image/jpeg' : `image/${format}`;
      assert.equal(part.inlineDataRef!.mimeType, expectedMime);
      assert.equal(part.imageMeta?.mimeType, expectedMime);
      assert.equal((await readImageRef(part.inlineDataRef!)).length, raster.length);
      await fs.remove(resolveImageBlobPath(part.inlineDataRef!.blobId!));
    } finally {
      cap.restore();
    }
  }
});

test('invalid or empty image results fail without a transparent retry', async () => {
  const cap = captureAxios(() => makeImageStream({ images: [{ index: 0, item: imageItem('ig_bad', 'not-valid-base64!!', 'png') }] }));
  try {
    await assert.rejects(
      () => runRequest(responsesEntry({ imageGeneration: { enabled: true } }), { maxRetries: 3 }),
      error => {
        const message = String((error as any)?.message || '');
        assert.match(message, /image|Image/);
        return true;
      },
    );
    // The provider must be called exactly once; a started image call is never retried.
    assert.equal(cap.captured.length, 1);
  } finally {
    cap.restore();
  }
});

test('provider response logs and persisted parts never contain the image base64 canary', async () => {
  const png = await makeRaster('png');
  const canary = png.toString('base64');
  const cap = captureAxios(() => makeImageStream({ images: [{ index: 0, item: imageItem('ig_log', canary, 'png') }] }));
  try {
    const result = await runRequest(responsesEntry({ imageGeneration: { enabled: true } }));
    assert.equal(JSON.stringify(result).includes(canary), false);
    const logEntries = await collectLogEntries();
    const canaryFiles = logEntries.filter(entry => entry.text.includes(canary)).map(entry => entry.file);
    assert.deepEqual(canaryFiles, []);
    const logText = logEntries.map(entry => entry.text).join('\n');
    // The response log must be redacted while still recording the call shape.
    assert.equal(logText.includes(canary), false);
    assert.equal(logText.includes('PARTIAL-CANARY'), false);
    // The durable request journal must never contain the provider base64.
    for (const journalFile of [LLM_REQUEST_JOURNAL_DB_PATH, `${LLM_REQUEST_JOURNAL_DB_PATH}-wal`]) {
      const buffer = await fs.readFile(journalFile).catch(() => Buffer.alloc(0));
      assert.equal(buffer.includes(Buffer.from(canary, 'utf8')), false, `journal ${path.basename(journalFile)} leaked the image payload`);
      assert.equal(buffer.includes(Buffer.from('PARTIAL-CANARY', 'utf8')), false);
    }
    await fs.remove(resolveImageBlobPath((result.allParts || [])[0].inlineDataRef!.blobId!));
  } finally {
    cap.restore();
  }
});

test('non-image RPC/provider failure paths still log a bounded request', async () => {
  const cap = captureAxios(() => makeImageStream({ texts: [{ index: 0, text: 'plain answer' }] }));
  try {
    const result = await runRequest(responsesEntry({}));
    assert.equal(result.text, 'plain answer');
    assert.equal(imageTool(cap.captured[0].body), undefined);
  } finally {
    cap.restore();
  }
});

test('canonical history is not mutated when a generated image is replayed', async () => {
  const { convertToOpenAIResponsesFormat } = await import('./llmProviders/openai');
  const png = await makeRaster('png');
  const base64 = png.toString('base64');
  const message: Message = {
    role: 'model',
    parts: [{
      inlineData: { data: base64, mimeType: 'image/png' },
      imageMeta: { imageId: 'ig_replay', origin: 'generated', mimeType: 'image/png' },
      providerMeta: {
        openaiResponses: {
          sourceModelId: 'fixture/model',
          outputItem: { type: 'image_generation_call', id: 'ig_replay', status: 'completed', output_format: 'png' },
        },
      },
    }],
  };
  const before = JSON.stringify(message);
  const input = convertToOpenAIResponsesFormat([message], 'fixture/model');
  assert.equal(input.length, 1);
  assert.equal(input[0].type, 'image_generation_call');
  assert.equal(input[0].result, base64);
  assert.equal(JSON.stringify(message), before);
  // No duplicate assistant input_image for the same blob.
  assert.equal(input.some((item: any) => item.type === 'message' && JSON.stringify(item).includes('input_image')), false);

  // A different concrete model receives an honest placeholder, not the native call.
  const otherModel = convertToOpenAIResponsesFormat([
    { ...message, parts: [{ ...message.parts[0], providerMeta: undefined }] },
  ], 'other/model');
  assert.equal(otherModel.some((item: any) => item.type === 'image_generation_call'), false);
  assert.equal(JSON.stringify(otherModel).includes(base64), false);
  assert.match(JSON.stringify(otherModel), /does not receive its image content/);
});
