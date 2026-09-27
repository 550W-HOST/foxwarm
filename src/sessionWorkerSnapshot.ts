import { externalizeMessages } from './imageBlobs';
import fs from 'fs-extra';
import { RpcError } from './rpc';
import { getSessionHistoryFilePath } from './session/metadataStore';
import { replaceAuthoritativeSessionState } from './session/stateHydration';
import type { Session } from './types';

export async function readDetachedWorkerSession(sessionId: string, catalog: Session): Promise<Session> {
  try {
    const raw = JSON.parse(await fs.readFile(getSessionHistoryFilePath(sessionId), 'utf8'));
    const detached: Session = {
      id: sessionId,
      history: [],
      persistentMemorySnapshot: '',
      queue: [],
      busy: false,
      stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
      meta: { lastMessageTime: 0 },
      ...(catalog.agent === undefined ? {} : { agent: catalog.agent }),
      ...(catalog.aliases === undefined ? {} : { aliases: structuredClone(catalog.aliases) }),
      ...(catalog.parentSessionId === undefined ? {} : { parentSessionId: catalog.parentSessionId }),
      ...(catalog.displayName === undefined ? {} : { displayName: catalog.displayName }),
      ...(catalog.archived === undefined ? {} : { archived: catalog.archived }),
      ...(catalog.pinned === undefined ? {} : { pinned: catalog.pinned }),
      ...(catalog.sidebarOrder === undefined ? {} : { sidebarOrder: catalog.sidebarOrder }),
    };
    const replaced = replaceAuthoritativeSessionState(detached, raw, {
      preserveCatalogFields: true, adoptAuthorityDisplayNameWhenMissing: true,
    });
    if (replaced.upgradedLegacy) throw new Error('legacy state requires the owning worker upgrade');
    detached.history = (await externalizeMessages(detached.history.slice())).messages;
    return detached;
  } catch {
    throw new RpcError('SESSION_WORKER_HISTORY_UNAVAILABLE', `Authoritative history for session \`${sessionId}\` is unavailable.`, true);
  }
}
