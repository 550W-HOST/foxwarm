import fs from 'fs-extra';
import path from 'path';
import { Message, Session, ContextFrontierItem } from '../types';
import {
  getSessionArchiveLogPath,
  getSessionBlockArchiveLogPath,
  getSessionFrontierPath,
} from '../config';
import { logger } from '../common';
import { DiskJsonData } from '../utils/diskJsonData';
import { ArchiveMessageRecord, readArchiveMessagesBySeqRange } from './archive';
import { formatLocalTimeRange } from '../utils/localTime';
import {
  ensureSessionBranch,
  refreshSessionArchiveImportState,
  readEffectiveArchiveBlocks,
  readLocalArchiveBlocks as readLocalArchiveBlocksFromStore,
  writeArchiveBlocks,
} from './archiveStore';
import { isModelVisibleMessage } from './messageVisibility';

const COMPACT_CANDIDATE_IGNORED_SYSTEM_PREFIXES = [
  'This session has been compacted.',
  'Compacted message placeholder:',
  'Compaction completed.',
  'Manual compaction completed.',
];

export interface ArchiveBlockRecord {
  v: number;
  kind: 'block';
  sessionId: string;
  agent: string;
  id: number;
  level: number;
  sourceKind: 'message' | 'block';
  sourceStart: number;
  sourceEnd: number;
  rawStartSeq: number;
  rawEndSeq: number;
  rawStartTimestamp?: number;
  rawEndTimestamp?: number;
  summary: string;
  createdAt: number;
  sourceSessionId?: string;
  inherited?: boolean;
}

export interface CreateArchiveBlockInput {
  level: number;
  sourceKind: 'message' | 'block';
  sourceStart: number;
  sourceEnd: number;
  rawStartSeq: number;
  rawEndSeq: number;
  summary: string;
}

export function isIgnoredCompactLifecycleSystemText(text: string): boolean {
  return COMPACT_CANDIDATE_IGNORED_SYSTEM_PREFIXES.some(prefix => text.startsWith(prefix));
}

export function shouldIgnoreMessageInCompactCandidates(message: Message): boolean {
  if (!isModelVisibleMessage(message)) {
    return true;
  }

  const parts = message.parts || [];
  const systemTexts = parts
    .map(part => typeof part.system === 'string' ? part.system.trim() : '')
    .filter(Boolean);

  if (systemTexts.length === 0) {
    return false;
  }

  const hasNonSystemContent = parts.some(part => (
    (typeof part.text === 'string' && part.text.trim().length > 0)
    || (typeof part.thinking === 'string' && part.thinking.trim().length > 0)
    || !!part.functionCall
    || !!part.functionResponse
    || !!part.inlineData
    || !!(part as any).inlineDataRef
  ));

  if (hasNonSystemContent) {
    return false;
  }

  return systemTexts.every(isIgnoredCompactLifecycleSystemText);
}

function cloneFrontier(frontier: ContextFrontierItem[] | undefined): ContextFrontierItem[] | undefined {
  return frontier ? structuredClone(frontier) : undefined;
}

