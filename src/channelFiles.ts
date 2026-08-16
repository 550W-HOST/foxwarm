import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import * as sessionManager from './sessionManager';
import { getAgentDir } from './config';
import { nodesManager } from './nodes/manager';
import { buildFoxwarmAttachmentText } from '../packages/shared/dist/foxwarmMarkup';

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

  const session = sessionManager.getSessionCatalog(sessionId);
  return session?.agent || 'main';
}

async function resolveInboundSession(platform: string, channelUserId?: string, sessionId?: string) {
  if (typeof sessionId === 'string' && sessionId.trim()) {
    return sessionManager.getSessionCatalog(sessionId.trim()) || null;
  }

  if (!channelUserId) {
    return null;
  }

  const resolvedSessionId = sessionManager.getSessionByChannel(platform, channelUserId);
  if (!resolvedSessionId) {
    return null;
  }

  return sessionManager.getSessionCatalog(resolvedSessionId) || null;
}

export async function isInboundSessionMainHosted(sessionId: string, platform = 'qqbot'): Promise<boolean> {
  const session = await resolveInboundSession(platform, undefined, sessionId);
  if (!session) return true;
  return resolveInboundTargetNode(session, session.agent || 'main') === 'master';
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

type InboundSaveOptions = {
  platform: string;
  fileName?: string;
  mimeType?: string;
  isImage?: boolean;
  session?: any;
};

type PreparedInboundFile = InboundSaveOptions & {
  agentName: string;
  nodeId: string;
  mimeType: string;
  isImage: boolean;
  storedFileName: string;
  paths: ReturnType<typeof buildInboundStoragePaths>;
};

function prepareInboundFile(options: InboundSaveOptions): PreparedInboundFile {
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

  return { ...options, agentName, nodeId, mimeType, isImage, storedFileName, paths };
}

function finishInboundFile(prepared: PreparedInboundFile, sizeBytes: number, absolutePath: string, promptPath: string): SavedChannelFile {
  return {
    agentName: prepared.agentName,
    nodeId: prepared.nodeId,
    absolutePath,
    relativePath: prepared.paths.relativePath,
    promptPath,
    fileName: prepared.fileName || prepared.storedFileName,
    mimeType: prepared.mimeType,
    sizeBytes,
    isImage: prepared.isImage,
  };
}

async function saveInboundFile(options: InboundSaveOptions & { buffer: Buffer }): Promise<SavedChannelFile> {
  const prepared = prepareInboundFile(options);

  let absolutePath = prepared.paths.absolutePath;
  let promptPath = prepared.paths.promptPath;

  if (prepared.nodeId === 'master') {
    await fs.ensureDir(path.dirname(prepared.paths.writePath));
    const tempPath = `${prepared.paths.writePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tempPath, options.buffer, { flag: 'wx' });
      await fs.rename(tempPath, prepared.paths.writePath);
    } finally {
      await fs.remove(tempPath).catch(() => {});
    }
  } else {
    if (!options.session?.id) {
      throw new Error('Session context is required when saving inbound files to a remote node.');
    }
    const writeResult = await nodesManager.writeFileToNode(prepared.nodeId, prepared.paths.writePath, options.buffer.toString('base64'), false, options.session.id);
    absolutePath = writeResult.absolutePath || prepared.paths.absolutePath;
    promptPath = absolutePath;
  }

  return finishInboundFile(prepared, options.buffer.length, absolutePath, promptPath);
}

async function saveInboundFileFromPath(options: InboundSaveOptions & { sourcePath: string; sizeBytes: number }): Promise<SavedChannelFile> {
  const prepared = prepareInboundFile(options);
  const sourceStats = await fs.lstat(options.sourcePath);
  if (!sourceStats.isFile()) {
    throw new Error('Inbound media spool is not a regular file.');
  }
  if (prepared.nodeId !== 'master') {
    throw new Error('Inbound media cannot be saved to an isolated node: the existing node file transfer is whole-buffer only and has no bounded streaming boundary.');
  }

  await fs.ensureDir(path.dirname(prepared.paths.writePath));
  const tempPath = `${prepared.paths.writePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.copyFile(options.sourcePath, tempPath, fs.constants.COPYFILE_EXCL);
    await fs.rename(tempPath, prepared.paths.writePath);
  } finally {
    await fs.remove(tempPath).catch(() => {});
  }
  return finishInboundFile(prepared, sourceStats.size, prepared.paths.absolutePath, prepared.paths.promptPath);
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

export async function saveInboundSessionFileFromPath(options: {
  sessionId: string;
  platform: string;
  sourcePath: string;
  sizeBytes: number;
  fileName?: string;
  mimeType?: string;
  isImage?: boolean;
}): Promise<SavedChannelFile> {
  const session = await resolveInboundSession(options.platform, undefined, options.sessionId);
  return saveInboundFileFromPath({
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

export function buildSavedFileText(saved: SavedChannelFile, kind: 'image' | 'file', extraText?: string): string {
  return buildFoxwarmAttachmentText({
    kind,
    name: saved.fileName,
    node: saved.nodeId,
    path: saved.promptPath,
    mime: saved.mimeType,
  }, extraText);
}
