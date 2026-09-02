import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import {
  collectGeminiStream,
  convertJsonSchemaToGeminiSchema,
  convertToGeminiFormat,
} from './gemini';
import type { Message } from '../types';

function makeStream(events: any[]): PassThrough {
  const stream = new PassThrough();
  process.nextTick(() => {
    for (const event of events) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    stream.end();
  });
  return stream;
}

test('convertToGeminiFormat preserves text, thought signatures, tools and images', () => {
  const messages: Message[] = [
    { role: 'user', parts: [{ text: 'hello' }, { inlineData: { mimeType: 'image/png', data: 'abc' } }] },
    {
      role: 'model',
      parts: [
        { thinking: 'plan', providerMeta: { signature: 'sig' } },
        { functionCall: { id: 'call-1', name: 'read', args: { filePath: 'a' } }, providerMeta: { signature: 'call-sig' } },
      ],
    },
    {
      role: 'tool',
      parts: [
        {
          functionResponse: {
            tool_use_id: 'call-1',
            name: 'read',
            response: { output: 'done' },
            previousLlmRequest: { time: '2026-09-02T00:00:00Z', durationMs: 1234 },
          },
        },
        { toolUseId: 'call-1', inlineData: { mimeType: 'image/jpeg', data: 'xyz' } },
      ],
    },
  ];

  const converted = convertToGeminiFormat(messages);
  assert.equal(converted.length, 3);
  assert.deepEqual(converted[0], {
    role: 'user',
    parts: [{ text: 'hello' }, { inlineData: { mimeType: 'image/png', data: 'abc' } }],
  });
  assert.deepEqual(converted[1].parts[0], { text: 'plan', thought: true, thoughtSignature: 'sig' });
  assert.deepEqual(converted[1].parts[1], {
    functionCall: { id: 'call-1', name: 'read', args: { filePath: 'a' } },
    thoughtSignature: 'call-sig',
  });
  assert.equal(converted[2].parts[0].functionResponse.id, 'call-1');
  assert.equal(converted[2].parts[0].functionResponse.name, 'read');
  assert.match(converted[2].parts[0].functionResponse.response.output, /done/);
  assert.match(converted[2].parts[1].text, /prevLLMReqTime="1\.2s"/);
  assert.deepEqual(converted[2].parts[2], { inlineData: { mimeType: 'image/jpeg', data: 'xyz' } });
});

test('convertToGeminiFormat keeps all function responses ahead of timing and interruption text', () => {
  const converted = convertToGeminiFormat([
    {
      role: 'model',
      parts: [
        { functionCall: { id: 'call-a', name: 'a', args: {} } },
        { functionCall: { id: 'call-b', name: 'b', args: {} } },
      ],
    },
    { role: 'user', parts: [{ system: 'interruption' }] },
    {
      role: 'tool',
      parts: [
        {
          functionResponse: {
            tool_use_id: 'call-a', name: 'a', response: { output: 'A' },
            previousLlmRequest: { time: '2026-09-02T00:00:00Z', durationMs: 1000 },
          },
        },
        { functionResponse: { tool_use_id: 'call-b', name: 'b', response: { output: 'B' } } },
      ],
    },
  ]);

  assert.equal(converted.length, 2);
  assert.deepEqual(converted[1].parts.slice(0, 2).map((part: any) => part.functionResponse?.id), ['call-a', 'call-b']);
  assert.ok(converted[1].parts.slice(2).every((part: any) => !part.functionResponse));
  assert.match(converted[1].parts[2].text, /kind="system"/);
  assert.match(converted[1].parts[3].text, /prevLLMReqTime="1\.0s"/);
});

test('convertToGeminiFormat merges adjacent provider roles without mutating source', () => {
  const source: Message[] = [
    { role: 'user', parts: [{ text: 'a' }] },
    { role: 'user', parts: [{ text: 'b' }] },
    { role: 'model', parts: [{ text: 'c' }] },
  ];
  const before = structuredClone(source);
  assert.deepEqual(convertToGeminiFormat(source), [
    { role: 'user', parts: [{ text: 'a' }, { text: 'b' }] },
    { role: 'model', parts: [{ text: 'c' }] },
  ]);
  assert.deepEqual(source, before);
});

test('convertJsonSchemaToGeminiSchema strips unsupported object keywords recursively', () => {
  assert.deepEqual(convertJsonSchemaToGeminiSchema({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      value: { type: 'string', description: 'value' },
      nested: { type: 'object', patternProperties: { x: { type: 'number' } }, properties: { count: { type: 'integer' } } },
      optional: { type: ['string', 'null'] },
      mode: { const: 'fast' },
      referenced: { $ref: '#/$defs/item' },
    },
    required: ['value'],
    $defs: { item: { type: 'object', additionalProperties: false, properties: { id: { type: 'string' } } } },
  }), {
    type: 'object',
    properties: {
      value: { type: 'string', description: 'value' },
      nested: { type: 'object', properties: { count: { type: 'integer' } } },
      optional: { type: 'string', nullable: true },
      mode: { enum: ['fast'] },
      referenced: { type: 'object', properties: { id: { type: 'string' } } },
    },
    required: ['value'],
  });
});

test('collectGeminiStream aggregates text, thoughts, tools, image output and usage', async () => {
  const stream = makeStream([
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'think ', thought: true, thoughtSignature: 'sig-1' }, { text: 'Hel' }] } }],
    },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }, { functionCall: { name: 'read', args: { filePath: 'x' } }, thoughtSignature: 'sig-2' }] }, finishReason: 'STOP' }],
    },
    {
      candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'image/png', data: 'abc' } }] } }],
      usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 3, cachedContentTokenCount: 2 },
    },
  ]);
  const progress: any[] = [];
  const blocks: string[] = [];
  const response = await collectGeminiStream(stream, new AbortController().signal, {
    onProgress: snapshot => progress.push(structuredClone(snapshot)),
    onRawSseBlock: block => blocks.push(block),
  });

  assert.equal(response.candidates[0].finishReason, 'STOP');
  assert.equal(response.candidates[0].content.parts[0].text, 'think ');
  assert.equal(response.candidates[0].content.parts[2].text, 'lo');
  assert.match(response.candidates[0].content.parts[3].functionCall.id, /^gemini_[a-f0-9]{20}$/);
  assert.deepEqual(response.usageMetadata, { promptTokenCount: 11, candidatesTokenCount: 7, thoughtsTokenCount: 3, cachedContentTokenCount: 2 });
  assert.ok(progress.some(snapshot => snapshot.reasoning === 'think ' && snapshot.text === 'Hello'));
  assert.ok(progress.some(snapshot => snapshot.toolCalls?.[0]?.name === 'read'));
  assert.equal(blocks.length, 3);
});

test('collectGeminiStream aborts an active stream', async () => {
  const stream = new PassThrough();
  const controller = new AbortController();
  const pending = collectGeminiStream(stream, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => (error as any).name === 'AbortError');
});
