import crypto from 'crypto';
import fs from 'fs-extra';
import type { ExternalNodeOwner } from './nodeProtocol';
import type { FileOperations } from './fileOperations';
import type { ExecBackend, ProviderExecReference } from './execBackend';
import path from 'path';
import type { ExecCwdSource } from './execCwd';
import { NativeExecBackend, MISSING_STATUS_ERROR } from './nativeExecBackend';
import { truncateOutputForDisplay, type OutputTruncationResult } from './outputTruncation';
import { estimateTokenCount } from './tokenCount';
import {
  BOUNDED_TEXT_SAMPLE_BYTES,
  MAX_FULL_TEXT_READ_BYTES,
  buildBoundedTextExcerpt,
  formatBoundedBinaryHexPreview,
  formatDisplayByteConversionDisclaimer,
  readBoundedFileSamples,
} from './boundedTextExcerpt';
import {
  type ProcessOperations,
  type ProcessSnapshotEntry,
} from './processOperations';

export type { ProcessSnapshotEntry } from './processOperations';

export const DEFAULT_EXEC_TIMEOUT_SECONDS = 15;
export const MIN_EXEC_TIMEOUT_SECONDS = 1;
export const MAX_EXEC_TIMEOUT_SECONDS = 60;

export interface ResolvedExecTimeout {
  requestedSeconds: number;
  effectiveSeconds: number;
  warning?: string;
}

export function resolveExecTimeoutSeconds(timeoutValue: unknown): ResolvedExecTimeout {
  if (timeoutValue === undefined || timeoutValue === null) {
    return {
      requestedSeconds: DEFAULT_EXEC_TIMEOUT_SECONDS,
      effectiveSeconds: DEFAULT_EXEC_TIMEOUT_SECONDS,
    };
  }
  if (typeof timeoutValue !== 'number' || !Number.isFinite(timeoutValue)) {
    throw new Error(`timeout must be a number between ${MIN_EXEC_TIMEOUT_SECONDS} and ${MAX_EXEC_TIMEOUT_SECONDS} seconds`);
  }
  if (timeoutValue < MIN_EXEC_TIMEOUT_SECONDS) {
    throw new Error(`timeout must be between ${MIN_EXEC_TIMEOUT_SECONDS} and ${MAX_EXEC_TIMEOUT_SECONDS} seconds`);
  }
  if (timeoutValue > MAX_EXEC_TIMEOUT_SECONDS) {
    return {
      requestedSeconds: timeoutValue,
      effectiveSeconds: MAX_EXEC_TIMEOUT_SECONDS,
      warning: `WARNING: Requested timeout ${formatExecTimeoutSeconds(timeoutValue)}s exceeds the ${MAX_EXEC_TIMEOUT_SECONDS}s maximum; using ${MAX_EXEC_TIMEOUT_SECONDS}s.`,
    };
  }
  return { requestedSeconds: timeoutValue, effectiveSeconds: timeoutValue };
}

const RECONCILE_INTERVAL_MS = 5000;
const STATUS_POLL_INTERVAL_MS = 250;
const PARTIAL_LOG_BYTES = 4000;
const INLINE_LOG_LIMIT_BYTES = 20000;
const INLINE_EXCERPT_HALF_BYTES = 5000;
// Compatibility exports for persistent-exec callers/tests; canonical bounded-read
// semantics are owned by boundedTextExcerpt.
export const MAX_FULL_LOG_READ_BYTES = MAX_FULL_TEXT_READ_BYTES;
export const OVERSIZED_LOG_SAMPLE_BYTES = BOUNDED_TEXT_SAMPLE_BYTES;
const BACKGROUND_COMMAND_PREVIEW_LIMIT = 100;
export const BACKGROUND_PROCESS_CMDLINE_LIMIT = 100;
export const BACKGROUND_PROCESS_TREE_LIMIT = 40;
export const BACKGROUND_COMPLETION_EVENT_RETENTION_MS = 24 * 60 * 60 * 1000;
const BACKGROUND_PROCESS_TREE_MAX_INDENT = 20;
export interface ExecStatus {
  exitCode: number | null;
  finishedAt: string;
  durationMs?: number;
  /** Internal display hint; the event timestamp is not a measured exit time. */
  finishedAtIsEstimated?: boolean;
  error?: string;
}

export type ProgrammaticExecResult = {
  output: string;
  content?: string;
  truncated: boolean;
  status: 'completed' | 'running';
  exitCode?: number | null;
  execId: string;
  logPath: string;
  sizeBytes?: number;
};

export interface RunningExecEntry {
  id: string;
  pid?: number;
  backend?: ProviderExecReference;
  sessionId?: string;
  agentName?: string;
  externalOwner?: ExternalNodeOwner;
  nodeId: string;
  command: string;
  initialCwd: string;
  resolvedCwd?: string;
  cwdRaw?: string;
  cwdSource?: ExecCwdSource;
  logPath: string;
  statusPath?: string;
  cwdPath?: string;
  startedAt: number;
  notifyOnCompletion: boolean;
  completionCapability?: string;
  recoveredAfterRestart?: boolean;
}

export interface StartPersistentExecOptions {
  execId?: string;
  backend?: { providerId: string };
  command: string;
  sessionId?: string;
  agentName?: string;
  externalOwner?: ExternalNodeOwner;
  nodeId?: string;
  cwd?: unknown;
  sessionCwd?: unknown;
  completionCapability?: string;
  /** Optional caller fence after artifact setup but before trying to launch a process. */
  onBeforeProcessLaunch?: () => void;
  /** Independent owner-loss/deadline cancellation; ordinary foreground Stop is not forwarded to start. */
  hardCancellationSignal?: AbortSignal;
  onProcessStarted?: () => void;
}

