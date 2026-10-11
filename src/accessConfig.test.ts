import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAccessTokensDoNotMatch, authenticateAccessBearer, authenticateAccessToken, normalizeAccessConfig } from './accessConfig';
import { validateAppConfigYaml, writeRawAppConfig } from './setupConfig';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const secretA = '7b0ea817e9bb4ac3a8aa1';
const secretB = '9f321bc99fe64339b55d2';

const valid = () => ({
  identities: {
    alpha: { token: secretA, surfaces: { webui: { sessions: ['main/alpha'] }, mcp: {} } },
    beta: { token: secretB, surfaces: { mcp: {} } },
  },
});

test('access is empty by default and validates each configured surface', () => {
  assert.deepEqual(normalizeAccessConfig(undefined), { identities: {} });
  assert.deepEqual(Object.keys(normalizeAccessConfig({ identities: {} }).identities), []);
  const normalized = normalizeAccessConfig(valid());
  assert.deepEqual(normalized.identities.alpha.surfaces.webui?.sessions, ['main/alpha']);
  assert.deepEqual(normalized.identities.beta.surfaces, { mcp: {} });
  for (const malformed of [
    null, true, { identities: 'invalid' }, { identities: { 'not an id': valid().identities.alpha } },
    { identities: { alpha: { token: secretA } } },
    { identities: { alpha: { token: secretA, surfaces: {} } } },
    { identities: { alpha: { token: secretA, surfaces: { webui: { sessions: [] as string[] } } } } },
    { identities: { alpha: { token: secretA, surfaces: { webui: { sessions: ['main/alpha'], extra: true } } } } },
    { identities: { alpha: { token: secretA, surfaces: { mcp: { enabled: true } } } } },
    { identities: { alpha: { token: secretA, surfaces: { webui: { sessions: ['main/alpha'] } } }, beta: { token: secretA, surfaces: { mcp: {} } } } },
  ]) {
    assert.throws(() => normalizeAccessConfig(malformed), error => {
      assert.equal(String(error).includes(secretA), false);
      assert.equal(String(error).includes(secretB), false);
      return true;
    });
  }
});

test('WebUI session scopes accept only exact IDs and Agent wildcards', () => {
  const config = (sessions: string[]) => ({ identities: {
    scope: { token: secretA, surfaces: { webui: { sessions } } },
  } });
  const sessions = ['main/*', 'Agent_2-name/*', 'legacy name.with.punctuation'];
  assert.deepEqual(normalizeAccessConfig(config(sessions)).identities.scope.surfaces.webui?.sessions, sessions);
  for (const scope of ['*', 'agent*', 'agent/**', 'agent/name*', 'a/b/*', 'bad.name/*', ' agent/*', 'agent/* ']) {
    assert.throws(() => normalizeAccessConfig(config([scope])));
  }
});

test('configured identities cannot reuse the instance superuser token', () => {
  const config = normalizeAccessConfig({ identities: { identity: { token: secretA, surfaces: { mcp: {} } } } });
  assert.doesNotThrow(() => assertAccessTokensDoNotMatch(config, secretB));
  assert.throws(() => assertAccessTokensDoNotMatch(config, secretA), /must not reuse/);
});

test('one configured token authenticates only its declared surface', () => {
  const config = normalizeAccessConfig(valid());
  const alpha = authenticateAccessToken(config, secretA, 'webui');
  assert.equal(alpha?.identityId, 'alpha');
  assert.equal(authenticateAccessToken(config, secretB, 'webui'), null);
  assert.equal(authenticateAccessToken(config, secretA, 'mcp')?.externalId, 'alpha');
  assert.equal(authenticateAccessToken(config, secretB, 'mcp')?.identityId, 'beta');
  assert.equal(authenticateAccessBearer(config, `Bearer ${secretA}`)?.identityId, 'alpha');
  assert.equal(authenticateAccessBearer(config, 'Bearer instance-superuser-token'), null);
  for (const header of [undefined, `Bearer ${secretA} `, `Bearer ${secretA}, Bearer ${secretB}`, `Basic ${secretA}`, 'Bearer wrong', [`Bearer ${secretA}`]]) {
    assert.equal(authenticateAccessBearer(config, header as any), null);
  }
});

test('YAML validation accepts access and does not expose tokens in failures', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-access-config-'));
  const dest = path.join(dir, 'config.yaml');
  const original = 'bot:\n  name: existing\n';
  try {
    await fs.writeFile(dest, original);
    const accepted = `access:\n  identities:\n    alpha:\n      token: ${secretA}\n      surfaces:\n        webui:\n          sessions: [main/alpha]\n        mcp: {}\n`;
    assert.equal(validateAppConfigYaml(accepted).access?.identities?.alpha?.surfaces.webui?.sessions[0], 'main/alpha');
    writeRawAppConfig(accepted, dest);
    assert.equal(await fs.readFile(dest, 'utf8'), accepted);
    const invalid = `access:\n  identities:\n    alpha:\n      token: ${secretA}\n      surfaces:\n        mcp:\n          enabled: true\n`;
    assert.throws(() => writeRawAppConfig(invalid, dest), error => {
      assert.equal(String(error).includes(secretA), false);
      return true;
    });
    assert.equal(await fs.readFile(dest, 'utf8'), accepted);
  } finally {
    await fs.remove(dir);
  }
});

test('startup reads access identities from the replacement top-level block', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-access-startup-'));
  const configPath = path.join(dir, 'state', 'config.yaml');
  const start = () => spawnSync(process.execPath, ['-e', 'require(process.argv[1])', require.resolve('./config')], {
    env: { ...process.env, FOXWARM_DATA_DIR: dir }, encoding: 'utf8',
  });
  try {
    await fs.outputFile(configPath, `access:\n  identities:\n    smoke:\n      token: ${secretA}\n      surfaces:\n        mcp: {}\n`);
    assert.equal(start().status, 0);
  } finally {
    await fs.remove(dir);
  }
});
