import { RpcError } from './rpc';
import { sessionCatalogStore, type SessionListOrderMode, type SessionPresentationKey } from './session/catalogStore';
import * as sessionRuntime from './sessionRuntime';
import type { SessionRuntimeSessionDto } from './sessionRuntimeService';

export const SESSION_LIST_API_VERSION = 1;
const MAX_IDS = 100;
export const MAX_FOCUS_IDS = 8;

export type SessionListPageDto = {
  version: 1;
  revision: string;
  mode: SessionListOrderMode;
  scope: string;
  sessions: SessionRuntimeSessionDto[];
  nextCursor: string | null;
  reset: boolean;
};

type CursorPayload = { v: 1; kind: 'page'; mode: SessionListOrderMode; scope: string; revision: string; key: SessionPresentationKey };
type PresentationScope = { parentSessionId: string | null; parentAgent: string | null; pinned: boolean; agent: string };

function encodeCursor(value: CursorPayload): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
function childScope(parentSessionId: string, agent?: string): string { return `children:${parentSessionId}:agent:${agent || '*'}`; }
function decodeCursor(raw: string | undefined, mode: SessionListOrderMode, scope: string): CursorPayload | undefined {
  if (!raw) return undefined;
  let value: any;
  try { value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw new RpcError('SESSION_LIST_CURSOR_INVALID', 'Cursor is malformed.'); }
  const child = scope.startsWith('children:');
  const expectedKeyLength = mode === 'default' ? (child ? 5 : 6) : (child ? 3 : 4);
  if (!value || value.v !== 1 || value.kind !== 'page' || value.mode !== mode || value.scope !== scope
    || typeof value.revision !== 'string' || value.revision.length > 200 || !Array.isArray(value.key) || value.key.length !== expectedKeyLength
    || value.key.slice(0, -1).some((part: any) => typeof part !== 'number' || !Number.isFinite(part))
    || typeof value.key[value.key.length - 1] !== 'string' || value.key[value.key.length - 1].length > 512) {
    throw new RpcError('SESSION_LIST_CURSOR_INVALID', 'Cursor does not match this mode and scope.');
  }
  return value;
}

export function normalizeSessionListMode(value: unknown): SessionListOrderMode {
  if (value === undefined) return 'default';
  if (value === 'default' || value === 'time' || value === 'flat-time') return value;
  throw new RpcError('SESSION_LIST_MODE_INVALID', 'mode must be default, time, or flat-time.');
}

export function assertExactDto(value: unknown, allowedKeys: readonly string[], label: string): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !allowedKeys.includes(key))) {
    throw new RpcError('SESSION_LIST_DTO_INVALID', `${label} has an invalid shape.`);
  }
}

export function boundedQueryLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) throw new RpcError('SESSION_LIST_LIMIT_INVALID', `limit must be an integer between 1 and ${max}.`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) throw new RpcError('SESSION_LIST_LIMIT_INVALID', `limit must be between 1 and ${max}.`);
  return parsed;
}

export function boundedBodyLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) {
    throw new RpcError('SESSION_LIST_LIMIT_INVALID', `limit must be an integer between 1 and ${max}.`);
  }
  return value;
}

export function optionalQueryString(value: unknown, label: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value || value.length > maxLength) throw new RpcError('SESSION_LIST_QUERY_INVALID', `${label} is invalid.`);
  return value;
}

export function repeatedFocusIds(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.length > MAX_FOCUS_IDS || values.some(id => typeof id !== 'string' || !id || id.length > 512)) {
    throw new RpcError('SESSION_LIST_FOCUS_INVALID', `focusSessionId accepts at most ${MAX_FOCUS_IDS} bounded values.`);
  }
  return [...new Set(values as string[])];
}

