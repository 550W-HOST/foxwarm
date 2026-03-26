import crypto from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { getAgentDir } from './config';

export interface NodeTransferFilePayload {
  filePath: string;
  name: string;
  sizeBytes: number;
  mimeType: string;
  isImage: boolean;
  sha256: string;
  dataBase64: string;
}

export interface NodeTransferWriteResult {
  filePath: string;
  sizeBytes: number;
  sha256: string;
  overwritten: boolean;
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
};

const GENERIC_MIME: Record<string, string> = {
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.ts': 'text/plain',
  '.js': 'text/plain',
  '.sh': 'text/plain',
};

function expandHomePath(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

export function resolveNodeTransferPath(filePath: string, agentName: string, restrictToAgentDir = true): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('filePath is required');
  }

  const agentDir = getAgentDir(agentName);
  const expandedPath = expandHomePath(filePath);
  const resolved = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(agentDir, expandedPath);

  if (restrictToAgentDir && !(resolved === agentDir || resolved.startsWith(agentDir + path.sep))) {
    throw new Error('Path traversal detected: cannot access files outside agent folder');
  }

  return resolved;
}

export function detectTransferMimeType(filePath: string): { mimeType: string; isImage: boolean } {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_MIME[ext]) {
    return { mimeType: IMAGE_MIME[ext], isImage: true };
  }
  return { mimeType: GENERIC_MIME[ext] || 'application/octet-stream', isImage: false };
}

export async function readNodeTransferFile(filePath: string, agentName: string, restrictToAgentDir = true): Promise<NodeTransferFilePayload> {
  const fullPath = resolveNodeTransferPath(filePath, agentName, restrictToAgentDir);
  const stats = await fs.stat(fullPath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const buffer = await fs.readFile(fullPath);
  const { mimeType, isImage } = detectTransferMimeType(filePath);
  return {
    filePath,
    name: path.basename(filePath),
    sizeBytes: buffer.length,
    mimeType,
    isImage,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    dataBase64: buffer.toString('base64'),
  };
}

export async function writeNodeTransferFile(filePath: string, agentName: string, dataBase64: string, overwrite = false, restrictToAgentDir = true): Promise<NodeTransferWriteResult> {
  if (typeof dataBase64 !== 'string') {
    throw new Error('dataBase64 is required');
  }

  const fullPath = resolveNodeTransferPath(filePath, agentName, restrictToAgentDir);
  const exists = await fs.pathExists(fullPath);
  if (exists && !overwrite) {
    throw new Error(`File already exists: ${filePath}. Use overwrite=true to replace it.`);
  }

  const buffer = Buffer.from(dataBase64, 'base64');
  await fs.ensureDir(path.dirname(fullPath));
  await fs.writeFile(fullPath, buffer);

  return {
    filePath,
    sizeBytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    overwritten: exists,
  };
}