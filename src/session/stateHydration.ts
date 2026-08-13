import { RpcError } from '../rpc';
import type { Session } from '../types';
import { prepareSessionSemanticStateForHydration, replaceSessionSemanticState } from './metadataStore';
import { externalizeAuthoritativeSessionImages } from './stateFile';

/** Replace all semantic fields from one authoritative payload, upgrading only unversioned legacy files.
 * With `preserveDisplayName`, displayName is treated as Main-owned presentation
 * metadata: the target's current value (including an explicit clear) survives
 * hydration. Workers load without it, so their authority-carried name stays
 * authoritative inside the worker; Main stubs pass it so a Main-owned rename
 * is never rolled back by rehydration. */
export function replaceAuthoritativeSessionState(
  target: Session,
  raw: Record<string, any>,
  options?: { preserveCatalogFields?: boolean; preserveDisplayName?: boolean; adoptAuthorityDisplayNameWhenMissing?: boolean; adoptAuthorityCatalogFieldsWhenMissing?: boolean },
): { session: Session; upgradedLegacy: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcError('SESSION_WORKER_STATE_INVALID', `Authoritative state for ${target.id} is not a session payload.`);
  }
  try {
    const prepared = prepareSessionSemanticStateForHydration(target, raw);
    const preserveCatalogFields = options?.preserveCatalogFields === true;
    const catalogFields = new Map<string, { present: boolean; value: unknown }>();
    if (preserveCatalogFields) {
      for (const field of ['agent', 'aliases', 'parentSessionId', 'displayName'] as const) {
        if ((options?.adoptAuthorityCatalogFieldsWhenMissing
          || (field === 'displayName' && options?.adoptAuthorityDisplayNameWhenMissing))
          && !Object.prototype.hasOwnProperty.call(target, field)) continue;
        catalogFields.set(field, {
          present: Object.prototype.hasOwnProperty.call(target, field),
          value: structuredClone((target as any)[field]),
        });
      }
    }
    const mainOwnedDisplayName = options?.preserveDisplayName && !preserveCatalogFields ? target.displayName : undefined;
    replaceSessionSemanticState(target, prepared.snapshot);
    if (preserveCatalogFields) {
      for (const [field, entry] of catalogFields) {
        if (!entry.present) delete (target as any)[field];
        else (target as any)[field] = entry.value;
      }
    } else if (options?.preserveDisplayName) {
      if (mainOwnedDisplayName === undefined) delete target.displayName;
      else target.displayName = mainOwnedDisplayName;
    }
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
  options?: { preserveCatalogFields?: boolean; adoptAuthorityDisplayNameWhenMissing?: boolean; adoptAuthorityCatalogFieldsWhenMissing?: boolean },
): Promise<{ session: Session; imagesCanonicalized: boolean; upgradedLegacy: boolean }> {
  const replaced = replaceAuthoritativeSessionState(target, raw, options);
  // This is legacy inline-image materialization, not mailbox/JSON cursor reconciliation.
  const imagesCanonicalized = await externalizeAuthoritativeSessionImages(target);
  return { session: target, imagesCanonicalized, upgradedLegacy: replaced.upgradedLegacy };
}
