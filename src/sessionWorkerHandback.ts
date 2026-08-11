import fs from 'fs-extra';
import { RpcError } from './rpc';
import { getSessionHistoryFilePath } from './session/metadataStore';
import type { SessionWorkerStore } from './sessionWorkerStore';
import type { Session } from './types';
import { clearSessionCatalogStub } from './sessionRuntimeState';

export type SessionWorkerHandbackIdentity = { sessionId: string; generation: number; incarnationId: string };

export type SessionWorkerHandbackDeps = {
  store: SessionWorkerStore;
  getCatalogSession: (sessionId: string) => Session | undefined;
  upsertCatalogSession: (session: Session) => void;
  saveCatalog: (sessionId: string) => Promise<void>;
  stateFilePath?: (sessionId: string) => string;
};

function handbackUnavailable(message: string): never {
  throw new RpcError('SESSION_WORKER_HANDBACK_UNAVAILABLE', message, true);
}

const AUTHORITY_SETTING_KEYS = ['model', 'effort', 'childModelDefault', 'childEffortDefault', 'currentNode', 'cwd', 'compactThresholdTokens', 'verbose'] as const;

/**
 * The single Main-side handback step of the worker release flow: the
 * supervisor invokes it after exact process exit is observed and before the
 * durable fence is released. It reconciles the mailbox cursor against the
 * authoritative per-session JSON (save-before-ack recovery) and refreshes the
 * Main presentation stub strictly read-only from that authority; the
 * projection never becomes a semantic source. Main remains the sole catalog
 * writer. Any failure retains the fence and fails closed.
 */
export async function performSessionWorkerHandback(
  deps: SessionWorkerHandbackDeps,
  identity: SessionWorkerHandbackIdentity,
): Promise<void> {
  const { sessionId } = identity;
  const rawText = await fs.readFile((deps.stateFilePath || getSessionHistoryFilePath)(sessionId), 'utf8')
    .catch(() => handbackUnavailable(`Authoritative state for session \`${sessionId}\` is unreadable during handback.`));
  let raw: any;
  try { raw = JSON.parse(rawText); }
  catch { handbackUnavailable(`Authoritative state for session \`${sessionId}\` is not valid JSON during handback.`); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.sessionStateVersion !== 1) {
    handbackUnavailable(`Authoritative state for session \`${sessionId}\` is not a current v1 payload during handback.`);
  }
  const stateCursor = raw.lastAppliedMailboxId;
  if (!Number.isSafeInteger(stateCursor) || stateCursor < 0) {
    handbackUnavailable(`Authoritative state for session \`${sessionId}\` has no valid mailbox cursor during handback.`);
  }
  deps.store.reconcileDrainedMailboxCursor(sessionId, stateCursor);

  const existing = deps.getCatalogSession(sessionId);
  const stub: Session = existing || ({
    id: sessionId,
    agent: 'main',
    history: [],
    contextFrontier: [],
    persistentMemorySnapshot: '',
    systemPromptFiles: [],
    stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
    busy: false,
    queue: [],
    meta: { lastMessageTime: 0 },
  } as Session);
  if (!existing && typeof raw.agent === 'string' && raw.agent) stub.agent = raw.agent;
  if (raw.stats && typeof raw.stats === 'object' && !Array.isArray(raw.stats)) stub.stats = raw.stats;
  // meta.lastChannel is catalog-only presentation state (the authority payload
  // strips it); preserve the Main-owned value across the authority mirror.
  const catalogLastChannel = stub.meta?.lastChannel === undefined ? undefined : structuredClone(stub.meta.lastChannel);
  if (raw.meta && typeof raw.meta === 'object' && !Array.isArray(raw.meta)) stub.meta = raw.meta;
  if (stub.meta) {
    if (catalogLastChannel === undefined) delete stub.meta.lastChannel;
    else stub.meta.lastChannel = catalogLastChannel;
  }
  // Legacy compatibility display fields mirror the authority exactly.
  stub.busy = raw.busy === true;
  stub.busyStartedAt = typeof raw.busyStartedAt === 'number' ? raw.busyStartedAt : undefined;
  stub.queue = Array.isArray(raw.queue) ? raw.queue : [];
  clearSessionCatalogStub(stub);
  delete (stub as any).managedPendingCount;
  for (const key of AUTHORITY_SETTING_KEYS) {
    if (raw[key] === undefined || raw[key] === null) delete (stub as any)[key];
    else (stub as any)[key] = raw[key];
  }
  // displayName is Main-owned presentation metadata: never overwrite a
  // Main-set name (a WebUI rename is catalog-only and must survive release),
  // but adopt the authority's name into a never-named stub so a worker-side
  // self-rename stays visible.
  if (stub.displayName === undefined && typeof raw.displayName === 'string' && raw.displayName) stub.displayName = raw.displayName;
  // The stub must never become a semantic source: any hydrated history (for
  // example from a past Main-side existence check) is cleared so later reads
  // lazily rehydrate the fresh authority instead of serving stale copies.
  stub.history = [];
  if (!existing) deps.upsertCatalogSession(stub);
  await deps.saveCatalog(sessionId);
}
