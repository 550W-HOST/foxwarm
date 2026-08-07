import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import * as sessionManager from './sessionManager';
import { getAgentDir } from './config';
import { nodesManager } from './nodes/manager';

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/json': '.json',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/x-tar': '.tar',
};

export interface SavedChannelFile {
  agentName: string;
  nodeId: string;
  absolutePath: string;
  relativePath?: string;
  promptPath: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  isImage: boolean;
}

function sanitizeSegment(input: string): string {
  const trimmed = input.trim();
  const replaced = trimmed.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^\.+/, '');
  return replaced || 'file';
}

function getExtension(fileName: string | undefined, mimeType: string): string {
  const providedExt = fileName ? path.extname(fileName) : '';
  if (providedExt) {
    return providedExt.slice(0, 16);
  }
  return EXT_BY_MIME[mimeType] || '';
}

export async function resolveChannelAgentName(platform: string, channelUserId: string): Promise<string> {
  const sessionId = sessionManager.getSessionByChannel(platform, channelUserId);
  if (!sessionId) {
    return 'main';
  }

  const session = await sessionManager.getExistingSession(sessionId);
  return session?.agent || 'main';
}

async function resolveInboundSession(platform: string, channelUserId?: string, sessionId?: string) {
  if (typeof sessionId === 'string' && sessionId.trim()) {
    return await sessionManager.getExistingSession(sessionId.trim());
  }

  if (!channelUserId) {
    return null;
  }

  const resolvedSessionId = sessionManager.getSessionByChannel(platform, channelUserId);
  if (!resolvedSessionId) {
    return null;
  }

  return await sessionManager.getExistingSession(resolvedSessionId);
}

function resolveInboundTargetNode(session: any, agentName: string): string {
  if (!sessionManager.isSessionEffectivelyIsolated(session)) {
    return 'master';
  }

  const currentNode = typeof session?.currentNode === 'string' && session.currentNode.trim()
    ? session.currentNode.trim()
    : undefined;
  const isolatedNode = sessionManager.getAgentIsolationNode(agentName);

  if (currentNode && currentNode !== 'master') {
    return currentNode;
  }

  return isolatedNode || currentNode || 'master';
}

function buildInboundStoragePaths(options: {
  agentName: string;
  platform: string;
  fileName: string;
  nodeId: string;
}): { writePath: string; absolutePath: string; relativePath?: string; promptPath: string } {
  const relativePath = path.join('.temp', 'channel-files', sanitizeSegment(options.platform), options.fileName);

  if (options.nodeId === 'master') {
    const absolutePath = path.join(getAgentDir(options.agentName), relativePath);
    return {
      writePath: absolutePath,
      absolutePath,
      relativePath,
      promptPath: absolutePath,
    };
  }

  return {
    writePath: relativePath,
    absolutePath: relativePath,
    relativePath,
    promptPath: relativePath,
  };
}

async function saveInboundFile(options: {
  platform: string;
  buffer: Buffer;
  fileName?: string;
  mimeType?: string;
  isImage?: boolean;
  session?: any;
}): Promise<SavedChannelFile> {
  const agentName = options.session?.agent || 'main';
  const nodeId = resolveInboundTargetNode(options.session, agentName);

  const mimeType = options.mimeType || 'application/octet-stream';
  const isImage = options.isImage ?? mimeType.startsWith('image/');
  const originalBase = options.fileName ? path.basename(options.fileName, path.extname(options.fileName)) : 'upload';
  const ext = getExtension(options.fileName, mimeType);
  const safeBase = sanitizeSegment(originalBase).slice(0, 80) || 'upload';
  const storedFileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}-${safeBase}${ext}`;
  const paths = buildInboundStoragePaths({
    agentName,
    platform: options.platform,
    fileName: storedFileName,
    nodeId,
  });

  let absolutePath = paths.absolutePath;
  let promptPath = paths.promptPath;

  if (nodeId === 'master') {
    await fs.ensureDir(path.dirname(paths.writePath));
    const tempPath = `${paths.writePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tempPath, options.buffer, { flag: 'wx' });
      await fs.rename(tempPath, paths.writePath);
    } finally {
      await fs.remove(tempPath).catch(() => {});
    }
  } else {
    if (!options.session?.id) {
      throw new Error('Session context is required when saving inbound files to a remote node.');
    }
    const writeResult = await nodesManager.writeFileToNode(nodeId, paths.writePath, options.buffer.toString('base64'), false, options.session.id);
    absolutePath = writeResult.absolutePath || paths.absolutePath;
    promptPath = absolutePath;
  }

  return {
    agentName,
    nodeId,
    absolutePath,
    relativePath: paths.relativePath,
    promptPath,
    fileName: options.fileName || storedFileName,
    mimeType,
    sizeBytes: options.buffer.length,
    isImage,
  };
}

export async function saveInboundSessionFile(options: {
  sessionId: string;
  platform: string;
  buffer: Buffer;
  fileName?: string;
  mimeType?: string;
  isImage?: boolean;
}): Promise<SavedChannelFile> {
  const session = await resolveInboundSession(options.platform, undefined, options.sessionId);
  return saveInboundFile({
    ...options,
    session,
  });
}

export async function saveInboundChannelFile(options: {
  platform: string;
  channelUserId: string;
  buffer: Buffer;
  fileName?: string;
  mimeType?: string;
  isImage?: boolean;
}): Promise<SavedChannelFile> {
  const session = await resolveInboundSession(options.platform, options.channelUserId);
  return saveInboundFile({
    ...options,
    session,
  });
}

function prependMessageDescriptor(text: string | undefined, descriptor: string): string {
  if (text && text.trim()) {
    return `${text.trim()}\n\n${descriptor}`;
  }
  return descriptor;
}

export function buildSavedFileText(saved: SavedChannelFile, kind: 'image' | 'file', extraText?: string): string {
  const label = kind === 'image' ? 'Image' : 'File';
  const descriptor = `[${label}: ${saved.fileName}]\nNode: ${saved.nodeId}\nPath: ${saved.promptPath}` + (kind === 'file' ? `\nMIME: ${saved.mimeType}` : '');
  return prependMessageDescriptor(extraText, descriptor);
}
