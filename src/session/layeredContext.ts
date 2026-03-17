import fs from 'fs-extra';
import path from 'path';
import { Message, Session, ContextFrontierItem } from '../types';
import {
  getSessionArchiveLogPath,
  getSessionBlockArchiveLogPath,
  getSessionFrontierPath,
} from '../config';
import { logger } from '../common';
import { ArchiveMessageRecord, readArchiveMessagesBySeqRange } from './archive';

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
  summary: string;
  createdAt: number;
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

  await fs.ensureDir(path.dirname(frontierPath));
  await fs.writeJson(frontierPath, {
    v: 1,
    sessionId: session.id,
    nextBlockId: getNextSessionBlockId(session),
    frontier: session.contextFrontier,
  }, { spaces: 2 });
}

export async function loadSessionFrontier(session: Session): Promise<void> {
  const frontierPath = getSessionFrontierPath(session.id);
  if (!await fs.pathExists(frontierPath)) {
    return;
  }

  try {
    const data = await fs.readJson(frontierPath);
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
  return blocks.map(block => {
    const id = getNextSessionBlockId(session);
    session.nextBlockId = id + 1;
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
      summary: block.summary,
      createdAt,
    };
  });
}

export async function appendBlocksToArchive(session: Session, blocks: CreateArchiveBlockInput[]): Promise<ArchiveBlockRecord[]> {
  if (blocks.length === 0) {
    return [];
  }

  const archivePath = getSessionBlockArchiveLogPath(session.id);
  await fs.ensureDir(path.dirname(archivePath));
  const records = await buildArchiveBlockRecords(session, blocks);
  await fs.appendFile(archivePath, `${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  return records;
}

export async function readArchiveBlocks(sessionId: string): Promise<ArchiveBlockRecord[]> {
  const archivePath = getSessionBlockArchiveLogPath(sessionId);
  if (!await fs.pathExists(archivePath)) {
    return [];
  }

  const raw = await fs.readFile(archivePath, 'utf8');
  const parsed: ArchiveBlockRecord[] = [];
  for (const line of raw.split('\n').map(line => line.trim()).filter(Boolean)) {
    try {
      const record = JSON.parse(line);
      if (record?.kind === 'block' && typeof record.id === 'number' && typeof record.level === 'number') {
        parsed.push(record as ArchiveBlockRecord);
      }
    } catch (e) {
      logger.warn({ err: e, sessionId }, 'Skipping malformed block archive line');
    }
  }

  return parsed.sort((a, b) => a.id - b.id);
}

export async function readArchiveBlocksByIdRange(sessionId: string, startId?: number, endId?: number): Promise<ArchiveBlockRecord[]> {
  const records = await readArchiveBlocks(sessionId);
  return records.filter(record => {
    if (typeof startId === 'number' && record.id < startId) return false;
    if (typeof endId === 'number' && record.id > endId) return false;
    return true;
  });
}

function formatSeqRange(startSeq: number, endSeq: number): string {
  return startSeq === endSeq ? `#${startSeq}` : `#${startSeq}-#${endSeq}`;
}

export function renderBlockMessage(record: ArchiveBlockRecord): Message {
  return {
    role: 'model',
    parts: [{
      text: `[CTX-BLOCK L${record.level} B#${record.id} raw${formatSeqRange(record.rawStartSeq, record.rawEndSeq)}] ${record.summary}`,
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
