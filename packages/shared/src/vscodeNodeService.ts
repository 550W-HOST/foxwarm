import fs from 'fs-extra';
import path from 'path';
import { spawn } from 'child_process';

export const VSCODE_NODE_SERVICE_VERSIONS = {
  'vscode-fs': 1,
  'vscode-git': 1,
} as const;

export type VscodeNodeServiceName = keyof typeof VSCODE_NODE_SERVICE_VERSIONS;

export class VscodeNodeServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'VscodeNodeServiceError';
  }
}

const MAX_READ_BYTES = 50 * 1024 * 1024;
const MAX_WRITE_BYTES = 50 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_GIT_CONTENT_BYTES = 10 * 1024 * 1024;

const VSCODE_FILE_TYPE = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const;

function normalizeAbsolutePath(value: unknown, name = 'path'): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new VscodeNodeServiceError('InvalidPath', `${name} is required.`);
  }
  if (value.includes('\0')) {
    throw new VscodeNodeServiceError('InvalidPath', `${name} must not contain NUL bytes.`);
  }
  if (!path.isAbsolute(value)) {
    throw new VscodeNodeServiceError('InvalidPath', `${name} must be an absolute path.`);
  }
  return path.resolve(value);
}

function normalizeGitRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new VscodeNodeServiceError('InvalidPath', 'path is required.');
  }
  if (value.includes('\0')) {
    throw new VscodeNodeServiceError('InvalidPath', 'path must not contain NUL bytes.');
  }
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    throw new VscodeNodeServiceError('InvalidPath', 'path must be relative to the repository.');
  }
  return normalized;
}

function resolveWorkspaceChild(workspace: string, relativePath: string): string {
  const fullPath = path.resolve(workspace, relativePath);
  const relative = path.relative(workspace, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new VscodeNodeServiceError('InvalidPath', 'path escapes the repository.');
  }
  return fullPath;
}

function parseBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function toFileType(stat: fs.Stats, lstat: fs.Stats): number {
  let type = stat.isDirectory() ? VSCODE_FILE_TYPE.Directory : stat.isFile() ? VSCODE_FILE_TYPE.File : VSCODE_FILE_TYPE.Unknown;
  if (lstat.isSymbolicLink()) type |= VSCODE_FILE_TYPE.SymbolicLink;
  return type;
}

function toFileStat(stat: fs.Stats, lstat: fs.Stats) {
  return {
    type: toFileType(stat, lstat),
    ctime: stat.ctimeMs,
    mtime: stat.mtimeMs,
    size: stat.size,
    permissions: (stat.mode & 0o200) === 0 ? 1 : undefined,
  };
}

function mapFsError(error: any, targetPath: string): never {
  if (error instanceof VscodeNodeServiceError) throw error;
  switch (error?.code) {
    case 'ENOENT': throw new VscodeNodeServiceError('FileNotFound', `File not found: ${targetPath}`, 404);
    case 'EEXIST': throw new VscodeNodeServiceError('FileExists', `Path already exists: ${targetPath}`, 409);
    case 'ENOTDIR': throw new VscodeNodeServiceError('FileNotADirectory', `Path is not a directory: ${targetPath}`);
    case 'EISDIR': throw new VscodeNodeServiceError('FileIsADirectory', `Path is a directory: ${targetPath}`);
    case 'EACCES':
    case 'EPERM': throw new VscodeNodeServiceError('NoPermissions', `Permission denied: ${targetPath}`, 403);
    case 'ENOTEMPTY': throw new VscodeNodeServiceError('DirectoryNotEmpty', `Directory is not empty: ${targetPath}`, 409);
    default: throw error;
  }
}

async function getExistingStats(targetPath: string): Promise<{ stat: fs.Stats; lstat: fs.Stats }> {
  try {
    const lstat = await fs.lstat(targetPath);
    const stat = lstat.isSymbolicLink() ? await fs.stat(targetPath) : lstat;
    return { stat, lstat };
  } catch (error) {
    return mapFsError(error, targetPath);
  }
}

async function assertParentDirectory(targetPath: string): Promise<void> {
  const parent = path.dirname(targetPath);
  const { stat } = await getExistingStats(parent);
  if (!stat.isDirectory()) throw new VscodeNodeServiceError('FileNotADirectory', `Parent is not a directory: ${parent}`);
}

