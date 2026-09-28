import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeBootstrapInfo, NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER } from './bootstrapInfo';
import * as tools from '../tools';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
  assert.match(result.examples.manualCompose, /NODE_SOURCE_URL='\$COMPOSE_BASE_URL\/node\/source\.tar\.gz'/);
});

test('configured path URL is used in all endpoints and host flags, while origin uses HTTP request defaults', () => {
  const prefixed = buildNodeBootstrapInfo({ pairingToken: 'TOKEN123', publicUrl: "https://example.invalid/fox'base" });
  assert.equal(prefixed.baseUrl.configuredUrl, "https://example.invalid/fox'base");
  assert.equal(prefixed.endpoints.sourceUrl, "https://example.invalid/fox'base/node/source.tar.gz");
  assert.equal(prefixed.examples.chooseBaseUrl, `BASE_URL='https://example.invalid/fox'"'"'base'`);
  for (const command of [prefixed.examples.bareMetal, prefixed.examples.bareMetalInstall, prefixed.examples.bareMetalBackground, prefixed.examples.docker, prefixed.examples.interactive]) {
    assert.match(command, /--host="\$BASE_URL"/);
  }
  assert.match(prefixed.examples.windows, /-HostUrl 'https:\/\/example.invalid\/fox''base'/);

  const origin = buildNodeBootstrapInfo({ pairingToken: 'TOKEN123', publicUrl: 'https://example.invalid' });
  assert.equal(origin.endpoints.runShUrl, 'https://example.invalid/node/run.sh');
  assert.doesNotMatch(origin.examples.bareMetal, /--host=/);
  assert.doesNotMatch(origin.examples.windows, /-HostUrl/);
});

test('generated manual Compose commands preserve a path with shell/Compose metacharacters', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-node-compose-example-'));
  try {
    const bin = path.join(root, 'bin');
    await fs.ensureDir(bin);
    for (const command of ['curl', 'docker']) {
      await fs.writeFile(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
    const url = "https://example.invalid/fox'base/$literal";
    const example = buildNodeBootstrapInfo({ pairingToken: 'TOKEN123', publicUrl: url });
    await execFileAsync('/bin/bash', ['-c', `${example.examples.chooseBaseUrl}\n${example.examples.manualCompose}`], {
      cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 3_000,
    });
    const envFile = await fs.readFile(path.join(root, '.env'), 'utf8');
    assert.match(envFile, /NODE_HOST='https:\/\/example.invalid\/fox\\'base\/\$literal'/);
    assert.match(envFile, /NODE_SOURCE_URL='https:\/\/example.invalid\/fox\\'base\/\$literal\/node\/source.tar.gz'/);
    assert.equal((await fs.stat(path.join(root, '.env'))).mode & 0o077, 0);
  } finally {
    await fs.remove(root);
  }
});

test('tool catalog includes node_bootstrap_info with no required baseUrl parameter', () => {
  const def = tools.definitions.find(def => def.name === 'node_bootstrap_info');
  assert.ok(def);
  assert.deepEqual(def?.parameters?.properties || {}, {});
});