function keyForSession(session: SessionRuntimeSessionDto, mode: SessionListOrderMode, child = false): SessionPresentationKey {
  const prefix: SessionPresentationKey = child ? [session.archived ? 1 : 0] : [session.pinned ? 0 : 1, session.archived ? 1 : 0];
  if (mode === 'default') prefix.push(session.sidebarOrder === null ? 1 : 0, session.sidebarOrder || 0);
  prefix.push(-session.lastMessageTime, session.id);
  return prefix;
}
function compareParts(a: SessionPresentationKey, b: SessionPresentationKey): number {
  for (let index = 0; index < a.length; index++) {
    if (a[index] === b[index]) continue;
    if (typeof a[index] === 'string' && typeof b[index] === 'string') {
      return Buffer.compare(Buffer.from(a[index] as string, 'utf8'), Buffer.from(b[index] as string, 'utf8'));
    }
    return (a[index] as number) < (b[index] as number) ? -1 : 1;
  }
  return 0;
}
function compareSessions(mode: SessionListOrderMode, child = false) {
  return (a: SessionRuntimeSessionDto, b: SessionRuntimeSessionDto) => compareParts(keyForSession(a, mode, child), keyForSession(b, mode, child));
}
function inScope(session: SessionRuntimeSessionDto, mode: SessionListOrderMode, options: { roots?: boolean; parentSessionId?: string; agent?: string; includePinnedChildren?: boolean },
  scope?: PresentationScope): boolean {
  if (options.agent !== undefined && (scope?.agent || session.agent) !== options.agent) return false;
  if (options.parentSessionId !== undefined) return (options.includePinnedChildren || !(scope?.pinned ?? session.pinned))
    && (scope?.parentSessionId ?? session.parentSessionId) === options.parentSessionId;
  if (options.agent !== undefined && options.roots) return !scope || scope.parentSessionId === null || scope.parentAgent !== options.agent;
  if (options.roots && mode !== 'flat-time') return (scope?.pinned ?? session.pinned) || (scope ? scope.parentSessionId === null : session.parentSessionId === null);
  return true;
}
function withCanonicalScope(session: SessionRuntimeSessionDto, scope?: PresentationScope): SessionRuntimeSessionDto {
  return scope ? { ...session, parentSessionId: scope.parentSessionId, pinned: scope.pinned, agent: scope.agent } : session;
}

export async function querySessionListPage(options: {
  mode: SessionListOrderMode; limit: number; cursor?: string; roots?: boolean; parentSessionId?: string; agent?: string;
}): Promise<SessionListPageDto> {
  const scope = options.parentSessionId !== undefined ? `children:${options.parentSessionId}`
    : options.agent !== undefined ? `agent:${options.agent}:${options.roots ? 'roots' : 'all'}`
      : options.roots && options.mode !== 'flat-time' ? 'roots' : 'flat';
  const decoded = decodeCursor(options.cursor, options.mode, scope);
  const run = async (after: SessionPresentationKey | undefined) => {
    const page = options.agent !== undefined && options.roots
      ? sessionCatalogStore.listAgentForestPage({ agent: options.agent, limit: options.limit, ...(after ? { after } : {}) })
      : sessionCatalogStore.listPresentationPage({ mode: options.mode, limit: options.limit,
        ...(after ? { after } : {}), ...(options.roots && options.mode !== 'flat-time' ? { roots: true } : {}),
        ...(options.parentSessionId !== undefined ? { parentSessionId: options.parentSessionId } : {}),
        ...(options.agent !== undefined ? { agent: options.agent } : {}) });
    const projections = await sessionRuntime.getSessionListProjections(page.rows.map(row => row.id), true);
    const scopes = sessionCatalogStore.getPresentationScopes(projections.sessions.map(session => session.id));
    const afterKey = after;
    const sessions = [...new Map(projections.sessions
      .filter(session => inScope(session, options.mode, options, scopes[session.id]))
      .filter(session => !afterKey || compareParts(keyForSession(session, options.mode), afterKey) > 0)
      .map(session => [session.id, withCanonicalScope(session, scopes[session.id])])).values()].sort(compareSessions(options.mode));
    return { page, projections, sessions };
  };
  let reset = false;
  let result = await run(decoded?.key);
  if (decoded && decoded.revision !== result.projections.revision) { reset = true; result = await run(undefined); }
  const sessions = result.sessions.slice(0, options.limit);
  const hasMore = result.page.hasMore || result.sessions.length > options.limit;
  return { version: SESSION_LIST_API_VERSION, revision: result.projections.revision, mode: options.mode, scope,
    sessions, nextCursor: hasMore && sessions.length ? encodeCursor({ v: 1, kind: 'page', mode: options.mode, scope,
      revision: result.projections.revision, key: keyForSession(sessions[sessions.length - 1], options.mode) }) : null, reset };
}

