import { defineRpcService, rpcMethod, RpcError, type RpcServiceHandler } from './rpc';
import { stableSessionWorkerJson } from './sessionWorkerStableJson';
import type { SessionWorkerProjection } from './sessionWorkerPersistence';

export type SessionWorkerPublicationIdentity = { sessionId: string; generation: number; incarnationId: string };
type PublishRequest = SessionWorkerPublicationIdentity & { projection: SessionWorkerProjection };
export type SessionWorkerProjectionEntry = SessionWorkerPublicationIdentity & { projection?: SessionWorkerProjection; stale: boolean };

export const sessionWorkerPublicationServiceDescriptor = defineRpcService('session-worker-publication', 1, {
  publishCommitted: rpcMethod<PublishRequest, { applied: true }>(),
});

function identityKey(identity: SessionWorkerPublicationIdentity) { return `${identity.sessionId}\0${identity.generation}\0${identity.incarnationId}`; }
function assertIdentity(identity: any): asserts identity is SessionWorkerPublicationIdentity {
  if (!identity || typeof identity.sessionId !== 'string' || !identity.sessionId || identity.sessionId.length > 256
    || !Number.isSafeInteger(identity.generation) || identity.generation <= 0
    || typeof identity.incarnationId !== 'string' || !identity.incarnationId || identity.incarnationId.length > 256) {
    throw new RpcError('SESSION_WORKER_PUBLICATION_INVALID', 'Publication identity is invalid.');
  }
}
function validateProjection(value: unknown, sessionId: string): SessionWorkerProjection {
  let json: string;
  try { json = stableSessionWorkerJson(value); }
  catch { throw new RpcError('SESSION_WORKER_PUBLICATION_INVALID', 'Projection must be an exact plain JSON record.'); }
  if (Buffer.byteLength(json, 'utf8') > 64 * 1024) throw new RpcError('SESSION_WORKER_PUBLICATION_INVALID', 'Projection exceeds 64 KiB.');
  const projection = JSON.parse(json) as any;
  const keys = ['sessionId','lastAppliedMailboxId','busy','busyStartedAt','queueLength','runtimeState','messageCount','lastMessageTime','stats','currentNode','cwd','model','childModelDefault','compactThresholdTokens'];
  if ((Object.keys(projection).length !== keys.length && Object.keys(projection).length !== keys.length + 1)
    || keys.some(key => !Object.prototype.hasOwnProperty.call(projection, key))
    || (Object.prototype.hasOwnProperty.call(projection, 'verbose') && typeof projection.verbose !== 'boolean')) {
    throw new RpcError('SESSION_WORKER_PUBLICATION_INVALID', 'Projection has an invalid shape.');
  }
  const safeInt = (number: any) => Number.isSafeInteger(number) && number >= 0;
  const nullableString = (item: any, max: number) => item === null || (typeof item === 'string' && item.length <= max);
  const exactKeys = (item: any, allowed: string[], required: string[] = []) => item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).every(key => allowed.includes(key)) && required.every(key => Object.prototype.hasOwnProperty.call(item, key));
  const stats = projection.stats; const usage = stats?.lastUsage;
  const validStats = exactKeys(stats, ['totalCachedTokens','totalInputTokens','totalOutputTokens','lastUsage'], ['totalCachedTokens','totalInputTokens','totalOutputTokens','lastUsage'])
    && safeInt(stats.totalCachedTokens) && safeInt(stats.totalInputTokens) && safeInt(stats.totalOutputTokens)
    && (usage === null || (exactKeys(usage, ['cachedTokens','inputTokens','reasoningTokens','outputTokens'], ['cachedTokens','inputTokens','outputTokens'])
      && safeInt(usage.cachedTokens) && safeInt(usage.inputTokens) && safeInt(usage.outputTokens)
      && (usage.reasoningTokens === undefined || safeInt(usage.reasoningTokens))));
  const runtime = projection.runtimeState;
  const shortString = (item: any, max = 512) => typeof item === 'string' && item.length <= max;
  const stringList = (item: any) => Array.isArray(item) && item.length <= 128 && item.every((entry: any) => shortString(entry, 256));
  const active = runtime?.active; const tool = runtime?.tool; const waiting = runtime?.waiting;
  const validActive = active === undefined || (exactKeys(active, ['iteration','phase','modelKey','streamId'])
    && (active.iteration === undefined || safeInt(active.iteration))
    && (active.phase === undefined || ['normal-turn','compaction','managed-step','unknown'].includes(active.phase))
    && (active.modelKey === undefined || shortString(active.modelKey)) && (active.streamId === undefined || shortString(active.streamId)));
  const validTool = tool === undefined || (exactKeys(tool, ['id','name','index','total','executionNode','argsPreview','startedAt'], ['name','startedAt'])
    && shortString(tool.name) && safeInt(tool.startedAt) && (tool.id === undefined || shortString(tool.id))
    && (tool.index === undefined || safeInt(tool.index)) && (tool.total === undefined || safeInt(tool.total))
    && (tool.executionNode === undefined || shortString(tool.executionNode)) && (tool.argsPreview === undefined || shortString(tool.argsPreview, 4096)));
  const validWaiting = waiting === undefined || (exactKeys(waiting, ['waitId','waitingFor','reason','waitAllSessions','satisfiedSessions','pendingSessions','timeoutSeconds','timeoutAt','waitExecIds'], ['waitId','waitingFor'])
    && shortString(waiting.waitId) && ['sessions','exec','timer'].includes(waiting.waitingFor)
    && (waiting.reason === undefined || shortString(waiting.reason, 4096))
    && ['waitAllSessions','satisfiedSessions','pendingSessions','waitExecIds'].every(key => waiting[key] === undefined || stringList(waiting[key]))
    && (waiting.timeoutSeconds === undefined || (Number.isFinite(waiting.timeoutSeconds) && waiting.timeoutSeconds >= 0))
    && (waiting.timeoutAt === undefined || safeInt(waiting.timeoutAt)));
  const validRuntime = exactKeys(runtime, ['state','since','note','queueLength','busy','active','tool','waiting'], ['state','queueLength','busy'])
    && ['requesting-model','running-tool','waiting','idle'].includes(runtime.state) && safeInt(runtime.queueLength)
    && typeof runtime.busy === 'boolean' && (runtime.since === undefined || safeInt(runtime.since))
    && (runtime.note === undefined || (typeof runtime.note === 'string' && runtime.note.length <= 4096))
    && validActive && validTool && validWaiting;
  if (projection.sessionId !== sessionId || !safeInt(projection.lastAppliedMailboxId) || typeof projection.busy !== 'boolean'
    || !(projection.busyStartedAt === null || safeInt(projection.busyStartedAt)) || !safeInt(projection.queueLength)
    || !safeInt(projection.messageCount) || !safeInt(projection.lastMessageTime)
    || !validRuntime || !validStats || runtime.busy !== projection.busy || runtime.queueLength !== projection.queueLength
    || typeof projection.currentNode !== 'string' || !projection.currentNode || projection.currentNode.length > 128
    || !nullableString(projection.cwd, 4096) || !nullableString(projection.model, 512)
    || !nullableString(projection.childModelDefault, 512)
    || !(projection.compactThresholdTokens === null || safeInt(projection.compactThresholdTokens))) {
    throw new RpcError('SESSION_WORKER_PUBLICATION_INVALID', 'Projection fields are invalid.');
  }
  return projection;
}

