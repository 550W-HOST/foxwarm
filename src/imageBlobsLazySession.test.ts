import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import sharp from 'sharp';

test('lazy live-session hydration imports nested legacy function-response images', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-image-lazy-'));
  process.env.FOXWARM_DATA_DIR = tempRoot;
  const sessionId = `lazy_nested_image_${Date.now()}`;
  const stateDir = path.join(tempRoot, 'state');
  const image = await sharp({ create: { width: 2, height: 1, channels: 3, background: { r: 9, g: 8, b: 7 } } }).png().toBuffer();
  const base64 = image.toString('base64');

  await fs.outputJson(path.join(stateDir, 'sessions.json'), {
    sessions: {
      [sessionId]: {
        id: sessionId,
        stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
        busy: false,
        queue: [],
        meta: { lastMessageTime: Date.now() },
      },
    },
  });
  const historyPath = path.join(stateDir, 'sessions', `${sessionId}.json`);
  await fs.outputJson(historyPath, {
    history: [{
      role: 'tool',
      parts: [{
        functionResponse: {
          tool_use_id: 'lazy_tool',
          name: 'legacy-image',
          response: {
            inlineData: { data: base64, mimeType: 'image/png' },
            marker: 'preserved',
          },
        },
      }],
      __meta: { seq: 1, timestamp: Date.now() },
    }],
    persistentMemorySnapshot: '',
    queue: [],
    nextMessageSeq: 2,
  });

  try {
    const sessionManager = await import('./sessionManager');
    await sessionManager.loadSessions();
    const session = await sessionManager.getExistingSession(sessionId);
    assert.ok(session);
    assert.equal(JSON.stringify(session.history).includes(base64), false);
    assert.equal(session.history[0].parts[0].functionResponse?.response.marker, 'preserved');
    assert.equal(session.history[0].parts[1].toolUseId, 'lazy_tool');
    assert.ok(session.history[0].parts[1].inlineDataRef?.blobId);
    assert.equal(JSON.stringify(await fs.readJson(historyPath)).includes(base64), false);
  } finally {
    await fs.remove(tempRoot);
  }
});