async function executeFsOperation(operation: string, args: Record<string, unknown>): Promise<any> {
  const targetPath = normalizeAbsolutePath(args.path);
  try {
    switch (operation) {
      case 'stat': {
        const { stat, lstat } = await getExistingStats(targetPath);
        return toFileStat(stat, lstat);
      }
      case 'read-directory': {
        const { stat } = await getExistingStats(targetPath);
        if (!stat.isDirectory()) throw new VscodeNodeServiceError('FileNotADirectory', `Path is not a directory: ${targetPath}`);
        const dirents = await fs.readdir(targetPath, { withFileTypes: true });
        const entries = await Promise.all(dirents.map(async (dirent) => {
          const childPath = path.join(targetPath, dirent.name);
          try {
            const child = await getExistingStats(childPath);
            return { name: dirent.name, type: toFileType(child.stat, child.lstat) };
          } catch {
            return { name: dirent.name, type: dirent.isDirectory() ? VSCODE_FILE_TYPE.Directory : dirent.isFile() ? VSCODE_FILE_TYPE.File : VSCODE_FILE_TYPE.Unknown };
          }
        }));
        return { entries };
      }
      case 'read-file': {
        const { stat } = await getExistingStats(targetPath);
        if (!stat.isFile()) throw new VscodeNodeServiceError('FileIsADirectory', `Path is not a file: ${targetPath}`);
        if (stat.size > MAX_READ_BYTES) throw new VscodeNodeServiceError('PayloadTooLarge', `File exceeds ${MAX_READ_BYTES} bytes: ${targetPath}`, 413);
        return { contentBase64: (await fs.readFile(targetPath)).toString('base64') };
      }
      case 'write-file': {
        const contentBase64 = typeof args.contentBase64 === 'string' ? args.contentBase64 : '';
        const content = Buffer.from(contentBase64, 'base64');
        if (content.length > MAX_WRITE_BYTES) throw new VscodeNodeServiceError('PayloadTooLarge', `Write exceeds ${MAX_WRITE_BYTES} bytes: ${targetPath}`, 413);
        const create = parseBoolean(args.create);
        const overwrite = parseBoolean(args.overwrite);
        await assertParentDirectory(targetPath);
        const exists = await fs.pathExists(targetPath);
        if (!exists && !create) throw new VscodeNodeServiceError('FileNotFound', `File not found: ${targetPath}`, 404);
        if (exists) {
          const { stat } = await getExistingStats(targetPath);
          if (stat.isDirectory()) throw new VscodeNodeServiceError('FileIsADirectory', `Path is a directory: ${targetPath}`);
          if (create && !overwrite) throw new VscodeNodeServiceError('FileExists', `File already exists: ${targetPath}`, 409);
        }
        await fs.writeFile(targetPath, content, { flag: overwrite ? 'w' : (exists ? 'w' : 'wx') });
        const result = await getExistingStats(targetPath);
        return { success: true, stat: toFileStat(result.stat, result.lstat) };
      }
      case 'create-directory': {
        await assertParentDirectory(targetPath);
        if (await fs.pathExists(targetPath)) throw new VscodeNodeServiceError('FileExists', `Path already exists: ${targetPath}`, 409);
        await fs.mkdir(targetPath);
        const result = await getExistingStats(targetPath);
        return { success: true, stat: toFileStat(result.stat, result.lstat) };
      }
      case 'delete': {
        const { stat } = await getExistingStats(targetPath);
        if (stat.isDirectory()) await fs.rm(targetPath, { recursive: parseBoolean(args.recursive), force: false });
        else await fs.unlink(targetPath);
        return { success: true };
      }
      case 'rename': {
        const newPath = normalizeAbsolutePath(args.newPath, 'newPath');
        await getExistingStats(targetPath);
        await assertParentDirectory(newPath);
        const destinationExists = await fs.pathExists(newPath);
        if (destinationExists && !parseBoolean(args.overwrite)) throw new VscodeNodeServiceError('FileExists', `Destination exists: ${newPath}`, 409);
        if (destinationExists) await fs.rm(newPath, { recursive: true, force: true });
        await fs.rename(targetPath, newPath);
        return { success: true };
      }
      default: throw new VscodeNodeServiceError('UnsupportedOperation', `Unsupported vscode-fs operation: ${operation}`);
    }
  } catch (error) {
    return mapFsError(error, targetPath);
  }
}

