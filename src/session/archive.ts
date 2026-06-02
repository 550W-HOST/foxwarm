import fs from 'fs-extra';
import path from 'path';
import { createHash } from 'crypto';
import { Message, MessagePart, Session } from '../types';
import { getSessionArchiveImagesDir, getSessionArchiveLogPath } from '../config';
import {
  ensureSessionBranch,
  refreshSessionArchiveImportState,
  readEffectiveArchiveMessages,
  readLocalArchiveMessages as readLocalArchiveMessagesFromStore,
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

function getInlineDataMimeType(part: MessagePart): string {
  return part.inlineData?.mimeType || part.inlineData?.mime_type || 'application/octet-stream';
}

function getArchiveFileExtension(mimeType: string): string {
  const lower = mimeType.toLowerCase();

  if (lower === 'image/jpeg') return 'jpg';
  if (lower === 'image/svg+xml') return 'svg';
  if (lower.startsWith('image/')) return lower.slice('image/'.length) || 'bin';

  const slashIndex = lower.indexOf('/');
  if (slashIndex !== -1 && slashIndex + 1 < lower.length) {
    return lower.slice(slashIndex + 1).replace(/[^a-z0-9]+/g, '-') || 'bin';
  }

  return 'bin';
}

export async function buildArchiveRecord(session: Session, message: Message): Promise<any> {
  const seq = ensureMessageSeq(session, message);
  const timestamp = getMessageTimestamp(message);
  const archiveParts = [];

  for (let partIndex = 0; partIndex < message.parts.length; partIndex++) {
    const part = message.parts[partIndex];
    const existingImageMeta = part.imageMeta;

    if (!part.inlineData?.data) {
      archiveParts.push(part);
      continue;
    }

    const mimeType = getInlineDataMimeType(part);
    const extension = getArchiveFileExtension(mimeType);
    const imageId = existingImageMeta?.imageId || `msg${String(seq).padStart(8, '0')}_part${partIndex + 1}`;
    const imageDir = getSessionArchiveImagesDir(session.id);
    const fileName = `${imageId}.${extension}`;
    const filePath = path.join(imageDir, fileName);
    const binary = Buffer.from(part.inlineData.data, 'base64');
    const sha256 = createHash('sha256').update(binary).digest('hex');

    await fs.ensureDir(imageDir);
    await fs.writeFile(filePath, binary);

    const { inlineData, ...rest } = part;
    archiveParts.push({
      ...rest,
      inlineDataRef: {
        imageId,
        format: extension,
        path: path.relative(path.join(__dirname, '..'), filePath),
        mimeType,
        byteLength: binary.length,
        sha256,
        width: existingImageMeta?.width,
        height: existingImageMeta?.height,
      },
    });
  }

  return {
    v: 1,
    kind: 'message',
    sessionId: session.id,
    agent: session.agent || 'main',
    seq,
    timestamp,
    role: message.role,
    message: {
      ...message,
      __meta: {
        ...(message.__meta || {}),
        timestamp,
        seq,
      },
      parts: archiveParts,
    },
  };
}

export async function appendMessagesToArchive(session: Session, messages: Message[]): Promise<void> {
  if (messages.length === 0) {
    return;
  }

  const archiveLogPath = getSessionArchiveLogPath(session.id);
  await fs.ensureDir(path.dirname(archiveLogPath));
  await ensureSessionBranch(session.id);

  const records: ArchiveMessageRecord[] = [];
  const lines: string[] = [];
  for (const message of messages) {
    const record = await buildArchiveRecord(session, message);
    records.push(record as ArchiveMessageRecord);
    lines.push(JSON.stringify(record));
  }

  await fs.appendFile(archiveLogPath, `${lines.join('\n')}\n`);
  await writeArchiveMessages(records);
  await refreshSessionArchiveImportState(session.id, 'messages');
}

export async function readArchiveMessages(sessionId: string): Promise<ArchiveMessageRecord[]> {
  return readEffectiveArchiveMessages(sessionId);
}

export async function readLocalArchiveMessages(sessionId: string): Promise<ArchiveMessageRecord[]> {
  return readLocalArchiveMessagesFromStore(sessionId);
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