interface LogExcerpt {
  text: string;
  truncated: boolean;
  capturedOutputWasEmpty: boolean;
  capturedOutputEndedWithLf: boolean;
  truncation?: OutputTruncationResult;
  oversized?: boolean;
  originalByteLength?: number;
  hasDisplayByteConversions?: boolean;
}

export type ExecCompletionDispatcher = (entry: RunningExecEntry, status: ExecStatus, message: string) => Promise<void>;

export interface PersistentExecManagerOptions {
  getDefaultCwd: (agentName: string) => string;
  getExecTempDir: (agentName: string) => string;
  /** Actual Agent directory in this process's target namespace, if one exists. */
  getAgentDir?: (agentName: string) => string;
  getExternalDefaultCwd?: (owner: ExternalNodeOwner) => string;
  getExternalExecTempDir?: (owner: ExternalNodeOwner) => string;
  registryPath?: string;
  nodeId?: string;
  completionDispatcher?: ExecCompletionDispatcher;
  processOperations?: ProcessOperations;
  resolveBackend?: (providerId: string, nodeId: string) => ExecBackend;
  processSnapshotProvider?: () => Promise<ProcessSnapshotEntry[]>;
  onRegistryIdle?: () => void;
  onTrackingExpired?: (entry: RunningExecEntry) => void;
  /** Test seam for petname selection. Production uses crypto.randomInt. */
  randomInt?: (maxExclusive: number) => number;
  /** Test seam for elapsed display and completion-retention checks. Production uses Date.now. */
  now?: () => number;
  logger?: {
    info?: (payload?: any, message?: string) => void;
    warn?: (payload?: any, message?: string) => void;
    error?: (payload?: any, message?: string) => void;
  };
}

const EXEC_ID_ADJECTIVES = [
  'amber', 'brisk', 'calm', 'clear', 'cool', 'coral', 'crisp', 'deft',
  'eager', 'fair', 'gentle', 'green', 'happy', 'ivory', 'jolly', 'keen',
  'lively', 'lucid', 'mellow', 'misty', 'navy', 'neat', 'quiet', 'rapid',
  'silver', 'solar', 'steady', 'swift', 'tidy', 'vivid', 'warm', 'wise',
  'airy', 'bold', 'bright', 'cozy', 'dry', 'even', 'fresh', 'golden',
  'grand', 'light', 'lucky', 'marine', 'merry', 'mild', 'nimble', 'noble',
  'plain', 'prime', 'ready', 'rosy', 'round', 'safe', 'sharp', 'soft',
  'sound', 'sunny', 'true', 'urban', 'velvet', 'wild', 'young', 'zesty',
  'agile', 'alert', 'alpine', 'able', 'azure', 'balmy', 'breezy', 'candid',
  'cheery', 'clever', 'cosmic', 'dapper', 'earnest', 'earthy', 'fluent', 'glowing',
  'graceful', 'hardy', 'hazy', 'humble', 'ideal', 'jaunty', 'kind', 'lovely',
  'loyal', 'magic', 'modern', 'modest', 'natural', 'patient', 'playful', 'open',
  'peachy', 'peaceful', 'polished', 'proud', 'pure', 'radiant', 'robust', 'royal',
  'precise', 'rural', 'sandy', 'serene', 'simple', 'sleek', 'smart', 'smooth',
  'snowy', 'stable', 'sturdy', 'subtle', 'tender', 'tranquil', 'trusty', 'upbeat',
  'verdant', 'vital', 'welcome', 'windy', 'winsome', 'woody', 'worthy', 'yellow',
] as const;
const EXEC_ID_NOUNS = [
  'badger', 'beacon', 'cedar', 'comet', 'coral', 'crane', 'dolphin', 'ember',
  'falcon', 'fern', 'finch', 'fox', 'harbor', 'heron', 'island', 'lantern',
  'lynx', 'maple', 'meadow', 'otter', 'owl', 'panda', 'pebble', 'pine',
  'quartz', 'raven', 'river', 'sparrow', 'spruce', 'tiger', 'willow', 'wren',
  'acorn', 'birch', 'brook', 'canyon', 'clover', 'cloud', 'cove', 'dune',
  'elm', 'field', 'grove', 'hill', 'lake', 'lark', 'lotus', 'marsh',
  'moon', 'moss', 'oasis', 'orchid', 'peak', 'petal', 'plume', 'pond',
  'reef', 'ridge', 'star', 'stone', 'summit', 'trail', 'vale', 'wave',
  'agate', 'alder', 'alpaca', 'anchor', 'antler', 'apple', 'aspen', 'atlas',
  'aurora', 'bamboo', 'barley', 'basil', 'bay', 'bayou', 'beach', 'bear',
  'bee', 'bell', 'berry', 'bison', 'blossom', 'bluebird', 'boat', 'boulder',
  'branch', 'breeze', 'bridge', 'buffalo', 'butterfly', 'cabin', 'cactus', 'camel',
  'canary', 'cape', 'cardinal', 'caribou', 'carp', 'castle', 'cave', 'cherry',
  'chestnut', 'cicada', 'cliff', 'coast', 'copper', 'creek', 'cricket', 'crow',
  'cypress', 'dahlia', 'daisy', 'deer', 'delta', 'desert', 'dew', 'dogwood',
  'dove', 'dragon', 'drift', 'eagle', 'earth', 'egret', 'fawn', 'feather',
  'firefly', 'fjord', 'flame', 'flint', 'flora', 'flower', 'forest', 'fountain',
  'garden', 'gazelle', 'gecko', 'glacier', 'glade', 'granite', 'grass', 'gull',
  'hawk', 'hazel', 'heather', 'honey', 'horizon', 'horse', 'ibis', 'iris',
  'jade', 'jasmine', 'jay', 'juniper', 'kelp', 'kingfisher', 'kiwi', 'lagoon',
  'lavender', 'leaf', 'lemon', 'leopard', 'lighthouse', 'lilac', 'lily', 'lion',
  'mango', 'marina', 'marten', 'merlin', 'mesa', 'meteor', 'mint', 'monarch',
  'morning', 'mountain', 'nectar', 'nightingale', 'oak', 'ocean', 'olive', 'opal',
  'orange', 'oriole', 'palm', 'panther', 'papaya', 'parrot', 'pasture', 'peach',
  'pear', 'pearl', 'pelican', 'perch', 'phoenix', 'pigeon', 'pinecone', 'planet',
  'plateau', 'poplar', 'prairie', 'puffin', 'puma', 'quail', 'rabbit', 'rain',
  'rainbow', 'redwood', 'robin', 'rose', 'rosewood', 'sage', 'salmon', 'sand',
  'savanna', 'seabird', 'seal', 'sequoia', 'shadow', 'shark', 'shell', 'shore',
  'sky', 'slope', 'snail', 'snow', 'songbird', 'sonnet', 'spring', 'stream',
  'sun', 'sunset', 'swan', 'tern', 'thistle', 'thunder', 'topaz', 'toucan',
  'trout', 'tulip', 'turtle', 'valley', 'vine', 'violet', 'walnut', 'water',
  'waterfall', 'weasel', 'whale', 'wheat', 'wolf', 'wood', 'yarrow', 'zebra',
  'zephyr', 'harvest', 'hemlock', 'hickory', 'holly', 'magnolia', 'mulberry', 'nectarine',
] as const;
export const PERSISTENT_EXEC_ID_PATTERN = /^[a-z]+-[a-z]+$/;
export const LEGACY_PERSISTENT_EXEC_ID_PATTERN = /^exec_[A-Za-z0-9_-]{8,160}$/;
export const PERSISTENT_EXEC_ID_NAMESPACE_SIZE = EXEC_ID_ADJECTIVES.length * EXEC_ID_NOUNS.length;
export const PERSISTENT_EXEC_ID_MAX_ATTEMPTS = 128;
export const PERSISTENT_EXEC_RECENT_ID_LIMIT = 1024;
export const PERSISTENT_EXEC_ID_COLLISION_CODE = 'PERSISTENT_EXEC_ID_COLLISION';

