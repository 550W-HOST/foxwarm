import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeBootstrapInfo, NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER } from './bootstrapInfo';
import * as tools from '../tools';

test('buildNodeBootstrapInfo uses placeholder base-url semantics instead of pretending to know a unique external url', () => {
  const result = buildNodeBootstrapInfo({ pairingToken: 'TOKEN123' });

  assert.equal(result.pairingToken, 'TOKEN123');
  assert.equal(result.baseUrl.placeholder, NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER);
  assert.equal(result.baseUrl.requestDerivedDefaultInDownloadedScripts, NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER);
  assert.equal(result.baseUrl.canSystemKnowUniqueExternalBaseUrl, false);
  assert.match(result.baseUrl.explanation, /cannot reliably know/i);
  assert.match(result.baseUrl.operatorAction, /Choose BASE_URL/i);
  assert.equal(result.endpoints.runShUrl, '$BASE_URL/node/run.sh');
  assert.equal(result.endpoints.composeUrl, '$BASE_URL/node/docker-compose.yaml');
});

test('buildNodeBootstrapInfo examples use BASE_URL placeholders and pairing token', () => {
  const result = buildNodeBootstrapInfo({ pairingToken: 'TOKEN123' });

  assert.equal(result.examples.chooseBaseUrl, 'BASE_URL=http://YOUR_MASTER:3001');
  assert.match(result.examples.bareMetal, /\$BASE_URL\/node\/run\.sh/);
  assert.match(result.examples.bareMetal, /--dir=\/opt\/foxwarm-node/);
  assert.match(result.examples.bareMetal, /--pairing=TOKEN123/);
  assert.match(result.examples.bareMetalBackground, /-d/);
  assert.match(result.examples.bareMetalInstall, /--install/);
  assert.match(result.examples.explicitHostOverride, /--host="\$BASE_URL"/);
  assert.match(result.examples.manualCompose, /NODE_SOURCE_URL=\$BASE_URL\/node\/source\.tar\.gz/);
});

test('tool catalog includes node_bootstrap_info with no required baseUrl parameter', () => {
  const def = tools.definitions.find(def => def.name === 'node_bootstrap_info');
  assert.ok(def);
  assert.deepEqual(def?.parameters?.properties || {}, {});
});
