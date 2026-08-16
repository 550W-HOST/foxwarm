import { Message, Session } from '../types';
import { externalizeMessageImages } from '../imageBlobs';
import {
  ArchiveMessageStats,
  ensureSessionBranch,
  getEffectiveArchiveMessageStats,
  getLocalArchiveMessageStats as getLocalArchiveMessageStatsFromStore,
  readEffectiveArchiveMessages,
  readLocalArchiveMessages as readLocalArchiveMessagesFromStore,
  rollbackUncommittedArchiveMessages,
  writeArchiveMessages,
} from './archiveStore';

export interface ArchiveMessageRecord {
  v: number;
  kind: 'message';
  sessionId: string;
  agent: string;
  seq: number;
  timestamp: number;
  role: Message['role'];
  message: Message;
  sourceSessionId?: string;
  inherited?: boolean;
}

type ArchiveWritePhase = 'before-sqlite-write' | 'after-jsonl-append';
let archiveWriteFaultInjector: ((phase: ArchiveWritePhase, sessionId: string) => void) | null = null;

export function setArchiveWriteFaultInjectorForTests(injector: ((phase: ArchiveWritePhase, sessionId: string) => void) | null): void {
  archiveWriteFaultInjector = injector;
}

export class SessionArchiveCommitError extends Error {
  readonly code = 'SESSION_ARCHIVE_COMMIT_FAILED';
  constructor(message: string, readonly cause?: unknown) { super(message); this.name = 'SessionArchiveCommitError'; }
}

export function isSessionArchiveCommitError(error: unknown): boolean {
  return String((error as any)?.code || '') === 'SESSION_ARCHIVE_COMMIT_FAILED';
}

export function getMessageTimestamp(message: Message): number {
  return message.__meta?.timestamp || Date.now();
}

export function getNextSessionMessageSeq(session: Session): number {
  if (typeof session.nextMessageSeq === 'number' && session.nextMessageSeq > 0) {
    return session.nextMessageSeq;
  }

  let maxSeq = 0;
  for (const message of session.history) {
    const seq = message.__meta?.seq;
    if (typeof seq === 'number' && seq > maxSeq) {
      maxSeq = seq;
    }
  }

  session.nextMessageSeq = maxSeq + 1 || 1;
  return session.nextMessageSeq;
}

export function ensureMessageSeq(session: Session, message: Message): number {
  const existingSeq = message.__meta?.seq;
  if (typeof existingSeq === 'number' && existingSeq > 0) {
    session.nextMessageSeq = Math.max(getNextSessionMessageSeq(session), existingSeq + 1);
    return existingSeq;
  }

  const seq = getNextSessionMessageSeq(session);
  message.__meta = {
    ...(message.__meta || {}),
    timestamp: getMessageTimestamp(message),
    seq,
  };
  session.nextMessageSeq = seq + 1;
  return seq;
}

export async function buildArchiveRecord(session: Session, message: Message): Promise<any> {
  const seq = ensureMessageSeq(session, message);
  const timestamp = getMessageTimestamp(message);
  const canonical = (await externalizeMessageImages(message)).message;

  return {
    v: 1,
    kind: 'message',
    sessionId: session.id,
    agent: session.agent || 'main',
    seq,
    timestamp,
    role: message.role,
    message: {
      ...canonical,
      __meta: {
        ...(message.__meta || {}),
        timestamp,
        seq,
      },
      parts: canonical.parts,
    },
  };
}

export async function appendMessagesToArchive(session: Session, messages: Message[]): Promise<ArchiveMessageRecord[]> {
  if (messages.length === 0) {
    return [];
  }

  await ensureSessionBranch(session.id);

  const records: ArchiveMessageRecord[] = [];
  for (const message of messages) {
    const record = await buildArchiveRecord(session, message);
    records.push(record as ArchiveMessageRecord);
  }

  try {
    archiveWriteFaultInjector?.('before-sqlite-write', session.id);
    return await writeArchiveMessages(records);
  }
  catch (error) { throw new SessionArchiveCommitError(`Required archive commit failed for Session ${session.id}: ${(error as any)?.message || error}`, error); }
}

export async function rollbackUncommittedMessages(records: ArchiveMessageRecord[]): Promise<void> {
  await rollbackUncommittedArchiveMessages(records);
}

export async function readArchiveMessages(sessionId: string): Promise<ArchiveMessageRecord[]> {
  return readEffectiveArchiveMessages(sessionId);
}

export async function readLocalArchiveMessages(sessionId: string): Promise<ArchiveMessageRecord[]> {
  return readLocalArchiveMessagesFromStore(sessionId);
}

export async function getArchiveMessageStats(sessionId: string, startSeq?: number, endSeq?: number): Promise<ArchiveMessageStats> {
  return getEffectiveArchiveMessageStats(sessionId, startSeq, endSeq);
}

export async function getLocalArchiveMessageStats(sessionId: string, startSeq?: number, endSeq?: number): Promise<ArchiveMessageStats> {
  return getLocalArchiveMessageStatsFromStore(sessionId, startSeq, endSeq);
}

export function stripMessageSeq(message: Message): Message {
  const clonedMessage = structuredClone(message);
  if (!clonedMessage.__meta) {
    return clonedMessage;
  }

  delete clonedMessage.__meta.seq;
  if (Object.keys(clonedMessage.__meta).length === 0) {
    delete clonedMessage.__meta;
  }

  return clonedMessage;
}
export async function readArchiveMessagesBySeqRange(sessionId: string, startSeq?: number, endSeq?: number): Promise<ArchiveMessageRecord[]> {
  return readEffectiveArchiveMessages(sessionId, startSeq, endSeq);
}

export async function readLocalArchiveMessagesBySeqRange(sessionId: string, startSeq?: number, endSeq?: number): Promise<ArchiveMessageRecord[]> {
  return readLocalArchiveMessagesFromStore(sessionId, startSeq, endSeq);
}