export class PersistentExecIdCollisionError extends Error {
  readonly code = PERSISTENT_EXEC_ID_COLLISION_CODE;
  constructor(id: string) { super(`Persistent exec \`${id}\` already exists or is retained as a recent completion identity.`); }
}

export function isSupportedPersistentExecId(value: unknown): value is string {
  return typeof value === 'string'
    && (PERSISTENT_EXEC_ID_PATTERN.test(value) || LEGACY_PERSISTENT_EXEC_ID_PATTERN.test(value));
}

export function generatePersistentExecPetname(randomInt: (maxExclusive: number) => number = max => crypto.randomInt(max)): string {
  const adjectiveIndex = randomInt(EXEC_ID_ADJECTIVES.length);
  const nounIndex = randomInt(EXEC_ID_NOUNS.length);
  if (!Number.isInteger(adjectiveIndex) || adjectiveIndex < 0 || adjectiveIndex >= EXEC_ID_ADJECTIVES.length
    || !Number.isInteger(nounIndex) || nounIndex < 0 || nounIndex >= EXEC_ID_NOUNS.length) {
    throw new Error('Persistent exec petname random source returned an out-of-range value.');
  }
  return `${EXEC_ID_ADJECTIVES[adjectiveIndex]}-${EXEC_ID_NOUNS[nounIndex]}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}

function escapeInlineCode(text: string): string {
  return text.replace(/`/g, '\\`');
}

function summarizeCommandForNotification(text: string, maxLength: number = BACKGROUND_COMMAND_PREVIEW_LIMIT): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxLength) return compact;
  const marker = '...[foxwarm: command middle omitted]...';
  if (maxLength <= marker.length) return compact.slice(0, maxLength);
  const remaining = maxLength - marker.length;
  const headLength = Math.ceil(remaining * 0.6);
  const tailLength = remaining - headLength;
  return `${compact.slice(0, headLength)}${marker}${compact.slice(-tailLength)}`;
}

function formatExecTimeoutSeconds(seconds: number): string {
  return Number.isInteger(seconds) ? String(seconds) : String(seconds);
}

export function formatExecDuration(milliseconds: number): string | undefined {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const tenths = Math.round(milliseconds / 100);
  const hours = Math.floor(tenths / 36_000);
  const minutes = Math.floor((tenths % 36_000) / 600);
  const seconds = (tenths % 600) / 10;
  return [hours ? `${hours}h` : '', minutes ? `${minutes}m` : '', `${seconds}s`].filter(Boolean).join(' ');
}


function formatCompletedExecDuration(entry: RunningExecEntry, status: ExecStatus): string {
  // Older fallback files recorded detection time, not the process's exit time.
  const duration = status.durationMs !== undefined ? formatExecDuration(status.durationMs) : status.finishedAtIsEstimated || status.error === MISSING_STATUS_ERROR ? undefined
    : formatExecDuration(Date.parse(status.finishedAt) - entry.startedAt);
  return `Duration: ${duration ?? 'unknown'}`;
}

function buildBackgroundTimeoutShortNotice(timeoutSeconds: number): string {
  return `[Process running longer than ${formatExecTimeoutSeconds(timeoutSeconds)}s]`;
}

