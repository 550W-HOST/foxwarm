import { RpcError } from '../rpc';
import type { Session } from '../types';
import { annotateHistoryWithContextFrontierMetadata, renderHistoryFromFrontier } from './layeredContext';
import { prepareSessionSemanticStateForHydration, replaceSessionSemanticState } from './metadataStore';
import { externalizeAuthoritativeSessionImages } from './stateFile';

/** Replace all semantic fields from one authoritative payload, upgrading only unversioned legacy files. */
export function replaceAuthoritativeSessionState(
  target: Session,
  raw: Record<string, any>,
): { session: Session; upgradedLegacy: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcError('SESSION_WORKER_STATE_INVALID', `Authoritative state for ${target.id} is not a session payload.`);
  }
  try {
    const prepared = prepareSessionSemanticStateForHydration(target, raw);
    replaceSessionSemanticState(target, prepared.snapshot);
    return { session: target, upgradedLegacy: prepared.upgradedLegacy };
  } catch (error: any) {
    if (error instanceof RpcError) throw error;
    const message = String(error?.message || error);
    throw new RpcError(
      message.startsWith('Unsupported per-session state format version') ? 'SESSION_WORKER_STATE_VERSION' : 'SESSION_WORKER_STATE_INVALID',
      `Cannot hydrate ${target.id}: ${message}`,
    );
  }
}

export async function hydrateAuthoritativeSessionState(
  target: Session,
  raw: Record<string, any>,
): Promise<{ session: Session; imagesCanonicalized: boolean; upgradedLegacy: boolean }> {
  const replaced = replaceAuthoritativeSessionState(target, raw);
  if (target.contextFrontier?.length) {
    if (target.history.length !== target.contextFrontier.length) {
      target.history = await renderHistoryFromFrontier(target);
    } else {
      target.history = (await annotateHistoryWithContextFrontierMetadata(target.id, target.history, target.contextFrontier)).history;
    }
  }
  // This is legacy inline-image materialization, not mailbox/JSON cursor reconciliation.
  const imagesCanonicalized = await externalizeAuthoritativeSessionImages(target);
  return { session: target, imagesCanonicalized, upgradedLegacy: replaced.upgradedLegacy };
}