export async function queryChildrenPreviews(parentSessionIds: string[], mode: SessionListOrderMode, limit: number, agent?: string) {
  const parents = [...new Set(parentSessionIds)].slice(0, MAX_IDS);
  const base = sessionCatalogStore.listChildrenPreviews(parents, mode, limit, agent);
  const ids = base.flatMap(group => group.rows.map(row => row.id));
  const projections = await sessionRuntime.getSessionListProjections(ids, true);
  const scopes = sessionCatalogStore.getPresentationScopes(projections.sessions.map(session => session.id));
  const result = parents.map(parentSessionId => {
    const sessions = projections.sessions.filter(session => inScope(session, mode,
      { parentSessionId, ...(agent ? { agent, includePinnedChildren: true } : {}) }, scopes[session.id]))
      .map(session => withCanonicalScope(session, scopes[session.id])).sort(compareSessions(mode, true)).slice(0, limit);
    const original = base.find(group => group.parentSessionId === parentSessionId)!;
    const total = Math.max(original.total, sessions.length);
    return { parentSessionId, sessions, total, nextCursor: total > sessions.length && sessions.length
      ? encodeCursor({ v: 1, kind: 'page', mode, scope: childScope(parentSessionId, agent), revision: projections.revision,
        key: keyForSession(sessions[sessions.length - 1], mode, true) }) : null };
  });
  return { revision: projections.revision, children: result };
}

export async function queryChildrenContinuations(requests: Array<{ parentSessionId: string; cursor?: string }>, mode: SessionListOrderMode, limit: number, agent?: string) {
  if (!Array.isArray(requests) || requests.length > 20 || requests.some(request => !request || typeof request.parentSessionId !== 'string'
    || !request.parentSessionId || request.parentSessionId.length > 512 || (request.cursor !== undefined && typeof request.cursor !== 'string'))) {
    throw new RpcError('SESSION_LIST_CHILDREN_INVALID', 'parents must contain at most 20 bounded requests.');
  }
  for (const request of requests) assertExactDto(request, ['parentSessionId','cursor'], 'child request');
  if (new Set(requests.map(request => request.parentSessionId)).size !== requests.length) {
    throw new RpcError('SESSION_LIST_CHILDREN_INVALID', 'parentSessionId values must be unique.');
  }
  const decoded = requests.map(request => ({ request, cursor: decodeCursor(request.cursor, mode, childScope(request.parentSessionId, agent)) }));
  const run = async (ignoreCursors: boolean) => {
    const base = sessionCatalogStore.listChildrenContinuations(decoded.map(item => ({ parentSessionId: item.request.parentSessionId,
      ...(!ignoreCursors && item.cursor ? { after: item.cursor.key } : {}) })), mode, limit, agent);
    const projections = await sessionRuntime.getSessionListProjections(base.flatMap(group => group.rows.map(row => row.id)), true);
    const scopes = sessionCatalogStore.getPresentationScopes(projections.sessions.map(session => session.id));
    return { base, projections, scopes };
  };
  let result = await run(false);
  const reset = decoded.some(item => item.cursor && item.cursor.revision !== result.projections.revision);
  if (reset) result = await run(true);
  return { version: SESSION_LIST_API_VERSION, revision: result.projections.revision, reset,
    children: result.base.map(group => {
      const after = reset ? undefined : decoded.find(item => item.request.parentSessionId === group.parentSessionId)?.cursor?.key;
      const candidates = result.projections.sessions.filter(session => inScope(session, mode,
        { parentSessionId: group.parentSessionId, ...(agent ? { agent, includePinnedChildren: true } : {}) }, result.scopes[session.id]))
        .filter(session => !after || compareParts(keyForSession(session, mode, true), after) > 0)
        .map(session => withCanonicalScope(session, result.scopes[session.id])).sort(compareSessions(mode, true));
      const sessions = candidates.slice(0, limit);
      return { parentSessionId: group.parentSessionId, sessions, total: group.total,
        nextCursor: (group.hasMore || candidates.length > limit) && sessions.length ? encodeCursor({ v: 1, kind: 'page', mode,
          scope: childScope(group.parentSessionId, agent), revision: result.projections.revision,
          key: keyForSession(sessions[sessions.length - 1], mode, true) }) : null };
    }) };
}