function buildBackgroundTimeoutFullNotice(timeoutSeconds: number): string {
  const shortNotice = buildBackgroundTimeoutShortNotice(timeoutSeconds);
  return `${shortNotice} Switched to background. The system will send a notification message when done. STOP calling tools to check status. Wait for notification unless working on other tasks in parallel; if you continue other work, remember this process remains outstanding until its completion message arrives.`;
}

export function truncateProcessCmdline(cmdline: string, maxLength: number = BACKGROUND_PROCESS_CMDLINE_LIMIT): string {
  const compact = cmdline.replace(/\s+/g, ' ').trim() || '[cmdline unavailable]';
  const characters = Array.from(compact);
  if (characters.length <= maxLength) return compact;
  if (maxLength <= 1) return characters.slice(0, Math.max(0, maxLength)).join('');
  return `${characters.slice(0, maxLength - 1).join('')}…`;
}

export function formatProcessTreeSnapshot(entries: ProcessSnapshotEntry[], rootPid: number): string {
  const heading = `Process tree (best-effort live snapshot; managed shell-script root PID ${rootPid}):`;
  const byPid = new Map<number, ProcessSnapshotEntry>();
  for (const entry of entries) {
    if (!Number.isInteger(entry.pid) || entry.pid <= 0 || byPid.has(entry.pid)) continue;
    byPid.set(entry.pid, entry);
  }
  if (!byPid.has(rootPid)) {
    return `${heading}\n(Process tree unavailable: the root process was no longer visible during inspection.)`;
  }

  const children = new Map<number, ProcessSnapshotEntry[]>();
  for (const entry of byPid.values()) {
    const siblings = children.get(entry.parentPid) || [];
    siblings.push(entry);
    children.set(entry.parentPid, siblings);
  }
  for (const siblings of children.values()) siblings.sort((left, right) => left.pid - right.pid);

  const ordered: Array<{ entry: ProcessSnapshotEntry; depth: number }> = [];
  const visited = new Set<number>();
  const pending: Array<{ entry: ProcessSnapshotEntry; depth: number }> = [{ entry: byPid.get(rootPid)!, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.entry.pid)) continue;
    visited.add(current.entry.pid);
    ordered.push(current);
    const descendants = children.get(current.entry.pid) || [];
    for (let index = descendants.length - 1; index >= 0; index -= 1) {
      pending.push({ entry: descendants[index], depth: current.depth + 1 });
    }
  }

  const visible = ordered.slice(0, BACKGROUND_PROCESS_TREE_LIMIT);
  const lines = visible.map(({ entry, depth }) => {
    const indent = ' '.repeat(Math.min(depth * 2, BACKGROUND_PROCESS_TREE_MAX_INDENT));
    return `${indent}PID ${entry.pid}: ${truncateProcessCmdline(entry.cmdline)}`;
  });
  const omitted = ordered.length - visible.length;
  if (omitted > 0) lines.push(`[foxwarm: ${omitted} additional descendant process(es) omitted]`);
  return `${heading}\n${lines.join('\n')}`;
}

export class PersistentExecManager {
  private runningExecs = new Map<string, RunningExecEntry>();
  private initialized = false;
  private shuttingDown = false;
  private initializationPromise: Promise<void> | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconcileChain: Promise<void> = Promise.resolve();
  private registryMutationChain: Promise<void> = Promise.resolve();
  private execIdAllocationChain: Promise<void> = Promise.resolve();
  private readonly reservedExecIds = new Set<string>();
  private recentExecIds: string[] = [];
  private readonly pendingStatus = new Map<string, Promise<ExecStatus | null>>();
  private readonly nativeBackend: NativeExecBackend;
  private readonly completionDispatcher: ExecCompletionDispatcher;

  constructor(private readonly options: PersistentExecManagerOptions) {
    this.nativeBackend = new NativeExecBackend(options);
    this.completionDispatcher = options.completionDispatcher || (async () => {});
  }

  getDefaultCwd(agentName = 'main'): string {
    return this.options.getDefaultCwd(agentName);
  }

  private registryPath(): string | undefined {
    return this.options.registryPath;
  }

