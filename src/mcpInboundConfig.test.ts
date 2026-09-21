import assert from 'node:assert/strict';
import test from 'node:test';
import { authenticateMcpInboundBearer, normalizeMcpInboundConfig } from './mcpInboundConfig';
import { validateAppConfigYaml, writeRawAppConfig } from './setupConfig';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const secretA = '7b0ea817e9bb4ac3a8aa1';
const secretB = '9f321bc99fe64339b55d2';

const valid = () => ({
  enabled: true,
  identities: { alpha: { token: secretA }, beta: { token: secretB } },
});

test('mcpInbound is disabled by default but validates every supplied disabled block', () => {
  assert.deepEqual(normalizeMcpInboundConfig(undefined), { enabled: false, identities: {} });
  assert.equal(normalizeMcpInboundConfig({ enabled: false }).enabled, false);
  assert.deepEqual(Object.keys(normalizeMcpInboundConfig({ enabled: false }).identities), []);
  assert.deepEqual(Object.keys(normalizeMcpInboundConfig({ enabled: false, identities: { alpha: { token: secretA } } }).identities), ['alpha']);
  for (const malformed of [
    null, true, { enabled: 'true' }, { enabled: false, identities: 'ignored' },
    { enabled: false, identities: { alpha: {} } }, { enabled: false, unknown: secretA },
    { enabled: false, identities: { alpha: { token: secretA, extra: secretB } } },
    { enabled: true }, { enabled: true, identities: {} },
    { enabled: true, identities: { 'not an id': { token: secretA } } },
    { enabled: true, identities: { alpha: { token: '   ' } } },
    { enabled: true, identities: { alpha: { token: 123 } } },
    { enabled: true, identities: { alpha: { token: secretA }, beta: { token: secretA } } },
  ]) {
    assert.throws(() => normalizeMcpInboundConfig(malformed), error => {
      assert.equal(String(error).includes(secretA), false);
      assert.equal(String(error).includes(secretB), false);
      return true;
    });
  }
});

test('YAML validation rejects duplicate keys and invalid secrets without leaking their values', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-mcp-inbound-config-'));
  const dest = path.join(dir, 'config.yaml');
  const original = 'bot:\n  name: existing\n';
  try {
    await fs.writeFile(dest, original);
    const invalid = [
      `mcpInbound:\n  enabled: true\n  identities:\n    alpha:\n      token: ${secretA}\n      token: ${secretB}\n`,
      `mcpInbound:\n  enabled: true\n  identities:\n    alpha: { token: ${secretA} }\n    alpha: { token: ${secretB} }\n`,
      `mcpInbound:\n  enabled: false\n  identities:\n    alpha: { token: ${secretA}, unexpected: ${secretB} }\n`,
    ];
    for (const raw of invalid) {
      assert.throws(() => writeRawAppConfig(raw, dest), error => {
        assert.equal(String(error).includes(secretA), false);
        assert.equal(String(error).includes(secretB), false);
        if (raw.includes('token: ' + secretB)) assert.match(String(error), /line \d+, column \d+/);
        return true;
      });
      assert.equal(await fs.readFile(dest, 'utf8'), original);
    }
    const accepted = `mcpInbound:\n  enabled: true\n  identities:\n    alpha: { token: ${secretA} }\n    beta: { token: ${secretB} }\n`;
    assert.equal(validateAppConfigYaml(accepted).mcpInbound?.enabled, true);
    writeRawAppConfig(accepted, dest);
    assert.equal(await fs.readFile(dest, 'utf8'), accepted);
  } finally {
    await fs.remove(dir);
  }
});

test('Bearer authentication derives only the configured identity with no anonymous or instance-token fallback', () => {
  const config = normalizeMcpInboundConfig(valid());
  assert.equal(authenticateMcpInboundBearer(config, `Bearer ${secretA}`)?.externalId, 'alpha');
  assert.equal(authenticateMcpInboundBearer(config, `Bearer ${secretB}`)?.externalId, 'beta');
  assert.equal(authenticateMcpInboundBearer(config, `bearer ${secretA}`)?.externalId, 'alpha');
  for (const header of [undefined, `Bearer ${secretA} `, `Bearer ${secretA}, Bearer ${secretB}`,
    `Basic ${secretA}`, 'Bearer instance-management-token', 'Bearer wrong', [ `Bearer ${secretA}` ]]) {
    assert.equal(authenticateMcpInboundBearer(config, header), null);
  }
  assert.equal(authenticateMcpInboundBearer(normalizeMcpInboundConfig({ enabled: false, identities: valid().identities }), `Bearer ${secretA}`), null);
});

test('startup rejects a malformed disabled block and duplicate YAML keys without exposing tokens', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-mcp-inbound-startup-'));
  const configPath = path.join(dir, 'state', 'config.yaml');
  const start = () => spawnSync(process.execPath, ['-e', 'require(process.argv[1])', require.resolve('./config')], {
    env: { ...process.env, FOXWARM_DATA_DIR: dir }, encoding: 'utf8',
  });
  try {
    await fs.outputFile(configPath, 'mcpInbound:\n  enabled: false\n  identities: invalid\n');
    assert.notEqual(start().status, 0);
    await fs.outputFile(configPath, `mcpInbound:\n  enabled: true\n  identities:\n    alpha:\n      token: ${secretA}\n      token: ${secretB}\n`);
    const failure = start();
    assert.notEqual(failure.status, 0);
    assert.equal((failure.stderr + failure.stdout).includes(secretA), false);
    assert.equal((failure.stderr + failure.stdout).includes(secretB), false);
    assert.match(failure.stderr, /line \d+, column \d+/);
    await fs.outputFile(configPath, 'mcpInbound:\n  enabled: false\n  identities: {}\n');
    assert.equal(start().status, 0);
  } finally {
    await fs.remove(dir);
  }
});
