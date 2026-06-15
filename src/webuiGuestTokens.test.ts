import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { createWebUiGuestToken, getWebUiGuestTokensPath, listWebUiGuestTokens, revokeWebUiGuestToken, verifyWebUiGuestToken } from './webuiGuestTokens';

async function withTempStore(run: (storePath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-webui-guest-tokens-'));
  try {
    await run(getWebUiGuestTokensPath(dirPath));
  } finally {
    await fs.remove(dirPath).catch(() => {});
  }
}

test('webui guest token is stored hashed and verifies bound sessions', async () => {
  await withTempStore(async (storePath) => {
    const { token, record } = await createWebUiGuestToken({ sessionIds: ['guest/main', 'guest/child', 'guest/main'], label: 'Demo' }, { storePath });

    assert.match(token, /^fwg_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/);
    assert.equal(record.label, 'Demo');
    assert.deepEqual(record.sessionIds, ['guest/main', 'guest/child']);

    const raw = await fs.readJson(storePath);
    assert.equal(raw.tokens[record.tokenId].tokenHash.startsWith('sha256:'), true);
    assert.equal(JSON.stringify(raw).includes(token), false);

    const verified = await verifyWebUiGuestToken(token, { storePath });
    assert.deepEqual(verified?.sessionIds, ['guest/main', 'guest/child']);
    assert.equal(verified?.tokenId, record.tokenId);
  });
});

test('webui guest token rejects tampered, expired, and revoked tokens', async () => {
  await withTempStore(async (storePath) => {
    const now = Date.now();
    const { token, record } = await createWebUiGuestToken({ sessionIds: ['guest/main'], expiresAt: now + 10_000, now }, { storePath });

    assert.equal(await verifyWebUiGuestToken(`${token}x`, { storePath }, now), null);
    assert.equal(await verifyWebUiGuestToken(token, { storePath }, now + 20_000), null);
    assert.equal(await revokeWebUiGuestToken(record.tokenId, { storePath }, now + 1_000), true);
    assert.equal(await verifyWebUiGuestToken(token, { storePath }, now + 2_000), null);

    const records = await listWebUiGuestTokens({ storePath });
    assert.equal(records.length, 1);
    assert.equal(records[0].revokedAt, now + 1_000);
  });
});