  private async saveRunningExecs(): Promise<void> {
    const registryPath = this.registryPath();
    if (!registryPath) return;
    await fs.ensureDir(path.dirname(registryPath));
    const tempPath = `${registryPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeJson(tempPath, { execs: Array.from(this.runningExecs.values()), recentExecIds: this.recentExecIds }, { spaces: 2 });
      await fs.rename(tempPath, registryPath);
    } catch (err) {
      await fs.remove(tempPath).catch(() => {});
      throw err;
    }
  }

  private async reserveExecId(requested?: string): Promise<string> {
    let release!: () => void;
    const previous = this.execIdAllocationChain;
    this.execIdAllocationChain = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      if (requested !== undefined) {
        if (!isSupportedPersistentExecId(requested)) throw new Error('Persistent exec ID must be a lowercase adjective+noun petname such as `quiet-otter` or a supported legacy `exec_...` ID.');
        if (this.runningExecs.has(requested) || this.reservedExecIds.has(requested) || this.recentExecIds.includes(requested)) throw new PersistentExecIdCollisionError(requested);
        this.reservedExecIds.add(requested);
        return requested;
      }
      for (let attempt = 0; attempt < PERSISTENT_EXEC_ID_MAX_ATTEMPTS; attempt++) {
        const candidate = generatePersistentExecPetname(this.options.randomInt);
        if (this.runningExecs.has(candidate) || this.reservedExecIds.has(candidate) || this.recentExecIds.includes(candidate)) continue;
        this.reservedExecIds.add(candidate);
        return candidate;
      }
      throw new Error(`Persistent exec petname space did not yield a unique ID after ${PERSISTENT_EXEC_ID_MAX_ATTEMPTS} attempts.`);
    } finally {
      release();
    }
  }

  private async commitRegistryMutation<T>(mutate: () => T): Promise<T> {
    let result!: T;
    const operation = this.registryMutationChain.then(async () => {
      result = mutate();
      await this.saveRunningExecs();
    });
    this.registryMutationChain = operation.then(() => undefined, () => undefined);
    await operation;
    return result;
  }

  private async loadRunningExecs(): Promise<void> {
    this.runningExecs.clear();
    const registryPath = this.registryPath();
    if (!registryPath) return;

    try {
      const data = await fs.readJson(registryPath);
      this.recentExecIds = Array.isArray(data?.recentExecIds)
        ? [...new Set<string>((data.recentExecIds as unknown[]).filter(isSupportedPersistentExecId))].slice(-PERSISTENT_EXEC_RECENT_ID_LIMIT)
        : [];
      const rawExecs = Array.isArray(data?.execs) ? data.execs : [];
      for (const raw of rawExecs) {
        if (!raw || typeof raw !== 'object') continue;
        if (!isSupportedPersistentExecId(raw.id) || typeof raw.logPath !== 'string' || !Number.isFinite(Number(raw.startedAt))) continue;
        const backend = raw.backend && typeof raw.backend.providerId === 'string' && typeof raw.backend.ref === 'string'
          ? { providerId: raw.backend.providerId, ref: raw.backend.ref } : undefined;
        if (raw.backend !== undefined && !backend) continue;
        if (!backend && (typeof raw.statusPath !== 'string' || !Number.isFinite(Number(raw.pid)))) continue;
        const externalOwner: ExternalNodeOwner | undefined = raw.externalOwner?.kind === 'external'
          && typeof raw.externalOwner.externalId === 'string' && raw.externalOwner.externalId
          && typeof raw.externalOwner.contextId === 'string' && raw.externalOwner.contextId
          && this.options.getExternalDefaultCwd && this.options.getExternalExecTempDir
          ? { kind: 'external', externalId: raw.externalOwner.externalId, contextId: raw.externalOwner.contextId } : undefined;
        if (raw.externalOwner !== undefined && !externalOwner) continue;
        const agentName = externalOwner ? undefined : (typeof raw.agentName === 'string' && raw.agentName.trim().length > 0 ? raw.agentName : 'main');
        const entry: RunningExecEntry = {
          id: raw.id,
          ...(!backend ? { pid: Number(raw.pid) } : typeof raw.pid === 'number' ? { pid: raw.pid } : {}),
          ...(backend ? { backend } : {}),
          sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
          ...(externalOwner ? { externalOwner } : { agentName }),
          nodeId: typeof raw.nodeId === 'string' && raw.nodeId.trim().length > 0 ? raw.nodeId : (this.options.nodeId || 'master'),
          command: typeof raw.command === 'string' ? raw.command : '',
          ...(typeof raw.resolvedCwd === 'string' ? { resolvedCwd: raw.resolvedCwd } : {}),
          initialCwd: typeof raw.initialCwd === 'string' && raw.initialCwd.trim().length > 0 ? raw.initialCwd
            : externalOwner ? this.options.getExternalDefaultCwd!(externalOwner) : this.getDefaultCwd(agentName!),
          cwdRaw: typeof raw.cwdRaw === 'string' ? raw.cwdRaw : undefined,
          cwdSource: raw.cwdSource === 'explicit' || raw.cwdSource === 'session' || raw.cwdSource === 'default' ? raw.cwdSource : undefined,
          logPath: raw.logPath,
          statusPath: raw.statusPath,
          cwdPath: typeof raw.cwdPath === 'string' && raw.cwdPath.trim().length > 0 ? raw.cwdPath : `${raw.logPath}.cwd.txt`,
          startedAt: Number(raw.startedAt),
          notifyOnCompletion: raw.notifyOnCompletion === true,
          completionCapability: typeof raw.completionCapability === 'string' ? raw.completionCapability : undefined,
          recoveredAfterRestart: raw.recoveredAfterRestart === true,
        };
        this.runningExecs.set(entry.id, entry);
      }
    } catch (err: any) {
      if (err?.code !== 'ENOENT') this.options.logger?.error?.({ err }, 'Failed to load running exec registry');
    }
  }

  private async removeRunningExec(id: string): Promise<void> {
    let becameIdle = false;
    await this.commitRegistryMutation(() => {
      this.runningExecs.delete(id);
      if (!this.recentExecIds.includes(id)) this.recentExecIds = [...this.recentExecIds, id].slice(-PERSISTENT_EXEC_RECENT_ID_LIMIT);
      becameIdle = this.runningExecs.size === 0;
    });
    if (becameIdle) this.options.onRegistryIdle?.();
  }

  private async updateRunningExec(id: string, updates: Partial<RunningExecEntry>): Promise<RunningExecEntry | null> {
    return await this.commitRegistryMutation(() => {
      const current = this.runningExecs.get(id);
      if (!current) return null;
      const updated = { ...current, ...updates };
      this.runningExecs.set(id, updated);
      return updated;
    });
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.shuttingDown = false;
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeOnce().finally(() => {
        this.initializationPromise = null;
      });
    }
    await this.initializationPromise;
  }

  async reconcileNow(): Promise<void> {
    await this.initialize();
    await this.queueReconcile();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.initializationPromise) await this.initializationPromise.catch(() => {});
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
    await this.reconcileChain; await this.registryMutationChain;
    this.initialized = false;
  }

  private async initializeOnce(): Promise<void> {
    await this.loadRunningExecs();
    let changed = false;
    for (const [id, entry] of this.runningExecs.entries()) {
      if (!entry.notifyOnCompletion) {
        this.runningExecs.set(id, { ...entry, notifyOnCompletion: true, recoveredAfterRestart: true });
        changed = true;
      }
    }
    if (changed) await this.saveRunningExecs();
    this.scheduleReconcile();
    this.initialized = true;
    this.options.logger?.info?.({ execCount: this.runningExecs.size }, 'Exec manager initialized');
    await this.queueReconcile();
  }

  private scheduleReconcile(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = setInterval(() => { if (!this.shuttingDown) void this.queueReconcile(); }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref?.();
  }

  private async queueReconcile(): Promise<void> {
    if (this.shuttingDown) return;
    this.reconcileChain = this.reconcileChain.then(async () => {
      await this.reconcileRunningExecs();
    }).catch(err => {
      this.options.logger?.error?.({ err }, 'Exec reconcile loop failed');
    });
    await this.reconcileChain;
  }

  async startPersistentExec(options: StartPersistentExecOptions): Promise<RunningExecEntry> {
    const execId = await this.reserveExecId(options.execId);
    try {
      const backend = options.backend ? this.options.resolveBackend?.(options.backend.providerId, options.nodeId || this.options.nodeId || 'master') : this.nativeBackend;
      if (!backend) throw new Error('Exec backend is unavailable.');
      const entry = await backend.start({ ...options, execId });
      await this.commitRegistryMutation(() => { this.runningExecs.set(entry.id, entry); });
      this.options.logger?.info?.({ execId: entry.id, pid: entry.pid, sessionId: entry.sessionId, nodeId: entry.nodeId }, 'Persistent exec started');
      return entry;
    } finally {
      this.reservedExecIds.delete(execId);
    }
  }

  async getResolvedExecCwd(entry: RunningExecEntry): Promise<string> {
    return await this.backend(entry).readFinishedWorkingDirectory(entry) || entry.initialCwd;
  }

  private async readLogExcerpt(filePath: string, maxChars: number, files: FileOperations): Promise<LogExcerpt> {
    const stat = await files.stat(filePath);
    if (stat.size <= 0) {
      return {
        text: '',
        truncated: false,
        capturedOutputWasEmpty: true,
        capturedOutputEndedWithLf: false,
      };
    }

    if (stat.size > MAX_FULL_LOG_READ_BYTES) {
      const { head, tail } = await readBoundedFileSamples(filePath, stat.size, files);
      const capturedOutputEndedWithLf = tail.length > 0 && tail[tail.length - 1] === 0x0a;
      const excerpt = buildBoundedTextExcerpt(head, tail, {
        headMayEndMidCodePoint: true,
        tailMayStartMidCodePoint: true,
      });
      if (excerpt.isBinary) {
        return {
          text: formatBoundedBinaryHexPreview(head, tail, stat.size, 'oversized binary log'),
          truncated: true,
          capturedOutputWasEmpty: false,
          capturedOutputEndedWithLf,
          oversized: true,
          originalByteLength: stat.size,
        };
      }

      const escapedByteNote = excerpt.escapedByteCount > 0
        ? `; escaped ${excerpt.escapedByteCount} byte(s)`
        : '';
      const text = [
        excerpt.renderedHead!,
        `[foxwarm: oversized log middle omitted; showing bounded head and tail samples from a ${stat.size}-byte file${escapedByteNote}]`,
        excerpt.renderedTail!,
      ].join('\n');
      const truncation = truncateOutputForDisplay(text, {
        maxChars,
        force: text.length > maxChars,
        lineOmissionReason: 'this oversized log sample is too long',
      });
      return {
        text: truncation.text,
        truncated: true,
        capturedOutputWasEmpty: false,
        capturedOutputEndedWithLf,
        truncation: truncation.truncated ? truncation : undefined,
        oversized: true,
        originalByteLength: stat.size,
        hasDisplayByteConversions: excerpt.escapedByteCount > 0,
      };
    }

    const bytes = await files.read(filePath, 0, stat.size);
    if (bytes.length !== stat.size) throw new Error('Command output read was incomplete.');
    const text = bytes.toString('utf8');
    const truncation = truncateOutputForDisplay(text, {
      maxChars,
      force: text.length > maxChars,
      lineOmissionReason: 'this file is too long',
    });
    return {
      text: truncation.text,
      truncated: truncation.truncated,
      capturedOutputWasEmpty: text.length === 0,
      capturedOutputEndedWithLf: text.endsWith('\n'),
      truncation: truncation.truncated ? truncation : undefined,
    };
  }

  private async readPartialLog(entry: RunningExecEntry): Promise<LogExcerpt> {
    try {
      const excerpt = await this.readLogExcerpt(entry.logPath, PARTIAL_LOG_BYTES, this.backend(entry).files);
      if (excerpt.capturedOutputWasEmpty) {
        return { ...excerpt, text: '(Command started, no output yet)', truncated: false };
      }
      if (!excerpt.truncated) return excerpt;
      const markerSeparator = excerpt.text.endsWith('\n') ? '' : '\n';
      return { ...excerpt, text: `${excerpt.text}${markerSeparator}...(truncated)` };
    } catch (err: any) {
      if (entry.backend) return { text: '(Command output unavailable)', truncated: true, capturedOutputWasEmpty: true, capturedOutputEndedWithLf: false };
      if (err?.code === 'ENOENT') {
        return {
          text: '(Command started, no output yet)',
          truncated: false,
          capturedOutputWasEmpty: true,
          capturedOutputEndedWithLf: false,
        };
      }
      throw err;
    }
  }

  private async readDisplayOutput(entry: RunningExecEntry): Promise<LogExcerpt> {
    try {
      const excerpt = await this.readLogExcerpt(entry.logPath, INLINE_LOG_LIMIT_BYTES, this.backend(entry).files);
      if (excerpt.capturedOutputWasEmpty) return { ...excerpt, text: '(No output)', truncated: false };
      if (!excerpt.truncated && estimateTokenCount(excerpt.text) <= 10000) return excerpt;
      if (excerpt.truncated) return excerpt;
      const truncation = truncateOutputForDisplay(excerpt.text, {
        maxChars: INLINE_EXCERPT_HALF_BYTES * 2,
        force: true,
        lineOmissionReason: 'this file is too long',
      });
      return {
        ...excerpt,
        text: truncation.text,
        truncated: true,
        truncation,
      };
    } catch (err: any) {
      if (entry.backend) return { text: '(Command output unavailable)', truncated: true, capturedOutputWasEmpty: true, capturedOutputEndedWithLf: false };
      if (err?.code === 'ENOENT') {
        return {
          text: '(No output)',
          truncated: false,
          capturedOutputWasEmpty: true,
          capturedOutputEndedWithLf: false,
        };
      }
      throw err;
    }
  }

  private buildForegroundFooter(entry: RunningExecEntry, status: ExecStatus, output: LogExcerpt, warning?: string): string {
    const lines = ['---', `Exit code: ${status.exitCode === null ? 'unknown' : status.exitCode}`];
    lines.push(formatCompletedExecDuration(entry, status));
    if (status.error) lines.push(`Error: ${status.error}`);
    if (warning) lines.push(warning);
    if (output.truncated) {
      lines.push(`Command output saved to: ${entry.logPath}`);
      lines.push('Output was shortened for inline display.');
    }
    if (output.oversized && output.originalByteLength !== undefined) {
      lines.push(`Original log size: ${output.originalByteLength} bytes.`);
    } else if (output.truncation?.footerNotes?.length) {
      lines.push(...output.truncation.footerNotes);
    }
    if (!output.capturedOutputWasEmpty && !output.capturedOutputEndedWithLf) {
      lines.push('Original command output had no trailing newline.');
    }
    if (output.hasDisplayByteConversions) lines.push(formatDisplayByteConversionDisclaimer('command output'));
    return lines.join('\n');
  }

  private async buildLiveProcessTree(entry: RunningExecEntry): Promise<string> {
    if (entry.backend || entry.pid === undefined) return '';
    try {
      const entries = await this.nativeBackend.inspectSnapshot();
      return formatProcessTreeSnapshot(entries, entry.pid);
    } catch (err) {
      this.options.logger?.warn?.({ err, execId: entry.id, pid: entry.pid }, 'Failed to inspect background exec process tree');
      return `Process tree (best-effort live snapshot; managed shell-script root PID ${entry.pid}):\n(Process tree unavailable: process inspection failed or is unsupported on this platform.)`;
    }
  }

  private backend(entry: RunningExecEntry): ExecBackend {
    if (!entry.backend) return this.nativeBackend;
    const backend = this.options.resolveBackend?.(entry.backend.providerId, entry.nodeId);
    if (!backend) throw new Error('The configured exec backend is unavailable.');
    return backend;
  }

  private inspectStatus(entry: RunningExecEntry): Promise<ExecStatus | null> {
    if (!entry.backend) return this.nativeBackend.poll(entry);
    const pending = this.pendingStatus.get(entry.id);
    if (pending) return pending;
    const query = Promise.resolve().then(() => this.backend(entry).poll(entry)).catch(err => {
      this.options.logger?.warn?.({ err, execId: entry.id }, 'Failed to inspect exec status; tracking retained');
      return null;
    }).finally(() => { this.pendingStatus.delete(entry.id); });
    this.pendingStatus.set(entry.id, query);
    return query;
  }

  async waitForExecCompletion(execId: string, timeoutMs: number, signal?: AbortSignal): Promise<ExecStatus | null> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const entry = this.runningExecs.get(execId);
      if (!entry) return null;
      // Native status reads retain their existing status-before-Stop precedence.
      if (!entry.backend) {
        const status = await this.inspectStatus(entry);
        if (status) return status;
        if (signal?.aborted) return null;
        await sleep(Math.min(STATUS_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal);
        continue;
      }
      // A slow read-only provider query must not hold a foreground wait past Stop or its deadline.
      const status = await Promise.race([
        this.inspectStatus(entry),
        sleep(Math.min(STATUS_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal).then(() => null),
      ]);
      if (status) return status;
      if (signal?.aborted) return null;
      await sleep(Math.min(STATUS_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), signal);
    }
    return null;
  }

  getRunningExec(execId: string): RunningExecEntry | undefined { return this.runningExecs.get(execId); }
  hasRunningExecs(): boolean { return this.runningExecs.size > 0; }

  async markExecForBackgroundNotification(execId: string): Promise<RunningExecEntry | null> {
    return await this.updateRunningExec(execId, { notifyOnCompletion: true });
  }

  async finalizeForegroundExec(execId: string): Promise<void> {
    await this.removeRunningExec(execId);
  }

  /** Read only the retained byte snapshot; display footers are never treated as capture data. */
  async buildProgrammaticExecResult(entry: RunningExecEntry, status: ExecStatus | null, output: string): Promise<ProgrammaticExecResult> {
    const metadata = {
      output, status: status ? 'completed' as const : 'running' as const,
      ...(status ? { exitCode: status.exitCode } : {}), execId: entry.id, logPath: entry.logPath,
    };
    try {
      const stat = await this.backend(entry).files.stat(entry.logPath);
      if (stat.size > MAX_FULL_LOG_READ_BYTES) return { ...metadata, truncated: true, sizeBytes: stat.size };
      const bytes = await this.backend(entry).files.read(entry.logPath, 0, stat.size);
      if (bytes.length !== stat.size) return { ...metadata, truncated: true, sizeBytes: stat.size };
      return { ...metadata, content: bytes.toString('utf8'), truncated: false, sizeBytes: bytes.length };
    } catch (error: any) {
      if (!entry.backend && error?.code !== 'ENOENT') throw error;
      return { ...metadata, truncated: true };
    }
  }

  async buildForegroundExecResult(entry: RunningExecEntry, status: ExecStatus, warning?: string): Promise<string> {
    const output = await this.readDisplayOutput(entry);
    const footerSeparator = output.text.endsWith('\n') ? '' : '\n';
    return `${output.text}${footerSeparator}${this.buildForegroundFooter(entry, status, output, warning)}`;
  }

  async buildBackgroundTimeoutResult(entry: RunningExecEntry, timeoutSeconds: number = DEFAULT_EXEC_TIMEOUT_SECONDS, warning?: string, waitEndedBy?: string): Promise<string> {
    const partialOutput = await this.readPartialLog(entry);
    const fullNotice = waitEndedBy
      ? `${waitEndedBy} ended this call's wait. The command was already started and was not killed; it may still be running in the background. Completion will be reported separately.`
      : buildBackgroundTimeoutFullNotice(timeoutSeconds);
    const processTree = await this.buildLiveProcessTree(entry);
    const pidLine = entry.pid === undefined ? '' : `PID: ${entry.pid}\n`;
    const nodeLine = entry.nodeId && entry.nodeId !== 'master' ? `Node: \`${entry.nodeId}\`\n` : '';
    const warningLine = warning ? `${warning}\n` : '';
    const sizeLine = partialOutput.oversized && partialOutput.originalByteLength !== undefined
      ? `\nOriginal log size: ${partialOutput.originalByteLength} bytes.`
      : '';
    const conversionNote = partialOutput.hasDisplayByteConversions
      ? `\n${formatDisplayByteConversionDisclaimer('command output')}`
      : '';
    const footerSeparator = partialOutput.text.endsWith('\n') ? '' : '\n';
    const trailingNewlineLine = !partialOutput.capturedOutputWasEmpty && !partialOutput.capturedOutputEndedWithLf
      ? 'Partial output captured so far had no trailing newline.\n'
      : '';
    const elapsed = formatExecDuration((this.options.now?.() ?? Date.now()) - entry.startedAt);
    return `Partial Output:\n${partialOutput.text}${footerSeparator}---\n${fullNotice}\n${trailingNewlineLine}${warningLine}execId: ${entry.id}\nElapsed: ${elapsed ?? 'unknown'}\n${nodeLine}${pidLine}${processTree ? `${processTree}\n` : ''}Log file: ${entry.logPath}${sizeLine}${conversionNote}`;
  }

