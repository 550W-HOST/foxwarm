import crypto from 'crypto';
import * as sessionManager from './sessionManager';
import { formatFoxwarmSystem } from './utils/promptWrappers';

const GRACE_MS = 300;
const scheduled = new Map<string, NodeJS.Timeout>();
const dependenciesByWaiter = new Map<string, string[]>();
const waitersByDependency = new Map<string, Set<string>>();
let initialized = false;

type WaitProjection = {
  id: string;
  timeoutSeconds?: number;
  waitExecIds?: string[];
  waitAnySessions?: string[];
  waitForInput?: true;
  declarationVersion?: number;
  waitAll?: { sessions?: string[]; satisfiedSessions?: string[] };
};

function currentWait(sessionId: string): WaitProjection | undefined {
  const wait = sessionManager.getSessionCatalog(sessionId)?.meta?.wait;
  return wait && typeof wait === 'object' && typeof wait.id === 'string' ? wait as WaitProjection : undefined;
}

function dependencies(wait: WaitProjection): string[] {
  const all = Array.isArray(wait.waitAll?.sessions) ? wait.waitAll!.sessions! : [];
  const satisfied = new Set(Array.isArray(wait.waitAll?.satisfiedSessions) ? wait.waitAll!.satisfiedSessions! : []);
  const pendingAll = all.filter(id => typeof id === 'string' && !satisfied.has(id));
  const any = Array.isArray(wait.waitAnySessions) ? wait.waitAnySessions.filter(id => typeof id === 'string') : [];
  return [...new Set([...pendingAll, ...any])].sort();
}

function isDiagnosticCandidate(wait: WaitProjection | undefined): wait is WaitProjection {
  return !!wait && wait.declarationVersion === 1 && wait.waitForInput !== true
    && !(typeof wait.timeoutSeconds === 'number' && wait.timeoutSeconds > 0)
    && !(Array.isArray(wait.waitExecIds) && wait.waitExecIds.length > 0)
    && dependencies(wait).length > 0;
}

function replaceIndex(sessionId: string): void {
  for (const dependency of dependenciesByWaiter.get(sessionId) || []) {
    const waiters = waitersByDependency.get(dependency);
    waiters?.delete(sessionId);
    if (waiters?.size === 0) waitersByDependency.delete(dependency);
  }
  const wait = currentWait(sessionId);
  const next = isDiagnosticCandidate(wait) ? dependencies(wait) : [];
  if (next.length) dependenciesByWaiter.set(sessionId, next); else dependenciesByWaiter.delete(sessionId);
  for (const dependency of next) {
    const waiters = waitersByDependency.get(dependency) || new Set<string>();
    waiters.add(sessionId);
    waitersByDependency.set(dependency, waiters);
  }
}

function schedule(sessionId: string): void {
  const wait = currentWait(sessionId);
  if (!isDiagnosticCandidate(wait)) return;
  const key = sessionId;
  const prior = scheduled.get(key); if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    scheduled.delete(key);
    void diagnose(sessionId, wait.id);
  }, GRACE_MS);
  timer.unref?.();
  scheduled.set(key, timer);
}

function onTransition(sessionId: string): void {
  replaceIndex(sessionId);
  schedule(sessionId);
  for (const waiter of waitersByDependency.get(sessionId) || []) schedule(waiter);
}

export function initializeWaitLivenessDiagnostics(): void {
  if (initialized) return;
  initialized = true;
  sessionManager.addSessionTransitionListener(onTransition);
  for (const sessionId of sessionManager.getAllSessions().keys()) replaceIndex(sessionId);
  for (const sessionId of dependenciesByWaiter.keys()) schedule(sessionId);
}

function hasDirectProgress(sessionId: string, isRoot = false): boolean {
  const session = sessionManager.getSessionCatalog(sessionId);
  if (!session) return false;
  const runtime = sessionManager.buildSessionRuntimeState(session);
  if (!isRoot && (runtime.state === 'requesting-model' || runtime.state === 'running-tool' || runtime.queueLength > 0)) return true;
  const wait = currentWait(sessionId);
  if (!wait) return false;
  return (typeof wait.timeoutSeconds === 'number' && Number.isFinite(wait.timeoutSeconds) && wait.timeoutSeconds > 0)
    || wait.waitForInput === true
    || (Array.isArray(wait.waitExecIds) && wait.waitExecIds.length > 0);
}

function graphHasProgress(rootSessionId: string): { progress: boolean; fingerprint: string } {
  const visiting = new Set<string>();
  const memo = new Map<string, boolean>();
  const observed: string[] = [];
  const visit = (sessionId: string, isRoot = false): boolean => {
    const known = memo.get(sessionId); if (known !== undefined) return known;
    if (visiting.has(sessionId)) return false;
    visiting.add(sessionId);
    const session = sessionManager.getSessionCatalog(sessionId);
    const wait = currentWait(sessionId);
    const deps = wait ? dependencies(wait) : [];
    const runtime = session ? sessionManager.buildSessionRuntimeState(session) : undefined;
    observed.push(JSON.stringify({ sessionId, exists: !!session, state: runtime?.state,
      queueLength: runtime?.queueLength || 0, timeoutSeconds: wait?.timeoutSeconds,
      waitForInput: wait?.waitForInput === true, waitExecIds: wait?.waitExecIds || [], dependencies: deps }));
    let progress = hasDirectProgress(sessionId, isRoot);
    if (!progress) progress = deps.some(dep => visit(dep));
    visiting.delete(sessionId);
    memo.set(sessionId, progress);
    return progress;
  };
  const progress = visit(rootSessionId, true);
  observed.sort();
  return { progress, fingerprint: crypto.createHash('sha256').update(observed.join('\n')).digest('hex').slice(0, 24) };
}

export function armWaitLivenessDiagnostic(sourceSessionId: string, _waitId: string): void {
  initializeWaitLivenessDiagnostics();
  replaceIndex(sourceSessionId);
  schedule(sourceSessionId);
}

async function diagnose(sourceSessionId: string, expectedWaitId: string): Promise<void> {
  const wait = currentWait(sourceSessionId);
  if (!isDiagnosticCandidate(wait) || wait.id !== expectedWaitId) return;
  const result = graphHasProgress(sourceSessionId);
  if (result.progress) return;
  const source = sessionManager.getSessionCatalog(sourceSessionId);
  if (Array.isArray(source?.meta?.waitLivenessFingerprints) && source.meta.waitLivenessFingerprints.includes(result.fingerprint)) return;
  const message = formatFoxwarmSystem({ kind: 'event', type: 'wait-sources-quiescent', fingerprint: result.fingerprint },
    'The declared wait dependency Sessions currently show no queued, active, timed, exec-backed, input-backed, or transitively declared progress path after a short recheck. This is an observed potentially quiescent state, not proof of deadlock; explicit user or inter-session input may be needed.');
  await sessionManager.queueSessionSystemEvent(sourceSessionId, message, 'background', undefined, undefined, undefined,
    { fingerprint: result.fingerprint, waitId: expectedWaitId });
}
