'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findGptModelCandidates, WEB_SEARCH_REQUEST_TIMEOUT_MS } = require('./web-search.js');

test('OpenAI and Gemini web-search requests share a 240-second timeout', () => {
  assert.equal(WEB_SEARCH_REQUEST_TIMEOUT_MS, 240000);
});

test('raw models reader skips virtual providers and discovers concrete GPT leaves only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-web-search-models-'));
  const modelsPath = path.join(dir, 'models.yaml');
  fs.writeFileSync(modelsPath, `
default: sticky
providers:
  concrete:
    providerType: openai-completions
    baseUrl: https://example.test/v1
    apiKey: usable-test-key
    models: [gpt-5.4]
  sticky:
    providerType: session-hash
    targets: [concrete/gpt-5.4]
  fallback:
    providerType: failover
    targets: [concrete/gpt-5.4, other/gpt-5.3]
`, 'utf8');

  try {
    const candidates = findGptModelCandidates(modelsPath);
    assert.deepEqual(candidates.map(candidate => `${candidate.providerKey}/${candidate.model}`), ['concrete/gpt-5.4']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
