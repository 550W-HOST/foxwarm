import { RpcError } from '../rpc';
import type { Session } from '../types';
import { annotateHistoryWithContextFrontierMetadata, renderHistoryFromFrontier } from './layeredContext';
import { applySessionHistoryState } from './metadataStore';
import { externalizeAuthoritativeSessionImages } from './stateFile';

/** Apply the one authoritative per-session JSON payload to a catalog/session stub. */
export async function hydrateAuthoritativeSessionState(
  target: Session,
  raw: Record<string, any>,
): Promise<{ session: Session; imagesCanonicalized: boolean }> {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.history)) {
    throw new RpcError('SESSION_WORKER_STATE_INVALID', `Authoritative state for ${target.id} is not a session payload.`);
  }
  target.history = structuredClone(raw.history);
  target.persistentMemorySnapshot = typeof raw.persistentMemorySnapshot === 'string'
    ? raw.persistentMemorySnapshot
    : '';
  applySessionHistoryState(target, structuredClone(raw));
  if (!target.stats || typeof target.stats !== 'object') {
    target.stats = { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null };
  }
  if (!target.meta || typeof target.meta !== 'object') target.meta = { lastMessageTime: Date.now() };
  if (target.contextFrontier?.length) {
    if (target.history.length !== target.contextFrontier.length) {
      target.history = await renderHistoryFromFrontier(target);
    } else {
      target.history = (await annotateHistoryWithContextFrontierMetadata(target.id, target.history, target.contextFrontier)).history;
    }
  }
  const imagesCanonicalized = await externalizeAuthoritativeSessionImages(target);
  return { session: target, imagesCanonicalized };
}
