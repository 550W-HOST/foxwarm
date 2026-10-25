import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBrowserScreenshotResult } from '../background/toolResults.js';

test('browser extension screenshots use the canonical structured image result', async () => {
  const result = buildBrowserScreenshotResult('browser-image-base64', {
    tabId: 19,
    url: 'https://example.test/',
    title: 'Example',
  });

  assert.deepEqual(result, {
    tabId: 19,
    url: 'https://example.test/',
    title: 'Example',
    output: '[Screenshot of browser tab 19]',
    mimeType: 'image/png',
    inlineData: {
      data: 'browser-image-base64',
      mimeType: 'image/png',
    },
  });
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'image'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'screenshot'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'encoding'), false);
});
