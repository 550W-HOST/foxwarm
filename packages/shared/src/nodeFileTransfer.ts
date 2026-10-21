import crypto from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { fileOperationPathExists, readWholeFile, type FileOperations } from './fileOperations';
import { writeFileToolPath } from './fileToolCore';
import { expandAgentPathVariable } from './agentPathVariables';

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

// A node's filesystem root belongs to the node process, not to an individual
// session cwd. Capture it once so a later process.chdir() cannot relocate
// agent-owned state into whichever project a session is currently using.
const NODE_RUNTIME_ROOT = path.resolve(process.cwd());

export function resolveNodeAgentDir(
  agentName = 'main',
  env: NodeJS.ProcessEnv = process.env,
  nodeRuntimeRoot: string = NODE_RUNTIME_ROOT,
): string {
  const root = path.resolve(nodeRuntimeRoot);
  const explicit = env.FOXWARM_AGENT_DIR?.trim();
  if (explicit) return path.resolve(root, expandHomePath(explicit));
  const agentsDir = env.FOXWARM_AGENTS_DIR?.trim();
  if (agentsDir) return path.resolve(root, expandHomePath(agentsDir), agentName);
  return path.resolve(root, 'agents', agentName);
}

export function getNodeAgentDir(agentName = 'main'): string {
  return resolveNodeAgentDir(agentName);
}

export function resolveNodePath(filePath: string, agentName = 'main', sessionCwd?: string): string {
  if (!filePath || typeof filePath !== 'string') throw new Error('filePath is required');
  const expandedPath = expandHomePath(expandAgentPathVariable(filePath, getNodeAgentDir(agentName)));
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

/** Bound each primitive request, not the size of the complete existing transfer. */
export const NODE_TRANSFER_CHUNK_BYTES = 1024 * 1024;

export function buildNodeTransferFilePayload(filePath: string, bytes: Buffer, name = path.basename(filePath)): NodeTransferFilePayload {
  const { mimeType, isImage } = detectTransferMimeType(filePath);
  return { filePath, name, sizeBytes: bytes.length, mimeType, isImage,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), dataBase64: bytes.toString('base64') };
}

export function buildNodeTransferWriteResult(filePath: string, bytes: Buffer, overwritten: boolean, absolutePath?: string): NodeTransferWriteResult {
  return { filePath, ...(absolutePath !== undefined ? { absolutePath } : {}), sizeBytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), overwritten };
}

/** Target paths and parent resolution belong to the filesystem, never the Main host. */
export async function readPrimitiveTransferFile(filePath: string, operations: FileOperations): Promise<NodeTransferFilePayload> {
  const stat = await operations.stat(filePath);
  if (stat.kind !== 'file') throw new Error(`Not a file: ${filePath}`);
  const bytes = await readWholeFile(operations, filePath, NODE_TRANSFER_CHUNK_BYTES);
  if (bytes.length !== stat.size) throw new Error('Source file changed or the filesystem returned incomplete data.');
  return buildNodeTransferFilePayload(filePath, bytes, filePath.split(/[\\/]/).pop() || filePath);
}

/** A later failed chunk leaves its written prefix; no automatic replay or rollback. */
export async function writePrimitiveTransferFile(filePath: string, bytes: Buffer, overwrite: boolean,
  operations: FileOperations, parent: (filePath: string) => Promise<string>): Promise<NodeTransferWriteResult> {
  const existed = await fileOperationPathExists(operations, filePath);
  const existsMessage = `File already exists: ${filePath}. Use overwrite=true to replace it.`;
  if (existed && !overwrite) throw new Error(existsMessage);
  const parentPath = await parent(filePath);
  await writeFileToolPath(filePath, bytes.subarray(0, NODE_TRANSFER_CHUNK_BYTES),
    { overwrite, createDirs: true, parentPath, existsMessage }, operations);
  for (let offset = NODE_TRANSFER_CHUNK_BYTES; offset < bytes.length; offset += NODE_TRANSFER_CHUNK_BYTES) {
    await operations.write(filePath, bytes.subarray(offset, offset + NODE_TRANSFER_CHUNK_BYTES), 'a');
  }
  return buildNodeTransferWriteResult(filePath, bytes, existed);
}

export async function readNodeTransferFile(filePath: string, agentName: string, restrictToAgentDir = true): Promise<NodeTransferFilePayload> {
  const fullPath = resolveNodeTransferPath(filePath, agentName, restrictToAgentDir);
  const stats = await fs.stat(fullPath);
  if (!stats.isFile()) throw new Error(`Not a file: ${filePath}`);
  const buffer = await fs.readFile(fullPath);
  return buildNodeTransferFilePayload(filePath, buffer);
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
  return buildNodeTransferWriteResult(filePath, buffer, exists, fullPath);
}
