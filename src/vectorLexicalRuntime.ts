import crypto from 'crypto';
import path from 'path';
import { logger } from './common';
import { DB_DIR, VECTOR_LEXICAL_INDEX_ENABLED } from './config';
import {
  ArchiveSearchIndex,
  type ArchiveSearchDocumentInput,
} from './archiveSearchIndex';
import {
  getLocalArchiveVectorMaximaSync,
  listLocalArchiveSessionMaxima,
  readLocalArchiveBlockBatch,
  readLocalArchiveMessageBatch,
} from './session/archiveStore';
import type { ArchiveBlockRecord } from './session/layeredContext';
import { formatSubstantiveMessageSearchText } from './utils/messageFormat';

const RAW_BATCH_SIZE = 500;
const BLOCK_BATCH_SIZE = 100;
const RAW_FLUSH_THRESHOLD = 50;
const MAX_LATENCY_MS = 5 * 60_000;
const DB_PATH = path.join(DB_DIR, 'archive-search.sqlite');

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

let lexicalIndex: ArchiveSearchIndex | undefined;
let ready = false;
let backfilling = false;
let shuttingDown = false;
let disabledByLifecycle = false;
let startupPromise: Promise<void> | undefined;
let writerChain: Promise<void> = Promise.resolve();
let lastErrorCode: string | undefined;
let lastErrorAt: number | undefined;
const batchStates = new Map<string, BatchState>();
let now = () => Date.now();
let setTimer = (callback: () => void, delayMs: number): TimerHandle => setTimeout(callback, delayMs);
let clearTimer = (handle: TimerHandle): void => clearTimeout(handle);
let yieldControl = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)); };

function errorCode(error: unknown, fallback: string): string {
  const candidate = error as any;
  const code = typeof candidate?.code === 'string' ? candidate.code : fallback;
  return code.slice(0, 96);
}

function recordError(error: unknown, fallback: string): void {
  lastErrorCode = errorCode(error, fallback);
  lastErrorAt = now();
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

async function indexSession(sessionId: string, allowDuringShutdown = false, targetSeq?: number, targetBlockId?: number): Promise<void> {
  const index = lexicalIndex;
  if (!index || !ready || (shuttingDown && !allowDuringShutdown)) return;
  let checkpoint = index.getCheckpoint(sessionId);
  while (!shuttingDown || allowDuringShutdown) {
    const loaded = await readLocalArchiveMessageBatch(sessionId, checkpoint.rawLastIndexedSeq, RAW_BATCH_SIZE);
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
    const rows = targetBlockId === undefined ? loaded : loaded.filter(row => row.id <= targetBlockId);
    if (rows.length === 0) break;
    const entries = rows.map(blockDocuments);
    index.replaceBlockDocumentBatch(sessionId, entries, rows[rows.length - 1].id);
    checkpoint = index.getCheckpoint(sessionId);
    await yieldControl();
  }
}

function enqueueIndex(sessionId: string, allowDuringShutdown = false, targetSeq?: number, targetBlockId?: number): Promise<void> {
  const run = writerChain.then(() => indexSession(sessionId, allowDuringShutdown, targetSeq, targetBlockId));
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
  if (!VECTOR_LEXICAL_INDEX_ENABLED || lexicalIndex || disabledByLifecycle) return;
  shuttingDown = false;
  try {
    lexicalIndex = ArchiveSearchIndex.open(DB_PATH);
    ready = true;
    lastErrorCode = undefined;
    lastErrorAt = undefined;
    startupPromise = runStartupBackfill();
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

export async function disableForDeferredLifecycle(): Promise<void> {
  if (!VECTOR_LEXICAL_INDEX_ENABLED) return;
  disabledByLifecycle = true;
  recordError({ code: 'LEXICAL_LIFECYCLE_DEFERRED' }, 'LEXICAL_LIFECYCLE_DEFERRED');
  try { await closeLane(); } catch (error) { recordError(error, 'LEXICAL_LIFECYCLE_CLOSE_FAILED'); }
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
    startupPromise = undefined;
    batchStates.clear();
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
}): void {
  now = hooks?.now || (() => Date.now());
  setTimer = hooks?.setTimer || ((callback, delayMs) => setTimeout(callback, delayMs));
  clearTimer = hooks?.clearTimer || ((handle) => clearTimeout(handle));
  yieldControl = hooks?.yieldControl || (async () => { await new Promise<void>(resolve => setImmediate(resolve)); });
}
