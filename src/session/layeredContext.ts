import fs from 'fs-extra';
import path from 'path';
import { Message, Session, ContextFrontierItem, ContextBlockMessageMeta } from '../types';
import {
  getSessionBlockArchiveLogPath,
} from '../config';
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
import { parseFoxwarmTagLine } from '../utils/promptWrappers';

const COMPACT_CANDIDATE_IGNORED_SYSTEM_PREFIXES = [
  'This session has been compacted.',
  'Compacted message placeholder:',
  'Compaction completed.',
  '**COMPACTION COMPLETED.',
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
  sourceBlockIds?: number[];
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
  sourceBlockIds?: number[];
  rawStartSeq: number;
  rawEndSeq: number;
  summary: string;
}

export type ContextFrontierAnnotationResult = {
  history: Message[];
  matched: boolean;
  warnings: string[];
};

export type ContextFrontierAnnotationOptions = {
  readBlocksByIdRange?: (sessionId: string, startId?: number, endId?: number) => Promise<ArchiveBlockRecord[]>;
};

export function isIgnoredCompactLifecycleSystemText(text: string): boolean {
  const tag = parseFoxwarmTagLine(text);
  if (tag?.tagName === 'foxwarm-system') {
    const hint = tag.attrs.hint || '';
    return tag.attrs.event === 'compact'
      || tag.attrs.kind === 'session-boundary'
      || COMPACT_CANDIDATE_IGNORED_SYSTEM_PREFIXES.some(prefix => hint.startsWith(prefix));
  }
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

function getNextSessionBlockId(session: Session): number {
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

async function buildArchiveBlockRecords(session: Session, blocks: CreateArchiveBlockInput[]): Promise<ArchiveBlockRecord[]> {
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
      ...(block.sourceKind === 'block' && Array.isArray(block.sourceBlockIds) && block.sourceBlockIds.length > 0
        ? { sourceBlockIds: block.sourceBlockIds }
        : {}),
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

export type ArchiveBlockTimeRangeInput = Pick<ArchiveBlockRecord, 'rawStartTimestamp' | 'rawEndTimestamp'> & {
  startTime?: number;
  endTime?: number;
  startTimestamp?: number;
  endTimestamp?: number;
};

function normalizeArchiveBlockTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function getArchiveBlockStartTimestamp(record: ArchiveBlockTimeRangeInput): number | undefined {
  return normalizeArchiveBlockTimestamp(record.rawStartTimestamp)
    ?? normalizeArchiveBlockTimestamp(record.startTime)
    ?? normalizeArchiveBlockTimestamp(record.startTimestamp);
}

export function getArchiveBlockEndTimestamp(record: ArchiveBlockTimeRangeInput): number | undefined {
  return normalizeArchiveBlockTimestamp(record.rawEndTimestamp)
    ?? normalizeArchiveBlockTimestamp(record.endTime)
    ?? normalizeArchiveBlockTimestamp(record.endTimestamp);
}

export function formatArchiveBlockTimeRange(record: ArchiveBlockTimeRangeInput): string {
  const range = formatLocalTimeRange(getArchiveBlockStartTimestamp(record), getArchiveBlockEndTimestamp(record));
  return range ? ` time ${range}` : '';
}

export type ArchiveBlockContextTextInput = Pick<ArchiveBlockRecord, 'id' | 'level' | 'rawStartSeq' | 'rawEndSeq' | 'summary'> & ArchiveBlockTimeRangeInput;

function formatArchiveBlockRawRange(record: Pick<ArchiveBlockRecord, 'rawStartSeq' | 'rawEndSeq'>): string {
  return `raw${formatSeqRange(record.rawStartSeq, record.rawEndSeq)}`;
}

function formatArchiveBlockContextPrefix(record: Omit<ArchiveBlockContextTextInput, 'summary'>): string {
  return `[CTX-BLOCK L${record.level} B#${record.id} ${formatArchiveBlockRawRange(record)}${formatArchiveBlockTimeRange(record)}]`;
}

export function formatArchiveBlockContextText(record: ArchiveBlockContextTextInput): string {
  return `${formatArchiveBlockContextPrefix(record)} ${record.summary}`;
}

export function buildContextBlockMessageMeta(record: ArchiveBlockRecord): ContextBlockMessageMeta {
  return {
    id: record.id,
    level: record.level,
    rawStartSeq: record.rawStartSeq,
    rawEndSeq: record.rawEndSeq,
    sourceKind: record.sourceKind,
    sourceStart: record.sourceStart,
    sourceEnd: record.sourceEnd,
    ...(Array.isArray(record.sourceBlockIds) && record.sourceBlockIds.length > 0 ? { sourceBlockIds: [...record.sourceBlockIds] } : {}),
    ...(typeof record.rawStartTimestamp === 'number' ? { rawStartTimestamp: record.rawStartTimestamp } : {}),
    ...(typeof record.rawEndTimestamp === 'number' ? { rawEndTimestamp: record.rawEndTimestamp } : {}),
    ...(typeof record.createdAt === 'number' ? { createdAt: record.createdAt } : {}),
    ...(typeof record.sourceSessionId === 'string' ? { sourceSessionId: record.sourceSessionId } : {}),
    ...(record.inherited !== undefined ? { inherited: record.inherited } : {}),
  };
}

function annotateMessageWithFrontierItem(message: Message, item: Extract<ContextFrontierItem, { kind: 'message' }>): Message {
  const next = structuredClone(message);
  next.__meta = {
    ...(next.__meta || {}),
    contextFrontierItem: structuredClone(item),
    ...(typeof item.preservedFromBlockId === 'number' ? { preservedFromBlockId: item.preservedFromBlockId } : {}),
  };
  if (typeof item.preservedFromBlockId !== 'number') {
    delete next.__meta.preservedFromBlockId;
  }
  return next;
}

function annotateMessageWithBlock(message: Message, item: Extract<ContextFrontierItem, { kind: 'block' }>, record: ArchiveBlockRecord): Message {
  const next = structuredClone(message);
  next.__meta = {
    ...(next.__meta || {}),
    timestamp: next.__meta?.timestamp || record.createdAt,
    contextFrontierItem: structuredClone(item),
    contextBlock: buildContextBlockMessageMeta(record),
  };
  return next;
}

function messageText(message: Message): string {
  return (message.parts || [])
    .map(part => typeof part.text === 'string' ? part.text : '')
    .filter(Boolean)
    .join('\n');
}

function blockMessageLooksCompatible(message: Message, item: Extract<ContextFrontierItem, { kind: 'block' }>): boolean {
  if (!message) {
    return false;
  }

  if (message.__meta?.contextBlock?.id === item.id) {
    return true;
  }

  const text = messageText(message).trim();
  return new RegExp(`^\\[CTX-BLOCK\\s+L${item.level}\\s+B#${item.id}(?:\\s|])`).test(text);
}

async function readBlockMapForFrontier(
  sessionId: string,
  frontier: ContextFrontierItem[],
  readBlocksByIdRange: (sessionId: string, startId?: number, endId?: number) => Promise<ArchiveBlockRecord[]>,
): Promise<Map<number, ArchiveBlockRecord>> {
  const blockIds = frontier
    .filter((item): item is Extract<ContextFrontierItem, { kind: 'block' }> => item.kind === 'block')
    .map(item => item.id);
  if (blockIds.length === 0) {
    return new Map();
  }

  const records = await readBlocksByIdRange(sessionId, Math.min(...blockIds), Math.max(...blockIds));
  return new Map(records.map(record => [record.id, record]));
}

export async function annotateHistoryWithContextFrontierMetadata(
  sessionId: string,
  history: Message[],
  frontier: ContextFrontierItem[],
  options: ContextFrontierAnnotationOptions = {},
): Promise<ContextFrontierAnnotationResult> {
  const readBlocks = options.readBlocksByIdRange || readArchiveBlocksByIdRange;
  const blockMap = await readBlockMapForFrontier(sessionId, frontier, readBlocks);
  const nextHistory = structuredClone(history || []);
  const warnings: string[] = [];

  if (nextHistory.length !== frontier.length) {
    warnings.push(`history length ${nextHistory.length} does not match context frontier length ${frontier.length}`);
  }

  const seqToHistoryIndex = new Map<number, number>();
  nextHistory.forEach((message, index) => {
    const seq = message.__meta?.seq;
    if (typeof seq === 'number' && seq > 0 && !seqToHistoryIndex.has(seq)) {
      seqToHistoryIndex.set(seq, index);
    }
  });

  const usedHistoryIndexes = new Set<number>();
  for (let frontierIndex = 0; frontierIndex < frontier.length; frontierIndex += 1) {
    const item = frontier[frontierIndex];
    const positionalMessage = nextHistory[frontierIndex];

    if (item.kind === 'message') {
      let historyIndex = positionalMessage?.__meta?.seq === item.seq
        ? frontierIndex
        : seqToHistoryIndex.get(item.seq);
      if (typeof historyIndex !== 'number') {
        warnings.push(`frontier message seq ${item.seq} did not match any rendered history message`);
        continue;
      }
      if (historyIndex !== frontierIndex) {
        warnings.push(`frontier message seq ${item.seq} matched history index ${historyIndex}, expected ${frontierIndex}`);
      }
      nextHistory[historyIndex] = annotateMessageWithFrontierItem(nextHistory[historyIndex], item);
      usedHistoryIndexes.add(historyIndex);
      continue;
    }

    const blockRecord = blockMap.get(item.id);
    if (!blockRecord) {
      warnings.push(`frontier block B#${item.id} has no archive block record`);
      continue;
    }

    let historyIndex = blockMessageLooksCompatible(positionalMessage, item) ? frontierIndex : -1;
    if (historyIndex < 0) {
      historyIndex = nextHistory.findIndex((message, index) => !usedHistoryIndexes.has(index) && blockMessageLooksCompatible(message, item));
    }
    if (historyIndex < 0) {
      warnings.push(`frontier block B#${item.id} did not match any rendered CTX-BLOCK message`);
      continue;
    }
    if (historyIndex !== frontierIndex) {
      warnings.push(`frontier block B#${item.id} matched history index ${historyIndex}, expected ${frontierIndex}`);
    }

    nextHistory[historyIndex] = annotateMessageWithBlock(nextHistory[historyIndex], item, blockRecord);
    usedHistoryIndexes.add(historyIndex);
  }

  return {
    history: nextHistory,
    matched: warnings.length === 0,
    warnings,
  };
}

export function renderBlockMessage(record: ArchiveBlockRecord): Message {
  const frontierItem: ContextFrontierItem = {
    kind: 'block',
    id: record.id,
    level: record.level,
    rawStartSeq: record.rawStartSeq,
    rawEndSeq: record.rawEndSeq,
  };
  return {
    role: 'model',
    parts: [{
      text: formatArchiveBlockContextText(record),
    }],
    __meta: {
      timestamp: record.createdAt,
      contextFrontierItem: frontierItem,
      contextBlock: buildContextBlockMessageMeta(record),
    },
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
        rendered.push(annotateMessageWithFrontierItem(record.message, item));
      }
      continue;
    }

    const record = blockMap.get(item.id);
    if (record) {
      rendered.push(annotateMessageWithBlock(renderBlockMessage(record), item, record));
    }
  }

  return rendered;
}

export function cloneSessionFrontier(session: Session): ContextFrontierItem[] {
  return cloneFrontier(ensureContextFrontier(session)) || [];
}