function runGit(workspace: string, args: string[], options: { maxStdoutBytes?: number; timeoutMs?: number; safeDirectory?: string } = {}): Promise<Buffer> {
  const maxStdoutBytes = options.maxStdoutBytes ?? MAX_GIT_OUTPUT_BYTES;
  const timeoutMs = options.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-c', `safe.directory=${options.safeDirectory ?? workspace}`, '-C', workspace, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!settled) { settled = true; reject(new VscodeNodeServiceError('GitError', `git ${args[0] || ''} timed out.`, 422)); }
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        child.kill('SIGKILL');
        if (!settled) { settled = true; clearTimeout(timer); reject(new VscodeNodeServiceError('PayloadTooLarge', `Git output exceeds ${maxStdoutBytes} bytes.`, 413)); }
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderrChunks.push(chunk);
    });
    child.on('error', (error) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new VscodeNodeServiceError('GitError', error.message, 422)); }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) { resolve(Buffer.concat(stdoutChunks)); return; }
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      reject(new VscodeNodeServiceError('GitError', stderr || `git ${args[0] || ''} failed with exit code ${code}.`, 422));
    });
  });
}

type GitStatusChange = {
  path: string;
  oldPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
  kind: string;
  submoduleState?: string;
  submodule?: { headOid: string; indexOid: string; worktreeOid?: string; dirty: boolean };
};

function classifyGitStatus(indexStatus: string, workingTreeStatus: string, oldPath?: string): string {
  const xy = `${indexStatus}${workingTreeStatus}`;
  if (xy.includes('U')) return 'conflicted';
  if (oldPath || xy.includes('R')) return 'renamed';
  if (xy === '??') return 'untracked';
  if (xy.includes('A')) return 'added';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('M') || xy.includes('T') || xy.includes('C')) return 'modified';
  return 'unknown';
}

function parseGitStatus(raw: Buffer): GitStatusChange[] {
  const records = raw.toString('utf8').split('\0').filter(Boolean);
  const changes: GitStatusChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith('? ')) {
      changes.push({ path: record.slice(2), indexStatus: '?', workingTreeStatus: '?', kind: 'untracked' });
      continue;
    }
    if (record.startsWith('! ')) continue;
    if (!record.startsWith('1 ') && !record.startsWith('2 ')) continue;
    const renamed = record.startsWith('2 ');
    const parts = record.split(' ');
    const xy = parts[1] || '..';
    const submoduleState = parts[2] || 'N...';
    const relativePath = parts.slice(renamed ? 9 : 8).join(' ');
    const oldPath = renamed ? records[index + 1] : undefined;
    if (renamed && oldPath !== undefined) index += 1;
    if (!relativePath) continue;
    changes.push({
      path: relativePath,
      ...(oldPath ? { oldPath } : {}),
      indexStatus: xy[0] || '.',
      workingTreeStatus: xy[1] || '.',
      kind: classifyGitStatus(xy[0] || '.', xy[1] || '.', oldPath),
      ...(submoduleState.startsWith('S') ? {
        submoduleState,
        submodule: {
          headOid: parts[6] || '',
          indexOid: parts[7] || '',
          dirty: submoduleState.slice(2).includes('M') || submoduleState.slice(2).includes('U'),
        },
      } : {}),
    });
  }
  return changes;
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function readSmallTextFile(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return undefined;
    return (await fs.readFile(filePath, 'utf8')).trim();
  } catch {
    return undefined;
  }
}

