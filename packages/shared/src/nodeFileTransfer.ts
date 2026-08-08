import crypto from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

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
  absolutePath?: string;
  sizeBytes: number;
  sha256: string;
  overwritten: boolean;
}

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
};

const GENERIC_MIME: Record<string, string> = {
  '.json': 'application/json', '.txt': 'text/plain', '.md': 'text/markdown', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.ts': 'text/plain', '.js': 'text/plain', '.sh': 'text/plain',
};

function expandHomePath(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

export function getNodeAgentDir(agentName = 'main'): string {
  const explicit = process.env.FOXWARM_AGENT_DIR?.trim();
  if (explicit) return path.resolve(expandHomePath(explicit));
  const agentsDir = process.env.FOXWARM_AGENTS_DIR?.trim();
  if (agentsDir) return path.resolve(expandHomePath(agentsDir), agentName);
  return path.resolve(process.cwd(), 'agents', agentName);
}

export function resolveNodePath(filePath: string, agentName = 'main', sessionCwd?: string): string {
  if (!filePath || typeof filePath !== 'string') throw new Error('filePath is required');
  const expandedPath = expandHomePath(filePath);
  if (path.isAbsolute(expandedPath)) return path.resolve(expandedPath);
  const base = typeof sessionCwd === 'string' && sessionCwd.trim() ? expandHomePath(sessionCwd.trim()) : getNodeAgentDir(agentName);
  return path.resolve(base, expandedPath);
}

export function resolveNodeTransferPath(filePath: string, agentName: string, restrictToAgentDir = true): string {
  const agentDir = getNodeAgentDir(agentName);
  const resolved = resolveNodePath(filePath, agentName);
  if (restrictToAgentDir && !(resolved === agentDir || resolved.startsWith(agentDir + path.sep))) {
    throw new Error('Path traversal detected: cannot access files outside agent folder');
  }
  return resolved;
}

export function detectTransferMimeType(filePath: string): { mimeType: string; isImage: boolean } {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_MIME[ext]) return { mimeType: IMAGE_MIME[ext], isImage: true };
  return { mimeType: GENERIC_MIME[ext] || 'application/octet-stream', isImage: false };
}

export async function readNodeTransferFile(filePath: string, agentName: string, restrictToAgentDir = true): Promise<NodeTransferFilePayload> {
  const fullPath = resolveNodeTransferPath(filePath, agentName, restrictToAgentDir);
  const stats = await fs.stat(fullPath);
  if (!stats.isFile()) throw new Error(`Not a file: ${filePath}`);
  const buffer = await fs.readFile(fullPath);
  const { mimeType, isImage } = detectTransferMimeType(filePath);
  return { filePath, name: path.basename(filePath), sizeBytes: buffer.length, mimeType, isImage, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), dataBase64: buffer.toString('base64') };
}

export async function writeNodeTransferFile(filePath: string, agentName: string, dataBase64: string, overwrite = false, restrictToAgentDir = true): Promise<NodeTransferWriteResult> {
  if (typeof dataBase64 !== 'string') throw new Error('dataBase64 is required');
  const fullPath = resolveNodeTransferPath(filePath, agentName, restrictToAgentDir);
  const exists = await fs.pathExists(fullPath);
  if (exists && !overwrite) throw new Error(`File already exists: ${filePath}. Use overwrite=true to replace it.`);
  const buffer = Buffer.from(dataBase64, 'base64');
  await fs.ensureDir(path.dirname(fullPath));
  const tempPath = `${fullPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tempPath, buffer, { flag: 'wx' });
    if (overwrite) {
      await fs.rename(tempPath, fullPath);
    } else {
      // A hard-link publish is atomic and preserves the no-overwrite contract
      // even if another writer creates the destination after the initial check.
      await fs.link(tempPath, fullPath);
      await fs.remove(tempPath);
    }
  } finally {
    await fs.remove(tempPath).catch(() => {});
  }
  return { filePath, absolutePath: fullPath, sizeBytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex'), overwritten: exists };
}