function normalizeFrontierPayload(raw: any, filePath: string): { v: number; sessionId?: string; nextBlockId?: number; frontier: ContextFrontierItem[] } {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Invalid layered context frontier payload in ${filePath}`);
  }

  return {
    ...raw,
    v: typeof raw.v === 'number' ? raw.v : 1,
    frontier: Array.isArray(raw.frontier) ? raw.frontier : [],
  };
}

export function createSessionFrontierStore(filePath: string): DiskJsonData<{ v: number; sessionId?: string; nextBlockId?: number; frontier: ContextFrontierItem[] }> {
  return new DiskJsonData(filePath, {
    backup: false,
    normalizeLoadedData: normalizeFrontierPayload,
    onReadError: (err: unknown, candidatePath: string) => {
      logger.warn({ err, candidatePath }, 'Failed to read layered context frontier');
    },
  });
}

const frontierStores = new Map<string, DiskJsonData<{ v: number; sessionId?: string; nextBlockId?: number; frontier: ContextFrontierItem[] }>>();

export function getSessionFrontierStore(sessionId: string): DiskJsonData<{ v: number; sessionId?: string; nextBlockId?: number; frontier: ContextFrontierItem[] }> {
  const frontierPath = getSessionFrontierPath(sessionId);
  let store = frontierStores.get(frontierPath);
  if (!store) {
    store = createSessionFrontierStore(frontierPath);
    frontierStores.set(frontierPath, store);
  }
  return store;
}

export function getNextSessionBlockId(session: Session): number {
  if (typeof session.nextBlockId === 'number' && session.nextBlockId > 0) {
    return session.nextBlockId;
  }

  let maxId = 0;
  for (const item of session.contextFrontier || []) {
    if (item.kind === 'block' && item.id > maxId) {
      maxId = item.id;
    }
  }

  session.nextBlockId = maxId + 1 || 1;
  return session.nextBlockId;
}

export function ensureContextFrontier(session: Session): ContextFrontierItem[] {
  if (Array.isArray(session.contextFrontier) && session.contextFrontier.length > 0) {
    return session.contextFrontier;
  }

  const frontier: ContextFrontierItem[] = [];
  for (const message of session.history) {
    const seq = message.__meta?.seq;
    if (typeof seq === 'number' && seq > 0) {
      frontier.push({ kind: 'message', seq });
    }
  }

  session.contextFrontier = frontier;
  return frontier;
}

export function appendMessagesToContextFrontier(session: Session, messages: Message[]): void {
  if (!Array.isArray(session.contextFrontier)) {
    return;
  }

  for (const message of messages) {
    const seq = message.__meta?.seq;
    if (typeof seq === 'number' && seq > 0) {
      session.contextFrontier.push({ kind: 'message', seq });
    }
  }
}

export async function saveSessionFrontier(session: Session): Promise<void> {
  const frontierPath = getSessionFrontierPath(session.id);
  if (!session.contextFrontier || session.contextFrontier.length === 0) {
    if (await fs.pathExists(frontierPath)) {
      await fs.remove(frontierPath);
    }
    return;
  }

  await getSessionFrontierStore(session.id).write({
    v: 1,
    sessionId: session.id,
    nextBlockId: getNextSessionBlockId(session),
    frontier: session.contextFrontier,
  });
}

export async function loadSessionFrontier(session: Session): Promise<void> {
  const frontierPath = getSessionFrontierPath(session.id);
  if (!await fs.pathExists(frontierPath)) {
    return;
  }

  try {
    const data = await getSessionFrontierStore(session.id).readFromPath(frontierPath);
    if (Array.isArray(data?.frontier)) {
      session.contextFrontier = data.frontier;
      if (typeof data.nextBlockId === 'number' && data.nextBlockId > 0) {
        session.nextBlockId = data.nextBlockId;
      }
    }
  } catch (e) {
    logger.warn({ err: e, sessionId: session.id }, 'Failed to load layered context frontier');
  }
}

export async function buildArchiveBlockRecords(session: Session, blocks: CreateArchiveBlockInput[]): Promise<ArchiveBlockRecord[]> {
  const createdAt = Date.now();
  return Promise.all(blocks.map(async (block) => {
    const id = getNextSessionBlockId(session);
    session.nextBlockId = id + 1;
    const [startRecord, endRecord] = await Promise.all([
      readArchiveMessagesBySeqRange(session.id, block.rawStartSeq, block.rawStartSeq),
      readArchiveMessagesBySeqRange(session.id, block.rawEndSeq, block.rawEndSeq),
    ]);
    return {
      v: 1,
      kind: 'block',
      sessionId: session.id,
      agent: session.agent || 'main',
      id,
      level: block.level,
      sourceKind: block.sourceKind,
      sourceStart: block.sourceStart,
      sourceEnd: block.sourceEnd,
      rawStartSeq: block.rawStartSeq,
      rawEndSeq: block.rawEndSeq,
      rawStartTimestamp: startRecord[0]?.timestamp,
      rawEndTimestamp: endRecord[0]?.timestamp,
      summary: block.summary,
      createdAt,
    };
  }));
}

export async function appendBlocksToArchive(session: Session, blocks: CreateArchiveBlockInput[]): Promise<ArchiveBlockRecord[]> {
  if (blocks.length === 0) {
    return [];
  }

  const archivePath = getSessionBlockArchiveLogPath(session.id);
  await fs.ensureDir(path.dirname(archivePath));
  await ensureSessionBranch(session.id);
  const records = await buildArchiveBlockRecords(session, blocks);
  await fs.appendFile(archivePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  await writeArchiveBlocks(records);
  await refreshSessionArchiveImportState(session.id, 'blocks');
  return records;
}

export async function readArchiveBlocks(sessionId: string): Promise<ArchiveBlockRecord[]> {
  return readEffectiveArchiveBlocks(sessionId);
}

export async function readArchiveBlocksByIdRange(sessionId: string, startId?: number, endId?: number): Promise<ArchiveBlockRecord[]> {
  return readEffectiveArchiveBlocks(sessionId, startId, endId);
}

export async function readLocalArchiveBlocks(sessionId: string): Promise<ArchiveBlockRecord[]> {
  return readLocalArchiveBlocksFromStore(sessionId);
}

export async function readLocalArchiveBlocksByIdRange(sessionId: string, startId?: number, endId?: number): Promise<ArchiveBlockRecord[]> {
  return readLocalArchiveBlocksFromStore(sessionId, startId, endId);
}

function formatSeqRange(startSeq: number, endSeq: number): string {
  return startSeq === endSeq ? `#${startSeq}` : `#${startSeq}-#${endSeq}`;
}

