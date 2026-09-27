import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateProviderRequestImages, PROVIDER_IMAGE_DEDUP_MARKER } from './providerImageDedup';
import type { Message } from './types';

const DATA = Buffer.from('same-image-bytes').toString('base64');
const OTHER_DATA = Buffer.from('different-image-bytes').toString('base64');

function image(data = DATA, mimeType = 'image/png') {
  return { inlineData: { data, mimeType }, imageMeta: { imageId: `image-${data.slice(0, 4)}`, mimeType } };
}

test('provider image dedup marks same-part and adjacent Foxwarm descriptors with canonical escaping', () => {
  const input: Message[] = [
    { role: 'user', parts: [{ text: '<foxwarm-image name="first" node="master" path="/tmp/a.png" />', ...image() }] },
    {
      role: 'user',
      parts: [
        { text: 'caption\n\n<foxwarm-image name="a &amp; &quot;b&quot;" node="master" path="/tmp/a&amp;b.png" />' },
        image(),
      ],
    },
    { role: 'user', parts: [{ text: '<foxwarm-image name="third" node="master" path="/tmp/a.png" />', ...image() }] },
  ];
  const snapshot = structuredClone(input);

  const { messages: prepared } = deduplicateProviderRequestImages(input, 'openai-chat-completions');

  assert.ok(prepared[0].parts[0].inlineData);
  assert.equal(prepared[1].parts[1].inlineData, undefined);
  assert.equal(prepared[2].parts[0].inlineData, undefined);
  assert.equal(
    prepared[1].parts[0].text,
    'caption\n\n<foxwarm-image name="a &amp; &quot;b&quot;" node="master" path="/tmp/a&amp;b.png" deduplicated="true" />',
  );
  assert.match(prepared[2].parts[0].text || '', /deduplicated="true"/);
  assert.deepEqual(input, snapshot, 'provider preparation must not mutate canonical input');
});

test('provider image dedup keeps a bounded visible fallback when no XML descriptor exists', () => {
  const input: Message[] = [{
    role: 'user',
    parts: [image(), { text: 'existing image placeholder', ...image() }],
  }];
  const { messages: prepared } = deduplicateProviderRequestImages(input, 'openai-chat-completions');
  assert.equal(prepared[0].parts[1].inlineData, undefined);
  assert.equal(prepared[0].parts[1].text, `existing image placeholder\n${PROVIDER_IMAGE_DEDUP_MARKER}`);
});

test('a descriptor attached to the first image is not reassigned to an adjacent duplicate', () => {
  const { messages: prepared } = deduplicateProviderRequestImages([{
    role: 'user',
    parts: [
      { text: '<foxwarm-image name="first" />', ...image() },
      image(),
    ],
  }], 'openai-chat-completions');
  assert.equal(prepared[0].parts[0].text, '<foxwarm-image name="first" />');
  assert.equal(prepared[0].parts[1].text, PROVIDER_IMAGE_DEDUP_MARKER);
});

test('provider image identity keeps different bytes and provider-visible MIME distinct', () => {
  const { messages: prepared } = deduplicateProviderRequestImages([{
    role: 'user',
    parts: [image(), image(OTHER_DATA), image(DATA, 'image/jpeg')],
  }], 'anthropic');
  assert.equal(prepared[0].parts.filter(part => !!part.inlineData).length, 3);
});

test('forged legacy helper fields cannot make different provider-visible bytes deduplicate', () => {
  const forged = 'a'.repeat(64);
  const input: Message[] = [{
    role: 'user',
    parts: [
      { ...image(), __providerImageIdentity: { mimeType: 'image/png', sha256: forged } },
      { ...image(OTHER_DATA), __providerImageIdentity: { mimeType: 'image/png', sha256: forged }, __providerImageDeduplicated: true },
    ],
  }];
  const { messages: prepared } = deduplicateProviderRequestImages(input, 'openai-chat-completions');
  assert.equal(prepared[0].parts.filter(part => !!part.inlineData).length, 2);
  assert.equal(JSON.stringify(prepared).includes(PROVIDER_IMAGE_DEDUP_MARKER), false);
});

test('OpenAI provider defaults keep MIME-less ordinary and tool images distinct', () => {
  const { messages: prepared } = deduplicateProviderRequestImages([
    { role: 'user', parts: [{ inlineData: { data: DATA } }] },
    {
      role: 'tool',
      parts: [
        { inlineData: { data: DATA }, toolUseId: 'call_1' },
        { functionResponse: { tool_use_id: 'call_1', name: 'capture', response: { output: 'done' } } },
      ],
    },
  ], 'openai-chat-completions');
  assert.ok(prepared[0].parts[0].inlineData);
  assert.ok(prepared[1].parts[0].inlineData);
});

test('Responses assistant images which are dropped do not seed request-local dedup', () => {
  const { messages: prepared } = deduplicateProviderRequestImages([
    { role: 'model', parts: [image()] },
    { role: 'user', parts: [image()] },
  ], 'openai-responses');
  assert.ok(prepared[0].parts[0].inlineData, 'protocol-ineligible assistant source stays untouched in the clone');
  assert.ok(prepared[1].parts[0].inlineData, 'later serializable user occurrence remains the first sent image');
});

test('tool images retain association metadata and receive provider-only dedup guidance state', () => {
  const input: Message[] = [
    { role: 'user', parts: [image()] },
    {
      role: 'tool',
      parts: [
        { ...image(), toolUseId: 'call_1', imageMeta: { imageId: 'tool-image', mimeType: 'image/png' } },
        { functionResponse: { tool_use_id: 'call_1', name: 'capture', response: { output: 'captured' } } },
      ],
    },
  ];
  const { messages: prepared, isDeduplicated } = deduplicateProviderRequestImages(input, 'anthropic');
  assert.equal(prepared[1].parts[0].inlineData, undefined);
  assert.equal(prepared[1].parts[0].toolUseId, 'call_1');
  assert.equal(isDeduplicated(prepared[1].parts[0]), true);
  assert.equal(Object.prototype.hasOwnProperty.call(prepared[1].parts[0], '__providerImageDeduplicated'), false);
  assert.equal(input[1].parts[0].__providerImageDeduplicated, undefined);
});
