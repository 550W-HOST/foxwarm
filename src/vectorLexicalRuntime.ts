import crypto from 'crypto';
import fs from 'fs-extra';
import { promises as nodeFs } from 'fs';
import path from 'path';
import { logger } from './common';
import { DB_DIR, VECTOR_HYBRID_SEARCH_ENABLED, VECTOR_LEXICAL_INDEX_ENABLED } from './config';
import {
  ArchiveSearchIndex,
  type ArchiveSearchDocumentInput,
} from './archiveSearchIndex';
import {
  getLocalArchiveVectorMaximaSync,
  getSessionBranch,
  hasArchivedSessionId,
  listLocalArchiveSessionMaxima,
  readLocalArchiveBlockBatch,
  readLocalArchiveMessageBatch,
  resolveArchiveSessionIdReadOnly,
} from './session/archiveStore';
import type { ArchiveBlockRecord } from './session/layeredContext';
import { formatSubstantiveMessageSearchText } from './utils/messageFormat';
import type { SearchOptions } from './vectorRuntime';
import type { LexicalFusionHit } from './vectorHybridFusion';

const RAW_BATCH_SIZE = 500;
const BLOCK_BATCH_SIZE = 100;
const RAW_FLUSH_THRESHOLD = 50;
const MAX_LATENCY_MS = 5 * 60_000;
const DB_PATH = path.join(DB_DIR, 'archive-search.sqlite');
const NEXT_DB_PATH = `${DB_PATH}.next`;
const BACKUP_DB_PATH = `${DB_PATH}.bak`;
const REBUILD_HEADROOM_BYTES = 64 * 1024 * 1024;

type TimerHandle = ReturnType<typeof setTimeout> & { unref?: () => void };
type BatchState = {
  latestSeqHint: number;
  latestBlockIdHint: number;
  forceSeqTarget: number;
  forceBlockTarget: number;
  forceRetryBlocked: boolean;
  deadline?: number;
  timer?: TimerHandle;
  active?: Promise<void>;
};

export type VectorLexicalStatus = {
  configured: boolean;
  ready: boolean;
  backfilling: boolean;
  rebuilding: boolean;
  generation?: string;
  rawLastIndexedSeq: number;
  lastIndexedBlockId: number;
  latestLocalMessageSeq: number;
  latestLocalBlockId: number;
  pendingMessageCount: number;
  pendingBlockCount: number;
  maxLatencyDeadline?: number;
  lastErrorCode?: string;
  lastErrorAt?: number;
};

export type VectorLexicalQueryMetadata = {
  configured: boolean;
  ready: boolean;
  used: boolean;
  coverageComplete: boolean;
  backfilling: boolean;
  errorCode?: string;
};

export type VectorLexicalQueryResult = {
  hits: LexicalFusionHit[];
  metadata: VectorLexicalQueryMetadata;
};

let lexicalIndex: ArchiveSearchIndex | undefined;
let ready = false;
let backfilling = false;
let rebuilding = false;
let generation: string | undefined;
let shuttingDown = false;
let startupPromise: Promise<void> | undefined;
let writerChain: Promise<void> = Promise.resolve();
let lastErrorCode: string | undefined;
let lastErrorAt: number | undefined;
const batchStates = new Map<string, BatchState>();
const pendingResetSessions = new Set<string>();
const pendingResetEstablished = new Map<string, { promise: Promise<void>; resolve: () => void }>();
let now = () => Date.now();
let setTimer = (callback: () => void, delayMs: number): TimerHandle => setTimeout(callback, delayMs);
let clearTimer = (handle: TimerHandle): void => clearTimeout(handle);
let yieldControl = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)); };
let beforeQuery: (() => void) | undefined;
let afterCoveragePre: (() => void | Promise<void>) | undefined;
let afterFtsQuery: (() => void | Promise<void>) | undefined;
let getFreeBytes = async (): Promise<number> => {
  const stats = await nodeFs.statfs(DB_DIR);
  return Number(stats.bavail) * Number(stats.bsize);
};
let beforePromotionValidation: (() => void | Promise<void>) | undefined;
let beforeLifecycleMutation: (() => void) | undefined;

function errorCode(error: unknown, fallback: string): string {
  const candidate = error as any;
  const code = typeof candidate?.code === 'string' ? candidate.code : fallback;
  return code.slice(0, 96);
}

function isRebuildableDerivedDbError(error: unknown): boolean {
  const code = errorCode(error, '');
  if (code === 'ARCHIVE_SEARCH_REBUILD_REQUIRED') return true;
  if (code !== 'ERR_SQLITE_ERROR') return false;
  const message = String((error as any)?.message || '').toLowerCase();
  return /not a database|file is not a database|database disk image is malformed|malformed database schema|database schema is corrupt/.test(message);
}

function recordError(error: unknown, fallback: string): void {
  lastErrorCode = errorCode(error, fallback);
  lastErrorAt = now();
}

async function removeDbFamily(filePath: string): Promise<void> {
  await Promise.all([filePath, `${filePath}-wal`, `${filePath}-shm`].map(candidate => fs.remove(candidate)));
}

async function removeDbSidecars(filePath: string): Promise<void> {
  await Promise.all([`${filePath}-wal`, `${filePath}-shm`].map(candidate => fs.remove(candidate)));
}

