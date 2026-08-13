import fs from 'fs-extra';
import path from 'node:path';
import sharp from 'sharp';
import { SESSIONS_DIR, SESSIONS_FILE } from './config';
import { writeAuthoritativeSessionState } from './session/stateFile';
import type { Session } from './types';

async function run(): Promise<void> {
  const png = await sharp({ create: { width: 2, height: 1, channels: 4, background: { r: 1, g: 2, b: 3, alpha: 1 } } }).png().toBuffer();
  const inlineData = { data: png.toString('base64'), mimeType: 'image/png' };
  const state: Session = {
    id: 'agent/image', agent: 'agent', history: [{ role: 'user', parts: [{ inlineData }], __meta: { seq: 1, timestamp: 1 } }],
    persistentMemorySnapshot: 'prompt', promptCacheKey: 'cache',
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false, queue: [{ type: 'background', parts: [{ inlineData }] }],
    meta: { lastMessageTime: 1, wait: { id: 'wait', startedAt: 1 }, managedSession: {
      ownerSessionId: 'owner', leaseId: 'lease', revision: 1, openedAt: 1, leaseTouchedAt: 1,
      pendingInbox: [{ type: 'background', parts: [{ inlineData }] }],
    } },
    nextMessageSeq: 2, nextBlockId: 1,
    lastAppliedMailboxId: 9,
  };
  await writeAuthoritativeSessionState(state);
  const filePath = path.join(SESSIONS_DIR, 'agent/image.json');
  const raw = await fs.readJson(filePath);
  const result = {
    historyRef: !!raw.history[0].parts[0].inlineDataRef?.blobId && !raw.history[0].parts[0].inlineData,
    queueRef: !!raw.queue[0].parts[0].inlineDataRef?.blobId && !raw.queue[0].parts[0].inlineData,
    managedRef: !!raw.meta.managedSession.pendingInbox[0].parts[0].inlineDataRef?.blobId
      && !raw.meta.managedSession.pendingInbox[0].parts[0].inlineData,
    cursor: raw.lastAppliedMailboxId,
    stateVersion: raw.sessionStateVersion,
    promptCacheKey: raw.promptCacheKey,
    catalogExists: await fs.pathExists(SESSIONS_FILE),
  };
  await new Promise<void>((resolve, reject) => {
    if (!process.send) { resolve(); return; }
    process.send(result, error => error ? reject(error) : resolve());
  });
}

void run().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});
