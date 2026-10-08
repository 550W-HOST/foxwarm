import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePublicUrl } from './config';
import { validateAppConfigYaml } from './setupConfig';

test('public url trims origin/path trailing slashes, retains encoded path, and is optional', () => {
  assert.equal(normalizePublicUrl(undefined), undefined);
  assert.equal(normalizePublicUrl('  https://example.invalid///  '), 'https://example.invalid');
  assert.equal(normalizePublicUrl('https://example.invalid/fox/%2F///'), 'https://example.invalid/fox/%2F');
  assert.equal(normalizePublicUrl('http://example.invalid:3001/nested'), 'http://example.invalid:3001/nested');
  assert.equal(validateAppConfigYaml('url: https://example.invalid/fox\n').url, 'https://example.invalid/fox');
});

test('public url rejects non-http, relative, credentialed, query, fragment, and empty values in runtime and setup', () => {
  for (const url of ['', '/relative', 'ftp://example.invalid', 'https://user:pass@example.invalid/', 'https://example.invalid/?x=1', 'https://example.invalid/#part']) {
    assert.throws(() => normalizePublicUrl(url), /app config `url`/);
    assert.throws(() => validateAppConfigYaml(`url: ${JSON.stringify(url)}\n`), /app config `url`/);
  }
});