  buildCompletionMessage(entry: RunningExecEntry, status: ExecStatus): string {
    const exitText = status.exitCode === null ? 'unknown' : String(status.exitCode);
    const nodeLine = entry.nodeId && entry.nodeId !== 'master' ? `\nNode: \`${entry.nodeId}\`` : '';
    const errorLine = status.error ? `\nError: ${status.error}` : '';
    return `Background Process Finished\nexecId: ${entry.id}\ncommand: \`${escapeInlineCode(summarizeCommandForNotification(entry.command))}\`${nodeLine}\nExit code: ${exitText}\n${formatCompletedExecDuration(entry, status)}${errorLine}\nCommand output in ${entry.logPath}`;
  }

  async readFinishedExecWorkingDirectory(entry: RunningExecEntry): Promise<string | null> {
    return this.backend(entry).readFinishedWorkingDirectory(entry);
  }

  async readLiveExecWorkingDirectory(entry: RunningExecEntry): Promise<string | null> {
    return this.backend(entry).readLiveWorkingDirectory(entry);
  }

  listRunningExecs(): RunningExecEntry[] {
    return Array.from(this.runningExecs.values());
  }

  private async reconcileRunningExecs(): Promise<void> {
    await Promise.all(Array.from(this.runningExecs.values()).map(async entry => {
      if (!entry.notifyOnCompletion) return;
      if ((this.options.now?.() ?? Date.now()) - entry.startedAt > BACKGROUND_COMPLETION_EVENT_RETENTION_MS) {
        try {
          this.options.onTrackingExpired?.(entry);
          await this.removeRunningExec(entry.id);
          this.options.logger?.info?.({ execId: entry.id, pid: entry.pid, sessionId: entry.sessionId }, 'Removed expired background exec tracking record');
        } catch (err) {
          this.options.logger?.warn?.({ err, execId: entry.id, sessionId: entry.sessionId }, 'Failed to remove expired background exec tracking record; will retry');
        }
        return;
      }
      let status: ExecStatus | null = null;
      try {
        status = await this.inspectStatus(entry);
      } catch (err) {
        this.options.logger?.error?.({ err, execId: entry.id, statusPath: entry.statusPath }, 'Failed to inspect exec status');
        return;
      }
      if (!status) return;
      const message = this.buildCompletionMessage(entry, status);
      try {
        await this.completionDispatcher(entry, status, message);
        await this.removeRunningExec(entry.id);
        this.options.logger?.info?.({ execId: entry.id, pid: entry.pid, sessionId: entry.sessionId }, 'Delivered background exec completion');
      } catch (err) {
        this.options.logger?.warn?.({ err, execId: entry.id, sessionId: entry.sessionId }, 'Failed to deliver background exec completion; will retry');
      }
    }));
  }
}