export class SessionWorkerProjectionRegistry {
  private readonly entries = new Map<string, SessionWorkerProjectionEntry>();
  private readonly current = new Map<string, string>();
  private readonly closed = new Set<string>();
  private readonly subscribers = new Set<(entry: SessionWorkerProjectionEntry) => void | Promise<void>>();

  private notifyLifecycle(entry: SessionWorkerProjectionEntry): void {
    for (const subscriber of this.subscribers) {
      try { Promise.resolve(subscriber(structuredClone(entry))).catch(() => {}); } catch {}
    }
  }

  establish(identity: SessionWorkerPublicationIdentity): void {
    assertIdentity(identity);
    const key = identityKey(identity); if (this.current.get(identity.sessionId) === key) return;
    const priorKey = this.current.get(identity.sessionId); const prior = priorKey ? this.entries.get(priorKey) : undefined;
    if (prior && prior.generation > identity.generation) throw new RpcError('SESSION_WORKER_PUBLICATION_STALE', 'Cannot establish an older worker generation.', true);
    if (prior && prior.generation === identity.generation && prior.incarnationId !== identity.incarnationId) throw new RpcError('SESSION_WORKER_PUBLICATION_STALE', 'Worker generation incarnation mismatch.', true);
    this.current.set(identity.sessionId, key);
    this.closed.delete(key);
    const entry: SessionWorkerProjectionEntry = { ...identity, stale: true };
    this.entries.set(key, entry); this.notifyLifecycle(entry);
  }
  async apply(identity: SessionWorkerPublicationIdentity, projectionValue: unknown): Promise<void> {
    assertIdentity(identity); const key = identityKey(identity);
    if (this.current.get(identity.sessionId) !== key || this.closed.has(key)) throw new RpcError('SESSION_WORKER_PUBLICATION_STALE', 'Publication does not belong to an accepting worker generation.', true);
    const projection = validateProjection(projectionValue, identity.sessionId);
    const entry: SessionWorkerProjectionEntry = { ...identity, projection: structuredClone(projection), stale: false };
    this.entries.set(key, entry);
    try { for (const subscriber of this.subscribers) await subscriber(structuredClone(entry)); }
    catch (error) {
      entry.stale = true; this.closed.add(key); this.notifyLifecycle(entry);
      throw new RpcError('SESSION_WORKER_PUBLICATION_APPLY_FAILED', String((error as any)?.message || error).slice(0, 4096), true);
    }
  }
  markStale(identity: SessionWorkerPublicationIdentity): boolean {
    const key = identityKey(identity); const entry = this.entries.get(key);
    if (!entry || this.current.get(identity.sessionId) !== key) return false;
    if (!entry.stale) { entry.stale = true; this.closed.add(key); this.notifyLifecycle(entry); }
    return true;
  }
  clear(identity: SessionWorkerPublicationIdentity): boolean {
    const key = identityKey(identity); if (this.current.get(identity.sessionId) !== key) return false;
    const entry = this.entries.get(key);
    this.current.delete(identity.sessionId); this.closed.delete(key); const removed = this.entries.delete(key);
    if (removed && entry) this.notifyLifecycle({ ...entry, stale: true });
    return removed;
  }
  get(sessionId: string): SessionWorkerProjectionEntry | undefined {
    const key = this.current.get(sessionId); const entry = key ? this.entries.get(key) : undefined;
    return entry ? structuredClone(entry) : undefined;
  }
  list(): SessionWorkerProjectionEntry[] { return [...this.current.keys()].sort().map(id => this.get(id)!); }
  subscribe(callback: (entry: SessionWorkerProjectionEntry) => void | Promise<void>): () => void { this.subscribers.add(callback); return () => this.subscribers.delete(callback); }
}

export function createSessionWorkerPublicationServiceHandler(options: {
  expected: SessionWorkerPublicationIdentity; registry: SessionWorkerProjectionRegistry;
}): RpcServiceHandler<typeof sessionWorkerPublicationServiceDescriptor> {
  return { async publishCommitted(input) {
    const requestKeys = input && typeof input === 'object' ? Reflect.ownKeys(input) : [];
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype
      || requestKeys.length !== 4 || requestKeys.some(key => typeof key !== 'string' || !['sessionId','generation','incarnationId','projection'].includes(key)
        || !Object.getOwnPropertyDescriptor(input, key)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(input, key)!))) {
      throw new RpcError('SESSION_WORKER_PUBLICATION_INVALID', 'Publication request has an invalid shape.');
    }
    assertIdentity(input);
    if (identityKey(input) !== identityKey(options.expected)) throw new RpcError('SESSION_WORKER_PUBLICATION_SOURCE_MISMATCH', 'Publication source identity mismatch.');
    await options.registry.apply(options.expected, input.projection); return { applied: true };
  } };
}
