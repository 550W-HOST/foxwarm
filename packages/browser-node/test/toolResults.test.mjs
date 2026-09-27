import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

const helperUrl = new URL('../background/toolResults.js', import.meta.url);

async function loadPureHelper() {
  const source = await fs.readFile(helperUrl, 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

test('browser extension screenshots use the canonical structured image result', async () => {
  const { buildBrowserScreenshotResult } = await loadPureHelper();
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

  const toolsSource = await fs.readFile(new URL('../background/tools.js', import.meta.url), 'utf8');
  assert.match(toolsSource, /import \{ buildBrowserScreenshotResult \} from '\.\/toolResults\.js'/);
  assert.match(toolsSource, /return buildBrowserScreenshotResult\(base64, \{/);
  assert.doesNotMatch(toolsSource, /\bimage:\s*base64|\bscreenshot:\s*base64|\bencoding:\s*['"]base64/);
});