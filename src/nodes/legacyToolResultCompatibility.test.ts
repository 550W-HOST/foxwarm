import test from 'node:test';
import assert from 'node:assert/strict';

import { NodesManager } from './manager';
import { normalizeToolResultImages } from '../toolImages';
import { adaptLegacyRemoteNodeToolResult } from './legacyToolResultCompatibility';

const IMAGE_DATA = 'legacy-image-base64';
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WnSUs8AAAAASUVORK5CYII=';

test('legacy remote-node compatibility adapts browser image objects and preserves result metadata', () => {
  assert.deepEqual(adaptLegacyRemoteNodeToolResult({
    image: IMAGE_DATA,
    format: 'png',
    encoding: 'BASE64',
    tabId: 17,
    url: 'https://example.test/',
    title: 'Example',
  }), {
    tabId: 17,
    url: 'https://example.test/',
    title: 'Example',
    inlineData: { data: IMAGE_DATA, mimeType: 'image/png' },
  });

  assert.deepEqual(adaptLegacyRemoteNodeToolResult({
    image: IMAGE_DATA,
    format: 'jpg',
    encoding: 'base64',
    mimeType: 'image/webp',
    output: 'legacy screenshot',
  }), {
    mimeType: 'image/webp',
    output: 'legacy screenshot',
    inlineData: { data: IMAGE_DATA, mimeType: 'image/webp' },
  });
});

test('legacy remote-node compatibility adapts screenshot fields and magic marker outputs', () => {
  assert.deepEqual(adaptLegacyRemoteNodeToolResult({
    id: 'tab_remote',
    url: 'https://example.test/',
    title: 'Example',
    screenshot: IMAGE_DATA,
    mimeType: 'image/png',
  }), {
    id: 'tab_remote',
    url: 'https://example.test/',
    title: 'Example',
    mimeType: 'image/png',
    inlineData: { data: IMAGE_DATA, mimeType: 'image/png' },
  });

  assert.deepEqual(adaptLegacyRemoteNodeToolResult({
    output: `__IMAGE__:image/jpeg:${IMAGE_DATA}`,
    path: '/remote/legacy.jpg',
  }), {
    path: '/remote/legacy.jpg',
    inlineData: { data: IMAGE_DATA, mimeType: 'image/jpeg' },
  });

  assert.deepEqual(adaptLegacyRemoteNodeToolResult({
    output: `__SCREENSHOT__:${IMAGE_DATA}`,
    tabId: 'tab1',
  }), {
    tabId: 'tab1',
    inlineData: { data: IMAGE_DATA, mimeType: 'image/png' },
  });
});

test('legacy remote-node compatibility leaves canonical, malformed, and ordinary results unchanged', () => {
  const values = [
    'plain node output',
    null,
    { output: '__IMAGE__:not-an-image:payload' },
    { output: '__SCREENSHOT__:' },
    { image: IMAGE_DATA, format: 'png', encoding: 'utf8' },
    { image: IMAGE_DATA, format: '', encoding: 'base64' },
    { screenshot: IMAGE_DATA, mimeType: 'application/octet-stream' },
    {
      output: `__SCREENSHOT__:${IMAGE_DATA}`,
      inlineData: { data: 'canonical-image', mimeType: 'image/png' },
    },
    {
      image: IMAGE_DATA,
      encoding: 'base64',
      format: 'png',
      inlineDataItems: [{ data: 'canonical-image', mimeType: 'image/png' }],
    },
  ];

  for (const value of values) {
    assert.strictEqual(adaptLegacyRemoteNodeToolResult(value), value);
  }
});

test('NodesManager applies legacy compatibility at the remote tool-response ingress', async () => {
  const manager = new NodesManager();
  const resultPromise = new Promise(resolve => {
    (manager as any).toolCalls.set('legacy-call', {
      id: 'legacy-call',
      name: 'browser_screenshot',
      args: {},
      sessionId: 'legacy-session',
      node: 'legacy-node',
      resolve,
      reject: () => {},
    });
  });

  manager.handleToolResponse('legacy-call', {
    output: `__SCREENSHOT__:${IMAGE_DATA}`,
    tabId: 42,
  });

  assert.deepEqual(await resultPromise, {
    tabId: 42,
    inlineData: { data: IMAGE_DATA, mimeType: 'image/png' },
  });
});

test('an adapted old-node result continues through the canonical image pipeline', async () => {
  const adapted = adaptLegacyRemoteNodeToolResult({
    image: TINY_PNG_BASE64,
    format: 'png',
    encoding: 'base64',
    tabId: 'old-browser-node',
  });
  const normalized = await normalizeToolResultImages(adapted, 'old-node-call', '[old node image]');

  assert.equal(normalized.imageParts.length, 1);
  assert.equal(normalized.imageParts[0].toolUseId, 'old-node-call');
  assert.equal(normalized.imageParts[0].inlineData?.data, TINY_PNG_BASE64);
  assert.equal(normalized.imageParts[0].imageMeta?.mimeType, 'image/png');
  assert.deepEqual(normalized.result, {
    tabId: 'old-browser-node',
    output: '[old node image]',
  });
});