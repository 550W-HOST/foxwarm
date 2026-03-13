import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import * as sessionManager from './sessionManager';
import { getAgentDir } from './config';

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
  absolutePath: string;
  relativePath: string;
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

export async function saveInboundChannelFile(options: {
  platform: string;
  channelUserId: string;
  buffer: Buffer;
  fileName?: string;
  mimeType?: string;
  isImage?: boolean;
}): Promise<SavedChannelFile> {
  const agentName = await resolveChannelAgentName(options.platform, options.channelUserId);
  const agentDir = getAgentDir(agentName);
  const tempDir = path.join(agentDir, '.temp', 'channel-files', sanitizeSegment(options.platform));
  await fs.ensureDir(tempDir);

  const mimeType = options.mimeType || 'application/octet-stream';
  const isImage = options.isImage ?? mimeType.startsWith('image/');
  const originalBase = options.fileName ? path.basename(options.fileName, path.extname(options.fileName)) : 'upload';
  const ext = getExtension(options.fileName, mimeType);
  const safeBase = sanitizeSegment(originalBase).slice(0, 80) || 'upload';
  const fileName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}-${safeBase}${ext}`;
  const absolutePath = path.join(tempDir, fileName);

  await fs.writeFile(absolutePath, options.buffer);

  const relativePath = path.relative(agentDir, absolutePath) || path.basename(absolutePath);
  return {
    agentName,
    absolutePath,
    relativePath,
    fileName: options.fileName || fileName,
    mimeType,
    sizeBytes: options.buffer.length,
    isImage,
  };
}

function prependMessageDescriptor(text: string | undefined, descriptor: string): string {
  if (text && text.trim()) {
    return `${text.trim()}\n\n${descriptor}`;
  }
  return descriptor;
}

export function buildSavedFileText(saved: SavedChannelFile, kind: 'image' | 'file', extraText?: string): string {
  const label = kind === 'image' ? 'Image' : 'File';
  const descriptor = `[${label}: ${saved.fileName}]\nPath: ${saved.relativePath}` + (kind === 'file' ? `\nMIME: ${saved.mimeType}` : '');
  return prependMessageDescriptor(extraText, descriptor);
}
