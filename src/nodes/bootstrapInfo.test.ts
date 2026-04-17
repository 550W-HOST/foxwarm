import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeBootstrapInfo, normalizeNodeBootstrapBaseUrl } from './bootstrapInfo';
import * as tools from '../tools';

test('normalizeNodeBootstrapBaseUrl accepts absolute http/https urls and strips trailing slash', () => {
  assert.equal(normalizeNodeBootstrapBaseUrl('https://example.com:3001/'), 'https://example.com:3001');
  assert.equal(normalizeNodeBootstrapBaseUrl('http://192.168.1.50:3001/base/'), 'http://192.168.1.50:3001/base');
});

test('normalizeNodeBootstrapBaseUrl rejects invalid values', () => {
  assert.throws(() => normalizeNodeBootstrapBaseUrl('/relative/path'), /absolute URL/i);
  assert.throws(() => normalizeNodeBootstrapBaseUrl('ftp://example.com'), /http:\/\/ or https:\/\//i);
});

test('buildNodeBootstrapInfo reports unresolved external base url when tool caller does not provide one', () => {
  const result = buildNodeBootstrapInfo({ pairingToken: 'TOKEN123' });

  assert.equal(result.pairingToken, 'TOKEN123');
  assert.equal(result.baseUrl.normalizedBaseUrl, null);
  assert.equal(result.baseUrl.requestDerivedDefaultBaseUrl, null);
  assert.equal(result.baseUrl.requestDerivedDefaultBaseUrlStatus, 'unresolved-in-tool-context');
  assert.match(result.baseUrl.explanation, /cannot infer/i);
  assert.equal(result.endpoints.runShPath, '/node/run.sh');
  assert.equal(result.endpoints.runShUrl, null);
  assert.match(result.examples?.bareMetal || '', /\$BASE_URL\/node\/run\.sh/);
});

test('buildNodeBootstrapInfo uses provided baseUrl as the would-be request-derived default when fetching bootstrap scripts from it', () => {
  const result = buildNodeBootstrapInfo({ pairingToken: 'TOKEN123', baseUrl: 'https://example.com:8443/foxwarm/' });

  assert.equal(result.baseUrl.normalizedBaseUrl, 'https://example.com:8443/foxwarm');
  assert.equal(result.baseUrl.requestDerivedDefaultBaseUrl, 'https://example.com:8443/foxwarm');
  assert.equal(result.baseUrl.requestDerivedDefaultBaseUrlStatus, 'resolved-from-provided-base-url');
  assert.equal(result.endpoints.runDockerShUrl, 'https://example.com:8443/foxwarm/node/run-docker.sh');
  assert.match(result.examples?.manualCompose || '', /NODE_HOST=https:\/\/example\.com:8443\/foxwarm/);
});

test('tool catalog includes node_bootstrap_info', () => {
  assert.equal(tools.definitions.some(def => def.name === 'node_bootstrap_info'), true);
});