async function readGitHeadOid(worktreePath: string): Promise<string | undefined> {
  const dotGitPath = path.join(worktreePath, '.git');
  let gitDirectory: string;
  try {
    const stat = await fs.stat(dotGitPath);
    if (stat.isDirectory()) gitDirectory = dotGitPath;
    else if (stat.isFile()) {
      const pointer = await readSmallTextFile(dotGitPath);
      const match = pointer?.match(/^gitdir:\s*(.+)$/i);
      if (!match) return undefined;
      gitDirectory = path.resolve(worktreePath, match[1]);
    } else return undefined;
  } catch {
    return undefined;
  }
  const head = await readSmallTextFile(path.join(gitDirectory, 'HEAD'));
  if (!head) return undefined;
  if (/^[0-9a-f]{40,64}$/i.test(head)) return head.toLowerCase();
  const match = head.match(/^ref:\s*(refs\/.+)$/);
  if (!match) return undefined;
  const refName = path.posix.normalize(match[1].replace(/\\/g, '/'));
  if (!refName.startsWith('refs/') || refName.includes('../')) return undefined;
  const loosePath = path.resolve(gitDirectory, ...refName.split('/'));
  if (!isPathInside(gitDirectory, loosePath)) return undefined;
  const loose = await readSmallTextFile(loosePath);
  if (loose && /^[0-9a-f]{40,64}$/i.test(loose)) return loose.toLowerCase();
  const packed = await readSmallTextFile(path.join(gitDirectory, 'packed-refs'));
  if (!packed) return undefined;
  for (const line of packed.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const separator = line.indexOf(' ');
    if (separator < 1 || line.slice(separator + 1) !== refName) continue;
    const oid = line.slice(0, separator);
    return /^[0-9a-f]{40,64}$/i.test(oid) ? oid.toLowerCase() : undefined;
  }
  return undefined;
}

async function enrichSubmodules(topLevel: string, changes: GitStatusChange[]): Promise<GitStatusChange[]> {
  return Promise.all(changes.map(async (change) => {
    if (!change.submodule) return change;
    const worktreeOid = await readGitHeadOid(resolveWorkspaceChild(topLevel, normalizeGitRelativePath(change.path)));
    return { ...change, submodule: { ...change.submodule, ...(worktreeOid ? { worktreeOid } : {}) } };
  }));
}

async function executeGitOperation(operation: string, args: Record<string, unknown>): Promise<any> {
  const workspace = normalizeAbsolutePath(args.workspace, 'workspace');
  if (operation === 'status') {
    const topLevel = (await runGit(workspace, ['rev-parse', '--show-toplevel'], { maxStdoutBytes: 1024 * 1024, safeDirectory: '*' })).toString('utf8').trim();
    const raw = await runGit(topLevel, ['status', '--porcelain=v2', '-z', '-uall']);
    return { workspace: topLevel, topLevel, changes: await enrichSubmodules(topLevel, parseGitStatus(raw)) };
  }
  if (operation === 'content') {
    const relativePath = normalizeGitRelativePath(args.path);
    const side = args.side === 'working' ? 'working' : args.side === 'base' ? 'base' : undefined;
    if (!side) throw new VscodeNodeServiceError('InvalidPath', 'side must be `base` or `working`.');
    let content: Buffer;
    if (side === 'working') {
      const fullPath = resolveWorkspaceChild(workspace, relativePath);
      try {
        const stat = await fs.stat(fullPath);
        if (!stat.isFile()) content = Buffer.alloc(0);
        else {
          if (stat.size > MAX_GIT_CONTENT_BYTES) throw new VscodeNodeServiceError('PayloadTooLarge', `File exceeds ${MAX_GIT_CONTENT_BYTES} bytes: ${fullPath}`, 413);
          content = await fs.readFile(fullPath);
        }
      } catch (error: any) {
        if (error instanceof VscodeNodeServiceError) throw error;
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') content = Buffer.alloc(0);
        else throw error;
      }
    } else {
      const ref = typeof args.ref === 'string' && args.ref ? args.ref : 'HEAD';
      try {
        content = await runGit(workspace, ['show', `${ref}:${relativePath}`], { maxStdoutBytes: MAX_GIT_CONTENT_BYTES });
      } catch (error) {
        if (error instanceof VscodeNodeServiceError && error.code === 'GitError') content = Buffer.alloc(0);
        else throw error;
      }
    }
    return { contentBase64: content.toString('base64') };
  }
  throw new VscodeNodeServiceError('UnsupportedOperation', `Unsupported vscode-git operation: ${operation}`);
}

export async function executeVscodeNodeService(service: VscodeNodeServiceName, operation: string, args: Record<string, unknown>): Promise<any> {
  if (service === 'vscode-fs') return executeFsOperation(operation, args);
  if (service === 'vscode-git') return executeGitOperation(operation, args);
  throw new VscodeNodeServiceError('UnsupportedService', `Unsupported node service: ${service}`);
}

export function serializeVscodeNodeServiceError(error: unknown): { code: string; message: string; statusCode: number } {
  if (error instanceof VscodeNodeServiceError) return { code: error.code, message: error.message, statusCode: error.statusCode };
  const value = error as any;
  return { code: 'Unknown', message: value?.message || String(error), statusCode: 500 };
}