export function formatArchiveBlockTimeRange(record: Pick<ArchiveBlockRecord, 'rawStartTimestamp' | 'rawEndTimestamp'>): string {
  const range = formatLocalTimeRange(record.rawStartTimestamp, record.rawEndTimestamp);
  return range ? ` time ${range}` : '';
}

export function renderBlockMessage(record: ArchiveBlockRecord): Message {
  return {
    role: 'model',
    parts: [{
      text: `[CTX-BLOCK L${record.level} B#${record.id} raw${formatSeqRange(record.rawStartSeq, record.rawEndSeq)}${formatArchiveBlockTimeRange(record)}] ${record.summary}`,
    }],
    __meta: { timestamp: record.createdAt },
  };
}

export async function renderHistoryFromFrontier(session: Session, frontier?: ContextFrontierItem[]): Promise<Message[]> {
  const targetFrontier = frontier || session.contextFrontier || [];
  if (targetFrontier.length === 0) {
    return [];
  }

  const messageSeqs = targetFrontier
    .filter((item): item is Extract<ContextFrontierItem, { kind: 'message' }> => item.kind === 'message')
    .map(item => item.seq);
  const blockIds = targetFrontier
    .filter((item): item is Extract<ContextFrontierItem, { kind: 'block' }> => item.kind === 'block')
    .map(item => item.id);

  const messageRecords = messageSeqs.length
    ? await readArchiveMessagesBySeqRange(session.id, Math.min(...messageSeqs), Math.max(...messageSeqs))
    : [];
  const blockRecords = blockIds.length
    ? await readArchiveBlocksByIdRange(session.id, Math.min(...blockIds), Math.max(...blockIds))
    : [];

  const messageMap = new Map<number, ArchiveMessageRecord>(messageRecords.map(record => [record.seq, record]));
  const blockMap = new Map<number, ArchiveBlockRecord>(blockRecords.map(record => [record.id, record]));

  const rendered: Message[] = [];
  for (const item of targetFrontier) {
    if (item.kind === 'message') {
      const record = messageMap.get(item.seq);
      if (record?.message) {
        rendered.push(structuredClone(record.message));
      }
      continue;
    }

    const record = blockMap.get(item.id);
    if (record) {
      rendered.push(renderBlockMessage(record));
    }
  }

  return rendered;
}

export function cloneSessionFrontier(session: Session): ContextFrontierItem[] {
  return cloneFrontier(ensureContextFrontier(session)) || [];
}

export async function copyLayeredContextFiles(sourceSessionId: string, targetSessionId: string): Promise<void> {
  const sourceBlockArchive = getSessionBlockArchiveLogPath(sourceSessionId);
  const targetBlockArchive = getSessionBlockArchiveLogPath(targetSessionId);
  if (await fs.pathExists(sourceBlockArchive)) {
    await fs.ensureDir(path.dirname(targetBlockArchive));
    await fs.copy(sourceBlockArchive, targetBlockArchive, { overwrite: true });
  }

  const sourceFrontier = getSessionFrontierPath(sourceSessionId);
  const targetFrontier = getSessionFrontierPath(targetSessionId);
  if (await fs.pathExists(sourceFrontier)) {
    await fs.ensureDir(path.dirname(targetFrontier));
    await fs.copy(sourceFrontier, targetFrontier, { overwrite: true });
  }
}

export async function moveLayeredContextFiles(oldSessionId: string, newSessionId: string): Promise<void> {
  const oldBlockArchive = getSessionBlockArchiveLogPath(oldSessionId);
  const newBlockArchive = getSessionBlockArchiveLogPath(newSessionId);
  if (await fs.pathExists(oldBlockArchive)) {
    await fs.ensureDir(path.dirname(newBlockArchive));
    await fs.move(oldBlockArchive, newBlockArchive, { overwrite: true });
  }

  const oldFrontier = getSessionFrontierPath(oldSessionId);
  const newFrontier = getSessionFrontierPath(newSessionId);
  if (await fs.pathExists(oldFrontier)) {
    await fs.ensureDir(path.dirname(newFrontier));
    await fs.move(oldFrontier, newFrontier, { overwrite: true });
  }
}