async function syncDbDirectory(): Promise<void> {
  const handle = await nodeFs.open(DB_DIR, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function reconcileDerivedAliases(index: ArchiveSearchIndex): Promise<void> {
  for (const storedId of index.listSessionIds()) {
    const canonicalId = resolveArchiveSessionIdReadOnly(storedId);
    if (canonicalId === storedId) continue;
    try {
      const result = index.renameSessionDerived(storedId, canonicalId);
      if (result === 'conflict') {
        index.deleteDocuments(storedId);
        index.resetSessionDerived(canonicalId, 0, 0);
        recordError({ code: 'LEXICAL_RECONCILE_CONFLICT' }, 'LEXICAL_RECONCILE_CONFLICT');
      }
    } catch (error) {
      try { index.deleteDocuments(storedId); index.resetSessionDerived(canonicalId, 0, 0); } catch {}
      recordError(error, 'LEXICAL_RECONCILE_FAILED');
    }
  }
}

function getPendingResetEstablishment(sessionId: string): { promise: Promise<void>; resolve: () => void } {
  let pending = pendingResetEstablished.get(sessionId);
  if (!pending) {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    pending = { promise, resolve };
    pendingResetEstablished.set(sessionId, pending);
  }
  return pending;
}

async function applyPendingResets(index: ArchiveSearchIndex): Promise<void> {
  for (const sessionId of pendingResetSessions) {
    index.deleteDocuments(sessionId);
    pendingResetEstablished.get(sessionId)?.resolve();
  }
  for (const sessionId of [...pendingResetSessions]) {
    if (await hasArchivedSessionId(sessionId)) {
      pendingResetSessions.delete(sessionId);
      pendingResetEstablished.delete(sessionId);
    }
  }
}

async function pruneUnreservedDerivedSessions(index: ArchiveSearchIndex): Promise<void> {
  for (const sessionId of index.listSessionIds()) {
    if (!await hasArchivedSessionId(sessionId)) index.deleteDocuments(sessionId);
  }
}

async function runShadowCatchup(index: ArchiveSearchIndex): Promise<void> {
  while (!shuttingDown) {
    await applyPendingResets(index);
    const maxima = await listLocalArchiveSessionMaxima();
    for (const entry of maxima) {
      if (shuttingDown) break;
      await enqueueIndex(entry.sessionId, false, undefined, undefined, true);
      await applyPendingResets(index);
      await yieldControl();
    }
    if (shuttingDown) return;
    await applyPendingResets(index);
    await pruneUnreservedDerivedSessions(index);
    const post = await listLocalArchiveSessionMaxima();
    if (post.every(entry => {
      const checkpoint = index.getCheckpoint(entry.sessionId);
      return checkpoint.rawLastIndexedSeq >= entry.latestLocalMessageSeq
        && checkpoint.lastIndexedBlockId >= entry.latestLocalBlockId;
    })) return;
  }
}

async function runShadowRebuild(): Promise<void> {
  rebuilding = true;
  backfilling = true;
  ready = false;
  try {
    const sizes = await Promise.all([DB_PATH, NEXT_DB_PATH, BACKUP_DB_PATH].map(async candidate => (
      await fs.pathExists(candidate) ? (await fs.stat(candidate)).size : 0
    )));
    const mainSize = Math.max(...sizes);
    const freeBytes = await getFreeBytes();
    if (!Number.isFinite(freeBytes) || freeBytes < mainSize + REBUILD_HEADROOM_BYTES) {
      recordError({ code: 'LEXICAL_REBUILD_SPACE' }, 'LEXICAL_REBUILD_SPACE');
      return;
    }
    let next: ArchiveSearchIndex;
    try {
      next = ArchiveSearchIndex.open(NEXT_DB_PATH);
    } catch (error) {
      if (!isRebuildableDerivedDbError(error)) throw error;
      await removeDbFamily(NEXT_DB_PATH);
      next = ArchiveSearchIndex.open(NEXT_DB_PATH);
    }
    lexicalIndex = next;
    generation = next.getGeneration();
    await runShadowCatchup(next);
    if (shuttingDown) {
      next.close();
      lexicalIndex = undefined;
      return;
    }
    next.close();
    lexicalIndex = undefined;
    const pendingValidated = ArchiveSearchIndex.open(NEXT_DB_PATH);
    await applyPendingResets(pendingValidated);
    await pruneUnreservedDerivedSessions(pendingValidated);
    pendingValidated.close();
    const validatedNext = ArchiveSearchIndex.open(NEXT_DB_PATH);
    generation = validatedNext.getGeneration();
    validatedNext.close();
    if (await fs.pathExists(DB_PATH)) {
      await removeDbFamily(BACKUP_DB_PATH);
      await removeDbSidecars(DB_PATH);
      await fs.rename(DB_PATH, BACKUP_DB_PATH);
    }
    await fs.rename(NEXT_DB_PATH, DB_PATH);
    await syncDbDirectory();
    let promoted: ArchiveSearchIndex | undefined;
    try {
      await beforePromotionValidation?.();
      promoted = ArchiveSearchIndex.open(DB_PATH);
      lastErrorCode = undefined;
      lastErrorAt = undefined;
      await reconcileDerivedAliases(promoted);
      await applyPendingResets(promoted);
      await pruneUnreservedDerivedSessions(promoted);
    } catch (error) {
      try { promoted?.close(); } catch {}
      await removeDbFamily(NEXT_DB_PATH);
      if (await fs.pathExists(DB_PATH)) await fs.rename(DB_PATH, NEXT_DB_PATH);
      if (await fs.pathExists(BACKUP_DB_PATH)) await fs.rename(BACKUP_DB_PATH, DB_PATH);
      await syncDbDirectory();
      recordError({ code: 'LEXICAL_REBUILD_PROMOTION_FAILED' }, 'LEXICAL_REBUILD_PROMOTION_FAILED');
      try {
        const resumable = ArchiveSearchIndex.open(NEXT_DB_PATH);
        await applyPendingResets(resumable);
        await pruneUnreservedDerivedSessions(resumable);
        resumable.close();
      } catch {}
      return;
    }
    lexicalIndex = promoted;
    generation = promoted.getGeneration();
    await runShadowCatchup(promoted);
    await applyPendingResets(promoted);
    await pruneUnreservedDerivedSessions(promoted);
    ready = true;
    for (const sessionId of pendingResetSessions) pendingResetEstablished.get(sessionId)?.resolve();
    pendingResetSessions.clear();
    pendingResetEstablished.clear();
    try {
      await removeDbFamily(BACKUP_DB_PATH);
      await removeDbFamily(NEXT_DB_PATH);
    } catch (error) {
      recordError(error, 'LEXICAL_REBUILD_CLEANUP_FAILED');
    }
    await runStartupBackfill();
  } catch (error) {
    recordError(error, 'LEXICAL_REBUILD_FAILED');
  } finally {
    rebuilding = false;
    backfilling = false;
    if (!ready) {
      for (const pending of pendingResetEstablished.values()) pending.resolve();
    }
  }
}

async function openOrRecover(): Promise<void> {
  if (!await fs.pathExists(DB_PATH) && await fs.pathExists(NEXT_DB_PATH)) {
    startupPromise = runShadowRebuild();
    return;
  }
  if (!await fs.pathExists(DB_PATH) && await fs.pathExists(BACKUP_DB_PATH) && !await fs.pathExists(NEXT_DB_PATH)) {
    await fs.rename(BACKUP_DB_PATH, DB_PATH);
    await syncDbDirectory();
  }
  try {
    lexicalIndex = ArchiveSearchIndex.open(DB_PATH);
    lastErrorCode = undefined;
    lastErrorAt = undefined;
    await reconcileDerivedAliases(lexicalIndex);
    generation = lexicalIndex.getGeneration();
    ready = true;
    await removeDbFamily(NEXT_DB_PATH);
    await removeDbFamily(BACKUP_DB_PATH);
  } catch (error) {
    if (!isRebuildableDerivedDbError(error) && await fs.pathExists(DB_PATH)) throw error;
    recordError(error, 'ARCHIVE_SEARCH_REBUILD_REQUIRED');
    startupPromise = runShadowRebuild();
  }
}

async function resetPersistedDerivedIdentities(sessionIds: string[]): Promise<void> {
  if (!VECTOR_LEXICAL_INDEX_ENABLED || !await fs.pathExists(DB_PATH)) return;
  let index: ArchiveSearchIndex | undefined;
  try {
    index = ArchiveSearchIndex.open(DB_PATH);
    for (const sessionId of new Set(sessionIds.filter(Boolean))) index.deleteDocuments(sessionId);
  } catch (error) {
    recordError(error, 'LEXICAL_PREINIT_RESET_FAILED');
  } finally {
    try { index?.close(); } catch {}
  }
}

function cancelDeadline(state: BatchState): void {
  if (state.timer) clearTimer(state.timer);
  state.timer = undefined;
  state.deadline = undefined;
}

function getState(sessionId: string): BatchState {
  let state = batchStates.get(sessionId);
  if (!state) {
    const checkpoint = lexicalIndex?.getCheckpoint(sessionId);
    state = {
      latestSeqHint: checkpoint?.rawLastIndexedSeq || 0,
      latestBlockIdHint: checkpoint?.lastIndexedBlockId || 0,
      forceSeqTarget: 0,
      forceBlockTarget: 0,
      forceRetryBlocked: false,
    };
    batchStates.set(sessionId, state);
  }
  return state;
}

function rawDocument(record: Awaited<ReturnType<typeof readLocalArchiveMessageBatch>>[number], text: string): ArchiveSearchDocumentInput {
  return {
    sessionId: record.sessionId,
    agent: record.agent,
    memoryKind: 'raw',
    sourceKey: String(record.seq),
    sourceFamily: `${record.sessionId}:raw:${record.seq}-${record.seq}`,
    text,
    seq: record.seq,
    startSeq: record.seq,
    endSeq: record.seq,
    rawStartSeq: record.seq,
    rawEndSeq: record.seq,
    timestamp: record.timestamp,
  };
}

function blockDocuments(record: ArchiveBlockRecord): { block: ArchiveSearchDocumentInput; facts: ArchiveSearchDocumentInput[] } {
  const family = `${record.sessionId}:block:${record.id}`;
  const common = {
    sessionId: record.sessionId,
    agent: record.agent,
    sourceFamily: family,
    startSeq: record.sourceStart,
    endSeq: record.sourceEnd,
    rawStartSeq: record.rawStartSeq,
    rawEndSeq: record.rawEndSeq,
    timestamp: record.createdAt,
    blockId: record.id,
    blockLevel: record.level,
  };
  const block: ArchiveSearchDocumentInput = {
    ...common,
    memoryKind: 'block',
    sourceKey: String(record.id),
    text: record.summary,
  };
  const facts = (record.memoryFacts || []).map((fact, index): ArchiveSearchDocumentInput => {
    const factText = [fact.text.trim(), fact.context?.trim(), fact.attributedTo ? `Attribution: ${fact.attributedTo}` : '']
      .filter(Boolean).join('\n');
    const hash = crypto.createHash('sha256').update(`${fact.kind}\0${factText.toLowerCase()}`).digest('hex').slice(0, 24);
    return {
      ...common,
      memoryKind: 'fact',
      sourceKey: `${record.id}:${hash}:${index}`,
      text: `Memory fact (${fact.kind})\n${factText}`,
    };
  });
  return { block, facts };
}

async function indexSession(sessionId: string, allowDuringShutdown = false, targetSeq?: number, targetBlockId?: number, allowUnavailable = false): Promise<void> {
  const index = lexicalIndex;
  if (!index || (!ready && !allowUnavailable) || (shuttingDown && !allowDuringShutdown)) return;
  let checkpoint = index.getCheckpoint(sessionId);
  while (!shuttingDown || allowDuringShutdown) {
    const loaded = await readLocalArchiveMessageBatch(sessionId, checkpoint.rawLastIndexedSeq, RAW_BATCH_SIZE);
    if (loaded.some(row => row.sessionId !== sessionId)) break;
    const rows = targetSeq === undefined ? loaded : loaded.filter(row => row.seq <= targetSeq);
    if (rows.length === 0) break;
    const documents: ArchiveSearchDocumentInput[] = [];
    for (const row of rows) {
      const text = formatSubstantiveMessageSearchText(row.message);
      if (text) documents.push(rawDocument(row, text));
    }
    index.upsertRawDocuments(sessionId, documents, rows[rows.length - 1].seq);
    checkpoint = index.getCheckpoint(sessionId);
    await yieldControl();
  }
  while (!shuttingDown || allowDuringShutdown) {
    const loaded = await readLocalArchiveBlockBatch(sessionId, checkpoint.lastIndexedBlockId, BLOCK_BATCH_SIZE);
    if (loaded.some(row => row.sessionId !== sessionId)) break;
    const rows = targetBlockId === undefined ? loaded : loaded.filter(row => row.id <= targetBlockId);
    if (rows.length === 0) break;
    const entries = rows.map(blockDocuments);
    index.replaceBlockDocumentBatch(sessionId, entries, rows[rows.length - 1].id);
    checkpoint = index.getCheckpoint(sessionId);
    await yieldControl();
  }
}

function enqueueIndex(sessionId: string, allowDuringShutdown = false, targetSeq?: number, targetBlockId?: number, allowUnavailable = false): Promise<void> {
  const run = writerChain.then(() => indexSession(sessionId, allowDuringShutdown, targetSeq, targetBlockId, allowUnavailable));
  writerChain = run.catch(() => {});
  return run;
}

function planAfterRun(sessionId: string): void {
  const index = lexicalIndex;
  const state = batchStates.get(sessionId);
  if (!index || !state || !ready || shuttingDown) return;
  const checkpoint = index.getCheckpoint(sessionId);
  const pendingRaw = Math.max(0, state.latestSeqHint - checkpoint.rawLastIndexedSeq);
  const pendingBlocks = Math.max(0, state.latestBlockIdHint - checkpoint.lastIndexedBlockId);
  const forcedRaw = Math.max(0, state.forceSeqTarget - checkpoint.rawLastIndexedSeq);
  const forcedBlocks = Math.max(0, state.forceBlockTarget - checkpoint.lastIndexedBlockId);
  if (forcedRaw > 0 || forcedBlocks > 0) {
    if (state.forceRetryBlocked) armDeadline(sessionId, state);
    else void startRun(sessionId);
    return;
  }
  if (pendingBlocks > 0 || pendingRaw >= RAW_FLUSH_THRESHOLD) {
    void startRun(sessionId);
  } else if (pendingRaw > 0) {
    armDeadline(sessionId, state);
  } else {
    cancelDeadline(state);
  }
}

async function startRun(sessionId: string): Promise<void> {
  const state = getState(sessionId);
  if (state.active || !ready || shuttingDown) return state.active;
  cancelDeadline(state);
  const checkpoint = lexicalIndex!.getCheckpoint(sessionId);
  const hasForcedTarget = !state.forceRetryBlocked && (
    state.forceSeqTarget > checkpoint.rawLastIndexedSeq || state.forceBlockTarget > checkpoint.lastIndexedBlockId
  );
  const targetSeq = hasForcedTarget ? state.forceSeqTarget : state.latestSeqHint;
  const targetBlockId = hasForcedTarget ? state.forceBlockTarget : state.latestBlockIdHint;
  const active = enqueueIndex(sessionId, false, targetSeq, targetBlockId)
    .catch(error => {
      if (hasForcedTarget) state.forceRetryBlocked = true;
      recordError(error, 'LEXICAL_INDEX_FAILED');
      logger.warn({ code: lastErrorCode, sessionId }, 'Dark lexical archive indexing failed');
    })
    .finally(() => {
      if (state.active === active) state.active = undefined;
      planAfterRun(sessionId);
    });
  state.active = active;
  return active;
}

function armDeadline(sessionId: string, state: BatchState): void {
  if (state.timer || !ready || shuttingDown) return;
  state.deadline = now() + MAX_LATENCY_MS;
  const expected = state.deadline;
  state.timer = setTimer(() => {
    if (state.deadline !== expected || shuttingDown) return;
    state.timer = undefined;
    state.deadline = undefined;
    if (state.forceRetryBlocked) {
      state.forceSeqTarget = Math.max(state.forceSeqTarget, state.latestSeqHint);
      state.forceBlockTarget = Math.max(state.forceBlockTarget, state.latestBlockIdHint);
    }
    state.forceRetryBlocked = false;
    void startRun(sessionId);
  }, MAX_LATENCY_MS);
  state.timer.unref?.();
}

async function runStartupBackfill(): Promise<void> {
  backfilling = true;
  try {
    const candidates = await listLocalArchiveSessionMaxima();
    for (const candidate of candidates) {
      if (shuttingDown || !ready) break;
      try {
        const checkpoint = lexicalIndex!.getCheckpoint(candidate.sessionId);
        if (candidate.latestLocalMessageSeq > checkpoint.rawLastIndexedSeq
          || candidate.latestLocalBlockId > checkpoint.lastIndexedBlockId) {
          await enqueueIndex(candidate.sessionId);
        }
      } catch (error) {
        recordError(error, 'LEXICAL_BACKFILL_SESSION_FAILED');
        logger.warn({ code: lastErrorCode, sessionId: candidate.sessionId }, 'Dark lexical startup Session backfill failed');
      }
      await yieldControl();
    }
  } catch (error) {
    recordError(error, 'LEXICAL_BACKFILL_FAILED');
    logger.warn({ code: lastErrorCode }, 'Dark lexical startup backfill failed');
  } finally {
    backfilling = false;
  }
}

export async function init(): Promise<void> {
  if (!VECTOR_LEXICAL_INDEX_ENABLED || lexicalIndex) return;
  shuttingDown = false;
  try {
    await openOrRecover();
    if (ready) {
      startupPromise = runStartupBackfill();
    }
  } catch (error) {
    ready = false;
    recordError(error, 'LEXICAL_OPEN_FAILED');
    logger.warn({ code: lastErrorCode }, 'Dark lexical index unavailable; dense Vector remains ready');
  }
}

export function schedule(sessionId: string, latestSeqHint?: number, latestBlockIdHint?: number): void {
  if (!ready || shuttingDown) return;
  try {
    const state = getState(sessionId);
    if (latestSeqHint !== undefined) state.latestSeqHint = Math.max(state.latestSeqHint, latestSeqHint);
    if (latestBlockIdHint !== undefined) state.latestBlockIdHint = Math.max(state.latestBlockIdHint, latestBlockIdHint);
    planAfterRun(sessionId);
  } catch (error) {
    recordError(error, 'LEXICAL_SCHEDULE_FAILED');
    logger.warn({ code: lastErrorCode, sessionId }, 'Dark lexical schedule hint failed');
  }
}

export function force(sessionId: string, latestSeqHint?: number, latestBlockIdHint?: number): void {
  if (!ready || shuttingDown) return;
  try {
    const maxima = (latestSeqHint === undefined || latestBlockIdHint === undefined)
      ? getLocalArchiveVectorMaximaSync(sessionId)
      : undefined;
    const targetSeq = latestSeqHint ?? maxima!.latestLocalMessageSeq;
    const targetBlockId = latestBlockIdHint ?? maxima!.latestLocalBlockId;
    const state = getState(sessionId);
    state.latestSeqHint = Math.max(state.latestSeqHint, targetSeq);
    state.latestBlockIdHint = Math.max(state.latestBlockIdHint, targetBlockId);
    state.forceSeqTarget = Math.max(state.forceSeqTarget, targetSeq);
    state.forceBlockTarget = Math.max(state.forceBlockTarget, targetBlockId);
    state.forceRetryBlocked = false;
    void startRun(sessionId);
  } catch (error) {
    recordError(error, 'LEXICAL_FORCE_FAILED');
    logger.warn({ code: lastErrorCode, sessionId }, 'Dark lexical force hint failed');
  }
}

export function getStatus(sessionId: string): VectorLexicalStatus {
  const maxima = getLocalArchiveVectorMaximaSync(sessionId);
  let checkpoint = { rawLastIndexedSeq: 0, lastIndexedBlockId: 0, updatedAt: 0 };
  try {
    checkpoint = lexicalIndex?.getCheckpoint(sessionId) || checkpoint;
  } catch (error) {
    recordError(error, 'LEXICAL_STATUS_FAILED');
  }
  const state = batchStates.get(sessionId);
  return {
    configured: VECTOR_LEXICAL_INDEX_ENABLED,
    ready,
    backfilling,
    rebuilding,
    ...(generation ? { generation } : {}),
    rawLastIndexedSeq: checkpoint.rawLastIndexedSeq,
    lastIndexedBlockId: checkpoint.lastIndexedBlockId,
    latestLocalMessageSeq: maxima.latestLocalMessageSeq,
    latestLocalBlockId: maxima.latestLocalBlockId,
    pendingMessageCount: Math.max(0, maxima.latestLocalMessageSeq - checkpoint.rawLastIndexedSeq),
    pendingBlockCount: Math.max(0, maxima.latestLocalBlockId - checkpoint.lastIndexedBlockId),
    ...(state?.deadline ? { maxLatencyDeadline: state.deadline } : {}),
    ...(lastErrorCode ? { lastErrorCode } : {}),
    ...(lastErrorAt ? { lastErrorAt } : {}),
  };
}

function mapQueryHit(result: import('./archiveSearchIndex').ArchiveSearchQueryResult): LexicalFusionHit {
  const isRaw = result.memoryKind === 'raw';
  return {
    id: `fts:${result.memoryKind}:${result.sessionId}:${result.sourceKey}`,
    kind: isRaw ? 'raw' : 'block',
    session_id: result.sessionId,
    agent: result.agent,
    source_family: result.sourceFamily,
    lexical_lane: result.lane,
    lexical_rank: Math.max(0, result.rank - 1),
    lexical_score: Math.max(1, 1000 - result.rank),
    ...(isRaw ? {
      start_seq: result.startSeq ?? result.seq,
      end_seq: result.endSeq ?? result.seq,
      raw_start_seq: result.rawStartSeq ?? result.seq,
      raw_end_seq: result.rawEndSeq ?? result.seq,
    } : {
      block_id: result.blockId,
      block_level: result.blockLevel,
      raw_start_seq: result.rawStartSeq,
      raw_end_seq: result.rawEndSeq,
    }),
  };
}

type CoverageSnapshot = {
  complete: boolean;
  exact: boolean;
  authoritySignature: string;
  entries: Array<{
    sessionId: string;
    maxMessageSeq?: number;
    maxBlockId?: number;
    latestLocalMessageSeq: number;
    latestLocalBlockId: number;
    requiredMessageSeq: number;
    requiredBlockId: number;
    lexicalMessageSeq: number;
    lexicalBlockId: number;
    archiveExists: boolean;
  }>;
};

async function coverageSnapshotForOptions(options?: SearchOptions): Promise<CoverageSnapshot> {
  const index = lexicalIndex!;
  if (options?.lineageSessions?.length || options?.sessionIds?.length) {
    const entries: Array<{ sessionId: string; maxMessageSeq?: number; maxBlockId?: number }> = options.lineageSessions?.length
      ? options.lineageSessions
      : (options.sessionIds || []).map(sessionId => ({ sessionId }));
    const snapshotEntries = await Promise.all(entries.slice(0, 64).map(async entry => {
      const maxima = getLocalArchiveVectorMaximaSync(entry.sessionId);
      const requiredSeq = entry.maxMessageSeq === undefined ? maxima.latestLocalMessageSeq : Math.min(maxima.latestLocalMessageSeq, entry.maxMessageSeq);
      const requiredBlock = entry.maxBlockId === undefined ? maxima.latestLocalBlockId : Math.min(maxima.latestLocalBlockId, entry.maxBlockId);
      const checkpoint = index.getCheckpoint(entry.sessionId);
      return {
        sessionId: entry.sessionId,
        maxMessageSeq: entry.maxMessageSeq,
        maxBlockId: entry.maxBlockId,
        latestLocalMessageSeq: maxima.latestLocalMessageSeq,
        latestLocalBlockId: maxima.latestLocalBlockId,
        requiredMessageSeq: requiredSeq,
        requiredBlockId: requiredBlock,
        lexicalMessageSeq: checkpoint.rawLastIndexedSeq,
        lexicalBlockId: checkpoint.lastIndexedBlockId,
        archiveExists: await hasArchivedSessionId(entry.sessionId),
      };
    }));
    const authoritySignature = JSON.stringify(snapshotEntries.map(entry => [
      entry.sessionId, entry.maxMessageSeq ?? null, entry.maxBlockId ?? null,
      entry.requiredMessageSeq, entry.requiredBlockId, entry.archiveExists,
    ]));
    return {
      complete: entries.length <= 64 && snapshotEntries.every(entry => entry.archiveExists && (
        entry.lexicalMessageSeq >= entry.requiredMessageSeq && entry.lexicalBlockId >= entry.requiredBlockId
      )),
      exact: true,
      authoritySignature,
      entries: snapshotEntries,
    };
  }
  const maxima = (await listLocalArchiveSessionMaxima()).filter(entry => !options?.agent || entry.agent === options.agent);
  const snapshotEntries = maxima.slice(0, 64).map(entry => {
    const checkpoint = index.getCheckpoint(entry.sessionId);
    return {
      sessionId: entry.sessionId,
      latestLocalMessageSeq: entry.latestLocalMessageSeq,
      latestLocalBlockId: entry.latestLocalBlockId,
      requiredMessageSeq: entry.latestLocalMessageSeq,
      requiredBlockId: entry.latestLocalBlockId,
      lexicalMessageSeq: checkpoint.rawLastIndexedSeq,
      lexicalBlockId: checkpoint.lastIndexedBlockId,
      archiveExists: true,
    };
  });
  return {
    complete: maxima.length <= 64 && snapshotEntries.every(entry => (
      entry.lexicalMessageSeq >= entry.requiredMessageSeq && entry.lexicalBlockId >= entry.requiredBlockId
    )),
    exact: false,
    authoritySignature: '',
    entries: snapshotEntries,
  };
}

export async function query(queryText: string, limit: number, options?: SearchOptions): Promise<VectorLexicalQueryResult> {
  const base = {
    configured: VECTOR_HYBRID_SEARCH_ENABLED,
    ready,
    used: false,
    coverageComplete: false,
    backfilling,
  };
  if (!VECTOR_HYBRID_SEARCH_ENABLED || !ready || !lexicalIndex || shuttingDown) {
    return { hits: [], metadata: { ...base, ...(lastErrorCode ? { errorCode: lastErrorCode } : {}) } };
  }
  try {
    beforeQuery?.();
    const preCoverage = await coverageSnapshotForOptions(options);
    if (preCoverage.exact && (!preCoverage.complete || backfilling)) {
      return { hits: [], metadata: { ...base, coverageComplete: preCoverage.complete } };
    }
    await afterCoveragePre?.();
    const result = lexicalIndex.query(queryText, {
      sessionIds: options?.sessionIds,
      agent: options?.agent,
      lineageSessions: options?.lineageSessions,
    }, Math.max(20, Math.min(200, limit * 4)));
    await afterFtsQuery?.();
    const seen = new Set<string>();
    const hits: LexicalFusionHit[] = [];
    for (const row of [...result.identifier, ...result.prose]) {
      const hit = mapQueryHit(row);
      const key = `${hit.lexical_lane}:${hit.source_family}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(hit);
    }
    const postCoverage = preCoverage.exact ? await coverageSnapshotForOptions(options) : preCoverage;
    // Exact coverage is valid only across one stable Archive authority window.
    // Catch-up during FTS cannot retroactively make that query cover the append.
    const coverageComplete = postCoverage.complete
      && (!preCoverage.exact || preCoverage.authoritySignature === postCoverage.authoritySignature);
    return {
      hits,
      metadata: { ...base, used: hits.length > 0, coverageComplete },
    };
  } catch (error) {
    const code = errorCode(error, 'LEXICAL_QUERY_FAILED');
    return { hits: [], metadata: { ...base, errorCode: code } };
  }
}

export async function runMaintenance(): Promise<void> {
  if (!ready || !lexicalIndex || shuttingDown) return;
  try {
    lexicalIndex.checkpointWal();
    lexicalIndex.optimize(256);
  } catch (error) {
    recordError(error, 'LEXICAL_MAINTENANCE_FAILED');
    logger.warn({ code: lastErrorCode }, 'Dark lexical maintenance failed');
  }
}

async function runLifecycle(task: (index: ArchiveSearchIndex) => void): Promise<void> {
  if (!ready || !lexicalIndex || rebuilding || shuttingDown) {
    recordError({ code: 'LEXICAL_LIFECYCLE_UNAVAILABLE' }, 'LEXICAL_LIFECYCLE_UNAVAILABLE');
    return;
  }
  const run = writerChain.then(() => {
    if (!lexicalIndex || !ready) return;
    task(lexicalIndex);
  });
  writerChain = run.catch(() => {});
  try { await run; } catch (error) {
    ready = false;
    recordError(error, 'LEXICAL_LIFECYCLE_FAILED');
  }
}

export async function renameSession(oldSessionId: string, newSessionId: string): Promise<void> {
  if (!VECTOR_LEXICAL_INDEX_ENABLED) return;
  if (!lexicalIndex) {
    await resetPersistedDerivedIdentities([oldSessionId, newSessionId]);
    return;
  }
  for (const id of [oldSessionId, newSessionId]) {
    const state = batchStates.get(id);
    if (state) cancelDeadline(state);
  }
  let needsBackfill = false;
  await runLifecycle(index => {
    try {
      beforeLifecycleMutation?.();
      const result = index.renameSessionDerived(oldSessionId, newSessionId);
      if (result === 'conflict') {
        index.deleteDocuments(oldSessionId);
        index.resetSessionDerived(newSessionId, 0, 0);
        needsBackfill = true;
        recordError({ code: 'LEXICAL_RENAME_CONFLICT' }, 'LEXICAL_RENAME_CONFLICT');
      }
    } catch (error) {
      try { index.deleteDocuments(oldSessionId); index.resetSessionDerived(newSessionId, 0, 0); } catch {}
      needsBackfill = true;
      recordError(error, 'LEXICAL_RENAME_FAILED');
    }
  });
  const oldState = batchStates.get(oldSessionId);
  batchStates.delete(oldSessionId);
  if (oldState && !batchStates.has(newSessionId)) batchStates.set(newSessionId, oldState);
  if (needsBackfill || ready) force(newSessionId);
}

export async function resetSessionDerived(sessionId: string): Promise<void> {
  if (!VECTOR_LEXICAL_INDEX_ENABLED) return;
  const state = batchStates.get(sessionId);
  if (state) cancelDeadline(state);
  if (!lexicalIndex) {
    if (rebuilding) {
      pendingResetSessions.add(sessionId);
      await getPendingResetEstablishment(sessionId).promise;
      return;
    }
    await resetPersistedDerivedIdentities([sessionId]);
    return;
  }
  if (rebuilding) {
    pendingResetSessions.add(sessionId);
    const established = getPendingResetEstablishment(sessionId);
    const run = writerChain.then(() => {
      if (lexicalIndex) {
        lexicalIndex.deleteDocuments(sessionId);
        established.resolve();
      }
    });
    writerChain = run.catch(() => {});
    try { await run; } catch (error) { recordError(error, 'LEXICAL_RESET_FAILED'); established.resolve(); }
    await established.promise;
    return;
  }
  await runLifecycle(index => {
    try { index.deleteDocuments(sessionId); }
    catch (error) { ready = false; recordError(error, 'LEXICAL_RESET_FAILED'); }
  });
  batchStates.delete(sessionId);
}

export async function initializeForkCheckpoint(targetSessionId: string): Promise<void> {
  if (!VECTOR_LEXICAL_INDEX_ENABLED) return;
  const state = batchStates.get(targetSessionId);
  if (state) cancelDeadline(state);
  let valid = false;
  try {
    const branch = await getSessionBranch(targetSessionId);
    valid = !!branch && branch.sessionId === resolveArchiveSessionIdReadOnly(targetSessionId) && !!branch.parentSessionId;
    await runLifecycle(index => {
      try {
        beforeLifecycleMutation?.();
        if (!valid || !branch) {
          index.deleteDocuments(targetSessionId);
          recordError({ code: 'LEXICAL_FORK_INVALID' }, 'LEXICAL_FORK_INVALID');
          return;
        }
        index.resetSessionDerived(targetSessionId, branch.forkMessageSeq, branch.forkBlockId);
      } catch (error) {
        try { index.deleteDocuments(targetSessionId); } catch {}
        valid = false;
        recordError(error, 'LEXICAL_FORK_FAILED');
      }
    });
  } catch (error) {
    await runLifecycle(index => { try { index.deleteDocuments(targetSessionId); } catch {} });
    recordError(error, 'LEXICAL_FORK_FAILED');
  }
  batchStates.delete(targetSessionId);
  if (valid) force(targetSessionId);
}

async function closeLane(): Promise<void> {
  for (const state of batchStates.values()) cancelDeadline(state);
  await Promise.allSettled([
    ...(startupPromise ? [startupPromise] : []),
    ...[...batchStates.values()].flatMap(state => state.active ? [state.active] : []),
    writerChain,
  ]);
  let closeError: unknown;
  try {
    lexicalIndex?.close();
  } catch (error) {
    closeError = error;
  } finally {
    lexicalIndex = undefined;
    ready = false;
    backfilling = false;
    rebuilding = false;
    generation = undefined;
    startupPromise = undefined;
    batchStates.clear();
    for (const pending of pendingResetEstablished.values()) pending.resolve();
    pendingResetSessions.clear();
    pendingResetEstablished.clear();
    writerChain = Promise.resolve();
  }
  if (closeError) throw closeError;
}

export async function shutdown(): Promise<void> {
  if (!VECTOR_LEXICAL_INDEX_ENABLED && !lexicalIndex) return;
  shuttingDown = true;
  for (const [sessionId, state] of batchStates.entries()) {
    cancelDeadline(state);
    if (!state.active && ready) state.active = enqueueIndex(sessionId, true, state.latestSeqHint, state.latestBlockIdHint)
      .catch(error => recordError(error, 'LEXICAL_SHUTDOWN_FLUSH_FAILED'));
  }
  try { await closeLane(); } catch (error) { recordError(error, 'LEXICAL_SHUTDOWN_FAILED'); }
  shuttingDown = false;
}

export async function waitForStartupBackfill(): Promise<void> {
  await startupPromise;
}

export function isConfigured(): boolean {
  return VECTOR_LEXICAL_INDEX_ENABLED;
}

export async function waitForIdleForTests(): Promise<void> {
  while (true) {
    const writerSnapshot = writerChain;
    await Promise.allSettled([
      ...(startupPromise ? [startupPromise] : []),
      ...[...batchStates.values()].flatMap(state => state.active ? [state.active] : []),
      writerSnapshot,
    ]);
    if (writerSnapshot === writerChain && ![...batchStates.values()].some(state => state.active)) return;
  }
}

export function setTestHooks(hooks?: {
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  yieldControl?: () => Promise<void>;
  beforeQuery?: () => void;
  afterCoveragePre?: () => void | Promise<void>;
  afterFtsQuery?: () => void | Promise<void>;
  getFreeBytes?: () => Promise<number>;
  beforePromotionValidation?: () => void | Promise<void>;
  beforeLifecycleMutation?: () => void;
}): void {
  now = hooks?.now || (() => Date.now());
  setTimer = hooks?.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
  clearTimer = hooks?.clearTimer || ((handle) => clearTimeout(handle));
  yieldControl = hooks?.yieldControl || (async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
  beforeQuery = hooks?.beforeQuery;
  afterCoveragePre = hooks?.afterCoveragePre;
  afterFtsQuery = hooks?.afterFtsQuery;
  getFreeBytes = hooks?.getFreeBytes || (async () => {
    const stats = await nodeFs.statfs(DB_DIR);
    return Number(stats.bavail) * Number(stats.bsize);
  });
  beforePromotionValidation = hooks?.beforePromotionValidation;
  beforeLifecycleMutation = hooks?.beforeLifecycleMutation;
}