export async function queryExactSessions(ids: string[], includePaths: boolean) {
  if (!Array.isArray(ids) || ids.length > MAX_IDS || ids.some(id => typeof id !== 'string' || !id || id.length > 512)) {
    throw new RpcError('SESSION_LIST_IDS_INVALID', `ids must contain at most ${MAX_IDS} bounded Session IDs.`);
  }
  const resolved = sessionCatalogStore.resolveMany(ids);
  const resolutions = ids.map(requestedId => ({ requestedId, resolution: resolved[requestedId] }));
  const canonicalIds = resolutions.flatMap(item => item.resolution.kind === 'exact' || item.resolution.kind === 'alias' ? [item.resolution.sessionId] : []);
  const projections = await sessionRuntime.getSessionListProjections(canonicalIds, false);
  const scopes = sessionCatalogStore.getPresentationScopes(projections.sessions.map(session => session.id));
  const byId = new Map(projections.sessions.map(session => [session.id, withCanonicalScope(session, scopes[session.id])]));
  const canonicalPaths = includePaths ? sessionCatalogStore.getPresentationPaths(canonicalIds) : undefined;
  return { version: SESSION_LIST_API_VERSION, revision: projections.revision,
    results: resolutions.map(item => ({ requestedId: item.requestedId, resolution: item.resolution,
      session: item.resolution.kind === 'exact' || item.resolution.kind === 'alias' ? byId.get(item.resolution.sessionId) || null : null })),
    paths: includePaths ? Object.fromEntries(resolutions.flatMap(item => item.resolution.kind === 'exact' || item.resolution.kind === 'alias'
      ? [[item.requestedId, canonicalPaths?.[item.resolution.sessionId] || []]] : [])) : undefined };
}

export async function queryArchitecture(options: { agent?: string; limit: number; childLimit: number; cursor?: string }) {
  const roots = await querySessionListPage({ mode: 'time', limit: options.limit, cursor: options.cursor, roots: true, ...(options.agent ? { agent: options.agent } : {}) });
  const children = await queryChildrenPreviews(roots.sessions.map(session => session.id), 'time', options.childLimit, options.agent);
  const summary = sessionCatalogStore.getArchitectureSummary();
  const volatile = await sessionRuntime.getSessionListProjections([], true);
  const catalogRows = new Map(sessionCatalogStore.getMany(volatile.sessions.map(session => session.id)).map(row => [row.id, row]));
  for (const session of volatile.sessions) {
    const row = catalogRows.get(session.id); if (!row) continue;
    summary.busy += (session.busy ? 1 : 0) - (row.busy ? 1 : 0);
    summary.queued += (session.queueLength > 0 ? 1 : 0) - ((row.queueLength || 0) > 0 ? 1 : 0);
    summary.cachedTokens += session.tokenUsage.cachedTokens - Number(row.stats?.totalCachedTokens || 0);
    summary.inputTokens += session.tokenUsage.inputTokens - Number(row.stats?.totalInputTokens || 0);
    summary.outputTokens += session.tokenUsage.outputTokens - Number(row.stats?.totalOutputTokens || 0);
  }
  return { version: SESSION_LIST_API_VERSION, revision: roots.revision, summary,
    agentCounts: sessionCatalogStore.getAgentCounts(), agent: options.agent || null, roots, children: children.children };
}

export async function queryDescendants(requestedId: string, limit: number) {
  const resolution = sessionCatalogStore.resolveId(requestedId);
  if (resolution.kind === 'missing') throw new RpcError('SESSION_NOT_FOUND', 'Session not found.');
  if (resolution.kind === 'ambiguous') throw new RpcError('SESSION_ALIAS_AMBIGUOUS', 'Session alias is ambiguous.');
  const summary = sessionCatalogStore.getDescendantSummary(resolution.sessionId, limit);
  const projections = await sessionRuntime.getSessionListProjections(summary.rows.map(row => row.id), true);
  const volatileDescendants = new Set(sessionCatalogStore.filterDescendantIds(resolution.sessionId, projections.sessions.map(session => session.id)));
  const catalogRows = new Map(sessionCatalogStore.getMany([...volatileDescendants]).map(row => [row.id, row]));
  for (const session of projections.sessions) {
    if (!volatileDescendants.has(session.id)) continue;
    const row = catalogRows.get(session.id); if (!row) continue;
    summary.busy += (session.busy ? 1 : 0) - (row.busy ? 1 : 0);
    summary.queued += (session.queueLength > 0 ? 1 : 0) - ((row.queueLength || 0) > 0 ? 1 : 0);
    summary.cachedTokens += session.tokenUsage.cachedTokens - Number(row.stats?.totalCachedTokens || 0);
    summary.inputTokens += session.tokenUsage.inputTokens - Number(row.stats?.totalInputTokens || 0);
    summary.outputTokens += session.tokenUsage.outputTokens - Number(row.stats?.totalOutputTokens || 0);
  }
  const scopes = sessionCatalogStore.getPresentationScopes(projections.sessions.map(session => session.id));
  const { rows, ...counts } = summary;
  return { version: SESSION_LIST_API_VERSION, sessionId: resolution.sessionId, previewOnly: true,
    ...counts, sessions: projections.sessions.filter(session => rows.some(row => row.id === session.id))
      .map(session => withCanonicalScope(session, scopes[session.id])) };
}
