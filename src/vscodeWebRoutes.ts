import express from 'express';
import path from 'path';
import fs from 'fs-extra';
import { spawn } from 'child_process';
import crypto from 'crypto';
import type { HttpServer } from './httpServer';
import { BASE_DIR, STATE_DIR } from './config';
import { logger } from './common';
import { nodesManager, NodeServiceRequestError } from './nodes/manager';
import { normalizeVscodeGitContentRef, readVscodeGitCommitDetails, VscodeGitCommitDetailsError, VSCODE_GIT_COMMIT_SERVICE_VERSION } from '../packages/shared/dist/gitCommitDetails';

const VSCODE_WEB_ROUTE = '/vscode-web';
const VSCODE_WEB_API_PREFIX = '/api/vscode-web/fs';
const VSCODE_WEB_GIT_API_PREFIX = '/api/vscode-web/git';
const VSCODE_WEB_STATIC_ROUTE = `${VSCODE_WEB_ROUTE}/static`;
const VSCODE_WEB_FS_EXTENSION_ROUTE = `${VSCODE_WEB_ROUTE}/extensions/foxwarm-fs`;
const VSCODE_WEB_TERMINAL_EXTENSION_ROUTE = `${VSCODE_WEB_ROUTE}/extensions/foxwarm-terminal`;
const VSCODE_WEB_SCM_EXTENSION_ROUTE = `${VSCODE_WEB_ROUTE}/extensions/foxwarm-scm`;
const VSCODE_WEB_WEBUI_EXTENSION_ROUTE = `${VSCODE_WEB_ROUTE}/extensions/foxwarm-webui`;
const VSCODE_WEB_WEBVIEW_RELATIVE_ROUTE = `webview/${crypto.randomBytes(24).toString('hex')}`;
const VSCODE_WEB_WEBVIEW_ROUTE = `${VSCODE_WEB_ROUTE}/${VSCODE_WEB_WEBVIEW_RELATIVE_ROUTE}`;
const VSCODE_WEB_ASSET_DIR_ENV = 'FOXWARM_VSCODE_WEB_ASSET_DIR';
const VSCODE_WEB_DEFAULT_FOLDER_URI_ENV = 'FOXWARM_VSCODE_WEB_DEFAULT_FOLDER_URI';
const VSCODE_WEB_WORKSPACE_PATH_ENV = 'FOXWARM_VSCODE_WEB_WORKSPACE_PATH';
const VSCODE_WEB_WEBVIEW_ORIGIN_ENV = 'FOXWARM_VSCODE_WEB_WEBVIEW_ORIGIN';
const DEFAULT_VSCODE_WEB_ASSET_DIR = path.join(BASE_DIR, 'packages', 'vscode-web', 'assets', 'vscode-web');
const DEFAULT_VSCODE_WEB_WORKSPACE_PATH = path.join(STATE_DIR, 'vscode-web', 'foxwarm.code-workspace');
const MAX_WRITE_BYTES = 50 * 1024 * 1024;
const MAX_READ_BYTES = 50 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_GIT_CONTENT_BYTES = 10 * 1024 * 1024;

const VSCODE_FILE_TYPE = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const;

type FsErrorCode =
  | 'FileNotFound'
  | 'FileExists'
  | 'FileNotADirectory'
  | 'FileIsADirectory'
  | 'NoPermissions'
  | 'Unavailable'
  | 'InvalidPath'
  | 'UnsupportedNode'
  | 'InvalidNode'
  | 'PayloadTooLarge'
  | 'GitError'
  | 'InvalidCommit'
  | 'Unknown';

class VscodeWebFsError extends Error {
  constructor(
    readonly code: FsErrorCode,
    message: string,
    readonly statusCode = statusForErrorCode(code),
  ) {
    super(message);
    this.name = 'VscodeWebFsError';
  }
}

function statusForErrorCode(code: FsErrorCode): number {
  switch (code) {
    case 'FileNotFound':
      return 404;
    case 'FileExists':
      return 409;
    case 'FileNotADirectory':
    case 'FileIsADirectory':
    case 'InvalidPath':
    case 'UnsupportedNode':
    case 'InvalidNode':
      return 400;
    case 'NoPermissions':
      return 403;
    case 'PayloadTooLarge':
      return 413;
    case 'Unavailable':
      return 503;
    case 'GitError':
    case 'InvalidCommit':
      return 422;
    default:
      return 500;
  }
}

function getSingleQueryValue(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === 'string' ? value[0] : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function parseBool(value: unknown): boolean {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  if (typeof value === 'number') return value !== 0;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

function normalizeNodeId(value: unknown): string {
  const nodeId = typeof value === 'string' && value.trim() ? value.trim() : 'master';
  if (!/^[A-Za-z0-9._-]+$/.test(nodeId)) {
    throw new VscodeWebFsError('InvalidNode', `Invalid node id: ${nodeId}`);
  }
  return nodeId;
}

function normalizeRealPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new VscodeWebFsError('InvalidPath', 'path is required.');
  }

  const rawPath = value.trim();
  if (!path.isAbsolute(rawPath)) {
    throw new VscodeWebFsError('InvalidPath', 'path must be an absolute filesystem path.');
  }

  return path.resolve(rawPath);
}

function getRequestTarget(req: express.Request): { nodeId: string; fullPath: string } {
  const nodeId = normalizeNodeId(getSingleQueryValue(req.query.nodeId) ?? req.body?.nodeId);
  const fullPath = normalizeRealPath(getSingleQueryValue(req.query.path) ?? req.body?.path);
  return { nodeId, fullPath };
}

async function getExistingStats(fullPath: string): Promise<{ stat: fs.Stats; lst: fs.Stats }> {
  try {
    const lst = await fs.lstat(fullPath);
    const stat = lst.isSymbolicLink() ? await fs.stat(fullPath) : lst;
    return { stat, lst };
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new VscodeWebFsError('FileNotFound', `File not found: ${fullPath}`);
    }
    throw error;
  }
}

function toVscodeFileType(stat: fs.Stats, lst?: fs.Stats): number {
  let type: number = VSCODE_FILE_TYPE.Unknown;
  if (stat.isFile()) {
    type = VSCODE_FILE_TYPE.File;
  } else if (stat.isDirectory()) {
    type = VSCODE_FILE_TYPE.Directory;
  }
  if (lst?.isSymbolicLink()) {
    type |= VSCODE_FILE_TYPE.SymbolicLink;
  }
  return type;
}

function toFileStat(stat: fs.Stats, lst?: fs.Stats) {
  return {
    type: toVscodeFileType(stat, lst),
    ctime: stat.ctimeMs,
    mtime: stat.mtimeMs,
    size: stat.size,
  };
}

async function assertParentDirectoryExists(fullPath: string): Promise<void> {
  const parentPath = path.dirname(fullPath);
  let parent: fs.Stats;
  try {
    parent = await fs.stat(parentPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new VscodeWebFsError('FileNotFound', `Parent directory not found: ${parentPath}`);
    }
    throw error;
  }
  if (!parent.isDirectory()) {
    throw new VscodeWebFsError('FileNotADirectory', `Parent path is not a directory: ${parentPath}`);
  }
}

async function readRawRequestBody(req: express.Request, maxBytes = MAX_WRITE_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new VscodeWebFsError('PayloadTooLarge', `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function sendFsError(res: express.Response, error: unknown): void {
  if (error instanceof VscodeWebFsError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof NodeServiceRequestError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return;
  }
  const anyError = error as any;
  logger.error({ err: error }, 'VS Code Web filesystem route failed');
  res.status(500).json({ error: anyError?.message || 'Internal Server Error', code: 'Unknown' });
}

async function requestRemoteVscodeService(nodeId: string, service: 'vscode-fs' | 'vscode-git', operation: string, args: Record<string, unknown>, minimumVersion = 1): Promise<any> {
  return nodesManager.requestNodeService(nodeId, service, operation, args, 30_000, minimumVersion);
}

function normalizeWorkspacePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new VscodeWebFsError('InvalidPath', 'workspace is required.');
  }
  const workspace = normalizeRealPath(value);
  return workspace;
}

function normalizeGitRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new VscodeWebFsError('InvalidPath', 'path is required.');
  }
  if (value.includes('\0')) {
    throw new VscodeWebFsError('InvalidPath', 'path must not contain NUL bytes.');
  }
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  if (normalized === '.' || normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
    throw new VscodeWebFsError('InvalidPath', 'path must be a relative path inside the workspace.');
  }
  return normalized;
}

function resolveWorkspaceChild(workspace: string, relativePath: string): string {
  const fullPath = path.resolve(workspace, relativePath);
  const relative = path.relative(workspace, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new VscodeWebFsError('InvalidPath', 'path escapes the workspace.');
  }
  return fullPath;
}

function getGitRequestBase(req: express.Request): { nodeId: string; workspace: string } {
  const nodeId = normalizeNodeId(getSingleQueryValue(req.query.nodeId) ?? req.body?.nodeId);
  const workspace = normalizeWorkspacePath(getSingleQueryValue(req.query.workspace) ?? req.body?.workspace);
  return { nodeId, workspace };
}

function getGitFileRequest(req: express.Request): { nodeId: string; workspace: string; relativePath: string; fullPath: string } {
  const { nodeId, workspace } = getGitRequestBase(req);
  const relativePath = normalizeGitRelativePath(getSingleQueryValue(req.query.path) ?? req.body?.path);
  const fullPath = resolveWorkspaceChild(workspace, relativePath);
  return { nodeId, workspace, relativePath, fullPath };
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
      if (!settled) {
        settled = true;
        reject(new VscodeWebFsError('GitError', `git ${args[0] || ''} timed out.`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxStdoutBytes) {
        child.kill('SIGKILL');
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new VscodeWebFsError('PayloadTooLarge', `git output exceeds ${maxStdoutBytes} bytes.`));
        }
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) {
        stderrChunks.push(chunk);
      }
    });
    child.on('error', (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new VscodeWebFsError('GitError', error.message));
      }
    });
    child.on('close', (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks));
        return;
      }
      const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
      reject(new VscodeWebFsError('GitError', stderr || `git ${args[0] || ''} failed with exit code ${code}.`));
    });
  });
}

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

type GitSubmoduleChange = {
  headOid: string;
  indexOid: string;
  worktreeOid?: string;
  dirty: boolean;
};

type GitStatusChange = {
  path: string;
  oldPath?: string;
  indexStatus: string;
  workingTreeStatus: string;
  kind: string;
  submoduleState?: string;
  submodule?: GitSubmoduleChange;
};

function parseGitStatusPorcelainV2(raw: Buffer): GitStatusChange[] {
  const records = raw.toString('utf8').split('\0').filter(Boolean);
  const changes: GitStatusChange[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    if (record.startsWith('? ')) {
      changes.push({ path: record.slice(2), indexStatus: '?', workingTreeStatus: '?', kind: 'untracked' });
      continue;
    }
    if (record.startsWith('! ')) {
      continue;
    }
    if (record.startsWith('1 ')) {
      const parts = record.split(' ');
      const xy = parts[1] || '..';
      const submoduleState = parts[2] || 'N...';
      const relativePath = parts.slice(8).join(' ');
      if (relativePath) {
        changes.push({
          path: relativePath,
          indexStatus: xy[0] || '.',
          workingTreeStatus: xy[1] || '.',
          kind: classifyGitStatus(xy[0] || '.', xy[1] || '.'),
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
      continue;
    }
    if (record.startsWith('2 ')) {
      const parts = record.split(' ');
      const xy = parts[1] || '..';
      const submoduleState = parts[2] || 'N...';
      const relativePath = parts.slice(9).join(' ');
      const oldPath = records[i + 1];
      if (oldPath !== undefined) {
        i += 1;
      }
      if (relativePath) {
        changes.push({
          path: relativePath,
          oldPath,
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
    }
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

async function resolveGitDirectory(worktreePath: string): Promise<string | undefined> {
  const dotGitPath = path.join(worktreePath, '.git');
  try {
    const stat = await fs.stat(dotGitPath);
    if (stat.isDirectory()) return dotGitPath;
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }
  const pointer = await readSmallTextFile(dotGitPath);
  const match = pointer?.match(/^gitdir:\s*(.+)$/i);
  if (!match) return undefined;
  return path.resolve(worktreePath, match[1]);
}

async function readGitHeadOid(worktreePath: string): Promise<string | undefined> {
  const gitDirectory = await resolveGitDirectory(worktreePath);
  if (!gitDirectory) return undefined;
  const head = await readSmallTextFile(path.join(gitDirectory, 'HEAD'));
  if (!head) return undefined;
  if (/^[0-9a-f]{40,64}$/i.test(head)) return head.toLowerCase();
  const refMatch = head.match(/^ref:\s*(refs\/.+)$/);
  if (!refMatch) return undefined;
  const refName = path.posix.normalize(refMatch[1].replace(/\\/g, '/'));
  if (!refName.startsWith('refs/') || refName.includes('../')) return undefined;
  const looseRefPath = path.resolve(gitDirectory, ...refName.split('/'));
  if (!isPathInside(gitDirectory, looseRefPath)) return undefined;
  const looseRef = await readSmallTextFile(looseRefPath);
  if (looseRef && /^[0-9a-f]{40,64}$/i.test(looseRef)) return looseRef.toLowerCase();
  const packedRefs = await readSmallTextFile(path.join(gitDirectory, 'packed-refs'));
  if (!packedRefs) return undefined;
  for (const line of packedRefs.split(/\r?\n/)) {
    if (!line || line.startsWith('#') || line.startsWith('^')) continue;
    const separator = line.indexOf(' ');
    if (separator < 1 || line.slice(separator + 1) !== refName) continue;
    const oid = line.slice(0, separator);
    return /^[0-9a-f]{40,64}$/i.test(oid) ? oid.toLowerCase() : undefined;
  }
  return undefined;
}

async function enrichSubmoduleChanges(topLevel: string, changes: GitStatusChange[]): Promise<GitStatusChange[]> {
  return Promise.all(changes.map(async (change) => {
    if (!change.submodule) return change;
    const submodulePath = resolveWorkspaceChild(topLevel, normalizeGitRelativePath(change.path));
    const worktreeOid = await readGitHeadOid(submodulePath);
    return {
      ...change,
      submodule: {
        ...change.submodule,
        ...(worktreeOid ? { worktreeOid } : {}),
      },
    };
  }));
}

function registerAuthenticatedStatic(httpServer: HttpServer, mountPath: string, directory: string): void {
  httpServer.app.use(mountPath, (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!httpServer.checkToken(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }, express.static(directory));
}

function registerAuthenticatedDynamicStatic(httpServer: HttpServer, mountPath: string, resolveDirectory: () => string | undefined): void {
  httpServer.app.use(mountPath, (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!httpServer.checkToken(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const directory = resolveDirectory();
    if (!directory) {
      res.status(404).json({ error: 'Code assets are not prepared' });
      return;
    }
    if (mountPath === VSCODE_WEB_STATIC_ROUTE && req.path === '/out/vs/workbench/workbench.web.main.internal.js') {
      void fs.readFile(path.join(directory, req.path), 'utf8').then((source) => {
        const functionStart = source.indexOf('async function hvt(');
        const functionEnd = functionStart < 0 ? -1 : source.indexOf('}function r2o(', functionStart);
        if (functionStart < 0 || functionEnd < 0) throw new Error('Code webview origin hash function was not found.');
        const originalFunction = source.slice(functionStart, functionEnd + 1);
        const patchedFunction = originalFunction
          .replace(/if\(!crypto\.subtle\)throw new Error\("'crypto\.subtle' is not available[^;]+;/, '')
          .replace(/crypto\.subtle\.digest\("sha-256",([A-Za-z_$][\w$]*)\)/, '(crypto.subtle ? crypto.subtle.digest("sha-256",$1) : globalThis.__foxwarmSha256Digest("sha-256",$1))');
        if (patchedFunction === originalFunction || !patchedFunction.includes('__foxwarmSha256Digest')) {
          throw new Error('Code webview origin hash function shape has changed.');
        }
        const withWebviewHashFallback = source.slice(0, functionStart) + patchedFunction + source.slice(functionEnd + 1);
        const clipboardProbe = 'async hasResources(){try{let e=await ao().navigator.clipboard.read();';
        const firefoxSafeClipboardProbe = 'async hasResources(){if(/Firefox\\//.test(navigator.userAgent))return this.resources.length>0;try{let e=await ao().navigator.clipboard.read();';
        const patchedSource = withWebviewHashFallback.replace(clipboardProbe, firefoxSafeClipboardProbe);
        if (patchedSource === withWebviewHashFallback) throw new Error('Code Explorer clipboard probe shape has changed.');
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(patchedSource);
      }).catch(next);
      return;
    }
    express.static(directory)(req, res, next);
  });
}

function registerCapabilityDynamicStatic(httpServer: HttpServer, mountPath: string, resolveDirectory: () => string | undefined): void {
  httpServer.app.use(mountPath, (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const directory = resolveDirectory();
    if (!directory) {
      res.status(404).end();
      return;
    }
    const instancePrefix = req.path.match(/^\/[^/]+(?=\/)/)?.[0] || '';
    const capabilityPath = instancePrefix ? req.path.slice(instancePrefix.length) : req.path;
    if (capabilityPath === '/' || capabilityPath === '/index.html') {
      void fs.readFile(path.join(directory, 'index.html'), 'utf8').then((source) => {
        const validation = 'if (hostname === parentOriginHash || hostname.startsWith(parentOriginHash + \'.\')) {';
        const sameOriginValidation = "if (new URL(parentOrigin).origin === new URL(location.href).origin || hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {";
        const serviceWorkerFlag = "const disableServiceWorker = searchParams.has('disableServiceWorker');";
        const insecureServiceWorkerFlag = "const disableServiceWorker = searchParams.has('disableServiceWorker') || !window.isSecureContext || (() => { try { return new URL(searchParams.get('parentOrigin')).origin === window.location.origin; } catch { return false; } })();";
        const sameOriginCheck = "if (new URL(parentOrigin).origin === new URL(location.href).origin) {\n\t\t\t\t\treturn start(parentOrigin);\n\t\t\t\t}";
        let html = source
          .replace(serviceWorkerFlag, insecureServiceWorkerFlag)
          .replace(/(const hostname = location\.hostname;)\s*(if \(!crypto\.subtle\) \{)/, `$1\n\n\t\t\t\t${sameOriginCheck}\n\n\t\t\t\t$2`)
          .replace(validation, sameOriginValidation);
        if (html === source) throw new Error('Code webview bootstrap origin validation shape has changed.');
        if (!html.includes(insecureServiceWorkerFlag) || !html.includes(sameOriginCheck)) {
          throw new Error('Code webview bootstrap insecure-context fallback shape has changed.');
        }
        const script = html.match(/<script async type="module">([\s\S]*?)<\/script>/)?.[1];
        if (!script) throw new Error('Code webview bootstrap script was not found.');
        const hash = crypto.createHash('sha256').update(script).digest('base64');
        const updatedCsp = html.replace(/script-src 'sha256-[^']+' 'self'/, `script-src 'sha256-${hash}' 'self'`);
        if (updatedCsp === html) throw new Error('Code webview bootstrap CSP hash shape has changed.');
        html = updatedCsp;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(html);
      }).catch(next);
      return;
    }
    if (!instancePrefix) {
      express.static(directory)(req, res, next);
      return;
    }
    const originalUrl = req.url;
    req.url = req.url.slice(instancePrefix.length);
    express.static(directory)(req, res, (error?: unknown) => {
      req.url = originalUrl;
      if (error) next(error);
      else next();
    });
  });
}

function resolveVscodeWebAssetDir(): string {
  const configured = process.env[VSCODE_WEB_ASSET_DIR_ENV]?.trim();
  if (!configured) {
    return DEFAULT_VSCODE_WEB_ASSET_DIR;
  }
  return path.isAbsolute(configured) ? configured : path.resolve(BASE_DIR, configured);
}

function getPreparedVscodeWebAssetDir(): string | undefined {
  const assetDir = resolveVscodeWebAssetDir();
  const requiredFiles = [
    'out/nls.messages.js',
    'out/vs/workbench/workbench.web.main.internal.css',
    'out/vs/workbench/workbench.web.main.internal.js',
  ];
  return requiredFiles.every((relativePath) => fs.existsSync(path.join(assetDir, relativePath))) ? assetDir : undefined;
}

function getDefaultFolderUri(): string {
  const configured = process.env[VSCODE_WEB_DEFAULT_FOLDER_URI_ENV]?.trim();
  if (configured) {
    return configured;
  }
  if (fs.existsSync('/app/package.json')) {
    return 'foxwarm://node+master/app/';
  }
  if (fs.existsSync('/home/ldmbot/git/foxwarm/package.json')) {
    return 'foxwarm://node+master/home/ldmbot/git/foxwarm/';
  }
  return 'foxwarm://node+master/';
}

function getRequestOrigin(req: express.Request): string {
  const forwardedProto = getSingleQueryValue(req.headers['x-forwarded-proto']) ?? req.protocol;
  const forwardedHost = getSingleQueryValue(req.headers['x-forwarded-host']) ?? req.get('host') ?? 'localhost';
  return `${forwardedProto}://${forwardedHost}`;
}

function normalizeForwardedPrefix(value: string | undefined): string {
  if (!value) {
    return '';
  }
  const firstValue = value.split(',')[0]?.trim() || '';
  if (!firstValue || firstValue === '/') {
    return '';
  }
  const withSlash = firstValue.startsWith('/') ? firstValue : `/${firstValue}`;
  return withSlash.replace(/\/+$/, '');
}

function getExternalRouteBasePath(req: express.Request): string {
  const prefix = normalizeForwardedPrefix(getSingleQueryValue(req.headers['x-forwarded-prefix']));
  return `${prefix}${VSCODE_WEB_ROUTE}`;
}

function getExternalPath(req: express.Request, routePath: string): string {
  const prefix = normalizeForwardedPrefix(getSingleQueryValue(req.headers['x-forwarded-prefix']));
  return `${prefix}${routePath}`;
}

function shouldUseRelativeAssetPaths(req: express.Request): boolean {
  if (normalizeForwardedPrefix(getSingleQueryValue(req.headers['x-forwarded-prefix']))) {
    return false;
  }
  const requestPath = (req.originalUrl || req.url || '').split('?')[0] || '';
  return requestPath.endsWith('/');
}

function toUriComponents(uriString: string) {
  const parsed = new URL(uriString);
  return {
    scheme: parsed.protocol.slice(0, -1),
    authority: parsed.host,
    path: parsed.pathname,
    query: parsed.search ? parsed.search.slice(1) : '',
    fragment: parsed.hash ? parsed.hash.slice(1) : '',
  };
}

function toFoxwarmFolderUriComponents(folderUriString: string) {
  if (!folderUriString.startsWith('foxwarm://')) {
    throw new VscodeWebFsError('InvalidPath', 'folderUri must use the foxwarm:// scheme.');
  }
  return toUriComponents(folderUriString);
}

function buildMasterFoxwarmUri(fullPath: string): string {
  const normalized = fullPath.split(path.sep).join('/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`;
  const encodedPath = withLeadingSlash.split('/').map((segment, index) => index === 0 ? '' : encodeURIComponent(segment)).join('/');
  return `foxwarm://node+master${encodedPath}`;
}

function ensureFoxwarmWorkspace(initialFolderUri: string): string {
  toFoxwarmFolderUriComponents(initialFolderUri);
  const workspacePath = process.env[VSCODE_WEB_WORKSPACE_PATH_ENV]?.trim()
    ? path.resolve(process.env[VSCODE_WEB_WORKSPACE_PATH_ENV]!.trim())
    : DEFAULT_VSCODE_WEB_WORKSPACE_PATH;
  if (!fs.existsSync(workspacePath)) {
    fs.outputJsonSync(workspacePath, {
      folders: [{ uri: initialFolderUri }],
      settings: {},
    }, { spaces: 2 });
  }
  return buildMasterFoxwarmUri(workspacePath);
}

function escapeHtmlAttribute(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildWorkbenchConfiguration(req: express.Request) {
  const origin = getRequestOrigin(req);
  const embeddedWorkspace = getSingleQueryValue(req.query.embedded) === 'true';
  const requestedFolderUri = getSingleQueryValue(embeddedWorkspace ? req.query.initialFolderUri : req.query.folderUri) ?? getDefaultFolderUri();
  const staticBasePath = getExternalPath(req, VSCODE_WEB_STATIC_ROUTE);
  const fsExtensionPath = getExternalPath(req, VSCODE_WEB_FS_EXTENSION_ROUTE);
  const terminalExtensionPath = getExternalPath(req, VSCODE_WEB_TERMINAL_EXTENSION_ROUTE);
  const scmExtensionPath = getExternalPath(req, VSCODE_WEB_SCM_EXTENSION_ROUTE);
  const webUiExtensionPath = getExternalPath(req, VSCODE_WEB_WEBUI_EXTENSION_ROUTE);
  const webviewPath = getExternalPath(req, VSCODE_WEB_WEBVIEW_ROUTE);
  const callbackRoute = `${getExternalRouteBasePath(req)}/callback`;
  const baseUrl = `${origin}${staticBasePath}`;
  const fsExtensionUri = `${origin}${fsExtensionPath}`;
  const terminalExtensionUri = `${origin}${terminalExtensionPath}`;
  const scmExtensionUri = `${origin}${scmExtensionPath}`;
  const webUiExtensionUri = `${origin}${webUiExtensionPath}`;
  const externalUrl = new URL(origin);
  const configuredWebviewOrigin = process.env[VSCODE_WEB_WEBVIEW_ORIGIN_ENV]?.trim().replace(/\/+$/, '');
  if (configuredWebviewOrigin && !/^https?:\/\/\{\{uuid\}\}\.[A-Za-z0-9.-]+(?::\d+)?$/.test(configuredWebviewOrigin)) {
    throw new VscodeWebFsError('InvalidPath', `${VSCODE_WEB_WEBVIEW_ORIGIN_ENV} must be an http(s) origin beginning with {{uuid}}.`);
  }
  const localWebviewOrigin = (externalUrl.hostname === '127.0.0.1' || externalUrl.hostname === 'localhost')
    ? `${externalUrl.protocol}//{{uuid}}.localhost${externalUrl.port ? `:${externalUrl.port}` : ''}`
    : undefined;
  const webviewOriginTemplate = configuredWebviewOrigin || localWebviewOrigin;
  const webviewBaseUrl = webviewOriginTemplate
    ? `${webviewOriginTemplate}${webviewPath}`
    : `${origin}${webviewPath}/{{uuid}}`;
  return {
    baseUrl,
    staticBasePath,
    callbackRoute,
    webviewBaseUrl,
    webviewOriginTemplate,
    configuration: {
      ...(embeddedWorkspace
        ? { workspaceUri: toUriComponents(ensureFoxwarmWorkspace(requestedFolderUri)) }
        : { folderUri: toFoxwarmFolderUriComponents(requestedFolderUri) }),
      callbackRoute,
      productConfiguration: {
        enableTelemetry: false,
        // The official static workbench needs these product URLs for web
        // extension-host and webview resources. The webview bootstrap uses a
        // narrowly scoped capability route instead of a backend extension host.
        webEndpointUrlTemplate: baseUrl,
        webviewContentExternalBaseUrlTemplate: `${webviewBaseUrl}/`,
      },
      additionalBuiltinExtensions: [toUriComponents(fsExtensionUri), toUriComponents(terminalExtensionUri), toUriComponents(scmExtensionUri), toUriComponents(webUiExtensionUri)],
      configurationDefaults: {
        'window.menuBarVisibility': 'visible',
        'terminal.integrated.defaultProfile.linux': 'Foxwarm Terminal',
        'terminal.integrated.defaultProfile.osx': 'Foxwarm Terminal',
        'terminal.integrated.defaultProfile.windows': 'Foxwarm Terminal',
      },
    },
  };
}

function buildVscodeWorkbenchHtml(req: express.Request): string {
  const { baseUrl, webviewOriginTemplate, staticBasePath, callbackRoute, configuration } = buildWorkbenchConfiguration(req);
  const escapedConfiguration = escapeHtmlAttribute(configuration);
  const assetBasePath = shouldUseRelativeAssetPaths(req) ? './static' : staticBasePath;
  const escapedAssetBasePath = escapeHtmlText(assetBasePath);
  const jsBaseUrl = JSON.stringify(baseUrl).replace(/</g, '\u003c');
  const jsWebviewOriginTemplate = JSON.stringify(webviewOriginTemplate || null).replace(/</g, '\u003c');
  const jsWebviewRelativeRoute = JSON.stringify(VSCODE_WEB_WEBVIEW_RELATIVE_ROUTE);
  const jsCallbackRoute = JSON.stringify(callbackRoute);
  return `<!doctype html>
<html>
<head>
  <script>performance.mark('code/didStartRenderer');</script>
  <meta charset="utf-8" />
  <meta name="mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-capable" content="yes" />
  <meta name="apple-mobile-web-app-title" content="Foxwarm Code" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no" />
  <meta id="vscode-workbench-web-configuration" data-settings="${escapedConfiguration}" />
  <meta id="vscode-workbench-auth-session" data-settings="" />
  <link rel="icon" href="${escapedAssetBasePath}/favicon.ico" type="image/x-icon" />
  <link rel="manifest" href="${escapedAssetBasePath}/manifest.json" crossorigin="use-credentials" />
  <link data-name="vs/workbench/workbench.web.main" rel="stylesheet" href="${escapedAssetBasePath}/out/vs/workbench/workbench.web.main.internal.css" />
  <title>Foxwarm Code</title>
</head>
<body aria-label=""></body>
<script>
  Object.defineProperty(globalThis, '__foxwarmSha256Digest', {
    configurable: false,
    writable: false,
    value: async (algorithm, source) => {
      const name = typeof algorithm === 'string' ? algorithm : algorithm?.name;
      if (String(name).toUpperCase().replace(/-/g, '') !== 'SHA256') {
        throw new DOMException('Only SHA-256 is supported by the insecure-context Code webview fallback.', 'NotSupportedError');
      }
      const input = ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source);
      const bitLength = input.byteLength * 8;
      const paddedLength = Math.ceil((input.byteLength + 9) / 64) * 64;
      const padded = new Uint8Array(paddedLength);
      padded.set(input);
      padded[input.byteLength] = 0x80;
      const view = new DataView(padded.buffer);
      view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
      view.setUint32(paddedLength - 4, bitLength >>> 0);
      const state = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
      ]);
      const constants = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
      ]);
      const words = new Uint32Array(64);
      const rotateRight = (value, count) => (value >>> count) | (value << (32 - count));
      for (let offset = 0; offset < paddedLength; offset += 64) {
        for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
        for (let index = 16; index < 64; index += 1) {
          const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
          const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
          words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = state;
        for (let index = 0; index < 64; index += 1) {
          const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
          const choose = (e & f) ^ (~e & g);
          const temp1 = (h + sum1 + choose + constants[index] + words[index]) >>> 0;
          const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
          const majority = (a & b) ^ (a & c) ^ (b & c);
          const temp2 = (sum0 + majority) >>> 0;
          h = g; g = f; f = e; e = (d + temp1) >>> 0;
          d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
        }
        state[0] = (state[0] + a) >>> 0; state[1] = (state[1] + b) >>> 0;
        state[2] = (state[2] + c) >>> 0; state[3] = (state[3] + d) >>> 0;
        state[4] = (state[4] + e) >>> 0; state[5] = (state[5] + f) >>> 0;
        state[6] = (state[6] + g) >>> 0; state[7] = (state[7] + h) >>> 0;
      }
      const output = new Uint8Array(32);
      const outputView = new DataView(output.buffer);
      state.forEach((value, index) => outputView.setUint32(index * 4, value));
      return output.buffer;
    },
  });
  const serverBaseUrl = ${jsBaseUrl};
  const routeBaseUrl = (() => {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) {
      url.pathname += '/';
    }
    return url;
  })();
  const trimTrailingSlash = (value) => value.endsWith('/') ? value.slice(0, -1) : value;
  const baseUrl = trimTrailingSlash(new URL('static', routeBaseUrl).toString()) || serverBaseUrl;
  globalThis._VSCODE_FILE_ROOT = baseUrl + '/out/';
  globalThis.__foxwarmVscodeWeb = { baseUrl, routeBaseUrl: routeBaseUrl.toString() };
</script>
<script>performance.mark('code/willLoadWorkbenchMain');</script>
<script type="module" src="${escapedAssetBasePath}/out/nls.messages.js"></script>
<script type="module">
  import { create, commands, Emitter, URI } from '${escapedAssetBasePath}/out/vs/workbench/workbench.web.main.internal.js';

  const { baseUrl, routeBaseUrl: routeBaseUrlString } = globalThis.__foxwarmVscodeWeb;
  const routeBaseUrl = new URL(routeBaseUrlString);
  const trimTrailingSlash = (value) => value.endsWith('/') ? value.slice(0, -1) : value;
  const bridgeChannel = 'foxwarm-code-bridge';
  const bridgeVersion = 1;
  let bridgeQueue = Promise.resolve();

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || typeof message !== 'object'
      || message.channel !== bridgeChannel
      || message.version !== bridgeVersion
      || message.type !== 'request'
      || typeof message.requestId !== 'string') return;

    bridgeQueue = bridgeQueue.then(async () => {
      try {
        const requestKind = message.request && typeof message.request === 'object' ? message.request.kind : '';
        const command = requestKind === 'openCommit'
          ? 'foxwarm-scm.openCommitDetails'
          : (requestKind === 'addFolder' || requestKind === 'openFile')
            ? 'foxwarm-fs.handleOpenRequest'
            : '';
        if (!command) throw new Error('Unsupported Foxwarm Code bridge request.');
        const result = await commands.executeCommand(command, message.request);
        window.parent.postMessage({
          channel: bridgeChannel,
          version: bridgeVersion,
          type: 'response',
          requestId: message.requestId,
          ok: true,
          result,
        }, window.location.origin);
      } catch (error) {
        window.parent.postMessage({
          channel: bridgeChannel,
          version: bridgeVersion,
          type: 'response',
          requestId: message.requestId,
          ok: false,
          error: String(error?.message || error),
        }, window.location.origin);
      }
    });
  });

  const announceBridgeReady = () => {
    if (window.parent === window) return;
    window.parent.postMessage({
      channel: bridgeChannel,
      version: bridgeVersion,
      type: 'ready',
    }, window.location.origin);
  };
  window.addEventListener('load', () => window.setTimeout(announceBridgeReady, 0), { once: true });

  class WorkspaceProvider {
    constructor(workspace, payload) {
      this.workspace = workspace;
      this.payload = payload;
      this.trusted = true;
    }

    static create(config) {
      const query = new URL(document.location.href).searchParams;
      let workspace;
      let foundWorkspace = false;
      let payload = Object.create(null);
      for (const [key, value] of query.entries()) {
        if (key === 'folder' || key === 'folderUri') {
          workspace = { folderUri: URI.parse(value) };
          foundWorkspace = true;
        } else if (key === 'workspace') {
          workspace = { workspaceUri: URI.parse(value) };
          foundWorkspace = true;
        } else if (key === 'ew') {
          workspace = undefined;
          foundWorkspace = true;
        } else if (key === 'payload') {
          try {
            payload = JSON.parse(value);
          } catch (error) {
            console.error(error);
          }
        }
      }
      if (!foundWorkspace) {
        if (config.folderUri) {
          workspace = { folderUri: URI.revive(config.folderUri) };
        } else if (config.workspaceUri) {
          workspace = { workspaceUri: URI.revive(config.workspaceUri) };
        }
      }
      return new WorkspaceProvider(workspace, payload);
    }

    async open(workspace, options) {
      const targetHref = new URL(document.location.pathname, document.location.origin);
      if (!workspace) {
        targetHref.searchParams.set('ew', 'true');
      } else if ('folderUri' in workspace) {
        targetHref.searchParams.set('folder', workspace.folderUri.toString(true));
      } else if ('workspaceUri' in workspace) {
        targetHref.searchParams.set('workspace', workspace.workspaceUri.toString(true));
      }
      if (options?.payload) {
        targetHref.searchParams.set('payload', JSON.stringify(options.payload));
      }
      if (options?.reuse) {
        window.location.href = targetHref.toString();
        return true;
      }
      return !!window.open(targetHref.toString());
    }
  }

  class LocalStorageURLCallbackProvider {
    constructor(callbackRoute) {
      this.callbackRoute = callbackRoute;
      this.emitter = new Emitter();
      this.onCallback = this.emitter.event;
    }

    create() {
      return URI.parse(window.location.href).with({ path: this.callbackRoute });
    }

    dispose() {
      this.emitter.dispose();
    }
  }

  try {
    const configElement = document.getElementById('vscode-workbench-web-configuration');
    const config = JSON.parse(configElement.getAttribute('data-settings'));
    const toUriComponents = (uriString) => {
      const parsed = new URL(uriString);
      return {
        scheme: parsed.protocol.slice(0, -1),
        authority: parsed.host,
        path: parsed.pathname,
        query: parsed.search ? parsed.search.slice(1) : '',
        fragment: parsed.hash ? parsed.hash.slice(1) : '',
      };
    };
    const routePath = trimTrailingSlash(routeBaseUrl.pathname);
    const extensionUrl = (extensionPath) => trimTrailingSlash(new URL(extensionPath, routeBaseUrl).toString());
    config.callbackRoute = routePath + '/callback';
    const webviewOrigin = ${jsWebviewOriginTemplate} || window.location.origin;
    const webviewBaseUrl = trimTrailingSlash(webviewOrigin) + routePath + '/' + ${jsWebviewRelativeRoute} + (${jsWebviewOriginTemplate} ? '' : '/{{uuid}}');
    config.productConfiguration = {
      ...config.productConfiguration,
      webEndpointUrlTemplate: baseUrl,
      webviewContentExternalBaseUrlTemplate: webviewBaseUrl + '/',
    };
    config.additionalBuiltinExtensions = [
      toUriComponents(extensionUrl('extensions/foxwarm-fs')),
      toUriComponents(extensionUrl('extensions/foxwarm-terminal')),
      toUriComponents(extensionUrl('extensions/foxwarm-scm')),
      toUriComponents(extensionUrl('extensions/foxwarm-webui')),
    ];
    create(document.body, {
      ...config,
      workspaceProvider: WorkspaceProvider.create(config),
      urlCallbackProvider: new LocalStorageURLCallbackProvider(config.callbackRoute || ${jsCallbackRoute}),
    });
    const executeStartupCommand = async (command, request) => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          return await commands.executeCommand(command, request);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (attempt === 49 || !/not found|not registered|unknown command/i.test(message)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    };
    const startupQuery = new URL(window.location.href).searchParams;
    const openFilePath = startupQuery.get('openFilePath');
    if (openFilePath) {
      const parseLine = (name) => {
        const value = Number(startupQuery.get(name));
        return Number.isInteger(value) && value > 0 ? value : undefined;
      };
      void executeStartupCommand('foxwarm-fs.handleOpenRequest', {
        kind: 'openFile',
        nodeId: startupQuery.get('openFileNodeId') || 'master',
        path: openFilePath,
        startLine: parseLine('startLine'),
        endLine: parseLine('endLine'),
      }).catch((error) => console.error('Failed to open initial Foxwarm file', error));
    }
    const openCommitPath = startupQuery.get('openCommitPath');
    const openCommitId = startupQuery.get('openCommitId');
    if (openCommitPath && openCommitId) {
      void executeStartupCommand('foxwarm-scm.openCommitDetails', {
        kind: 'openCommit',
        nodeId: startupQuery.get('openCommitNodeId') || 'master',
        path: openCommitPath,
        commitId: openCommitId,
      }).catch((error) => console.error('Failed to open initial Foxwarm commit', error));
    }
  } catch (error) {
    console.error('Failed to bootstrap Foxwarm Code', error);
    const pre = document.createElement('pre');
    pre.textContent = String(error?.stack || error);
    document.body.appendChild(pre);
  }
</script>
</html>`;
}

function buildCodeUnavailableHtml(): string {
  const escapedAssetDir = escapeHtmlText(resolveVscodeWebAssetDir());
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Code is not built · Foxwarm</title>
  <style>
    :root { color-scheme: light dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f3f4f6; color: #111827; padding: 24px; }
    main { width: min(720px, 100%); border: 1px solid #d1d5db; border-radius: 16px; background: white; padding: clamp(24px, 5vw, 44px); box-shadow: 0 16px 50px rgba(15, 23, 42, .09); }
    .eyebrow { margin: 0 0 10px; color: #2563eb; font-size: 13px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(28px, 5vw, 42px); letter-spacing: -.03em; }
    p { color: #4b5563; line-height: 1.6; }
    .option { margin-top: 18px; border: 1px solid #e5e7eb; border-radius: 12px; padding: 16px; }
    .option strong { display: block; margin-bottom: 8px; }
    code { display: block; overflow-x: auto; border-radius: 8px; background: #111827; color: #f9fafb; padding: 12px 14px; white-space: nowrap; }
    .hint { margin-top: 20px; font-size: 13px; color: #6b7280; }
    .path { overflow-wrap: anywhere; }
    @media (prefers-color-scheme: dark) {
      body { background: #030712; color: #f9fafb; }
      main { border-color: #374151; background: #111827; box-shadow: none; }
      p, .hint { color: #9ca3af; }
      .option { border-color: #374151; }
      code { background: #030712; }
    }
  </style>
</head>
<body>
  <main>
    <p class="eyebrow">Optional component</p>
    <h1>Code is not built</h1>
    <p>This Foxwarm installation does not currently include the optional browser workbench assets. Choose one preparation method, then reload this page.</p>
    <section class="option">
      <strong>Build the MIT-licensed Code - OSS workbench from source</strong>
      <code>npm run build:code</code>
    </section>
    <section class="option">
      <strong>Download Microsoft's prebuilt workbench for development or licensed internal use</strong>
      <code>npm run download:code</code>
    </section>
    <p class="hint">Both commands are intentionally excluded from the normal <code style="display:inline;padding:2px 5px">npm run build</code> because preparing Code is large and slow. Assets are expected at <span class="path">${escapedAssetDir}</span>; alternatively configure <code style="display:inline;padding:2px 5px">${VSCODE_WEB_ASSET_DIR_ENV}</code>.</p>
  </main>
</body>
</html>`;
}

export function registerVscodeWebRoutes(httpServer: HttpServer): void {
  const extensionRoutes = [
    { route: VSCODE_WEB_FS_EXTENSION_ROUTE, dir: path.join(BASE_DIR, 'packages', 'vscode-web', 'foxwarm-fs') },
    { route: VSCODE_WEB_TERMINAL_EXTENSION_ROUTE, dir: path.join(BASE_DIR, 'packages', 'vscode-web', 'foxwarm-terminal') },
    { route: VSCODE_WEB_SCM_EXTENSION_ROUTE, dir: path.join(BASE_DIR, 'packages', 'vscode-web', 'foxwarm-scm') },
    { route: VSCODE_WEB_WEBUI_EXTENSION_ROUTE, dir: path.join(BASE_DIR, 'packages', 'vscode-web', 'foxwarm-webui') },
  ];
  for (const extension of extensionRoutes) {
    if (fs.existsSync(extension.dir)) {
      registerAuthenticatedStatic(httpServer, extension.route, extension.dir);
    }
  }

  registerAuthenticatedDynamicStatic(httpServer, VSCODE_WEB_STATIC_ROUTE, getPreparedVscodeWebAssetDir);
  registerCapabilityDynamicStatic(httpServer, VSCODE_WEB_WEBVIEW_ROUTE, () => {
    const assetDir = getPreparedVscodeWebAssetDir();
    return assetDir ? path.join(assetDir, 'out', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre') : undefined;
  });

  httpServer.addRoute({
    path: VSCODE_WEB_ROUTE,
    method: 'GET',
    handler: async (req, res) => {
      try {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (getPreparedVscodeWebAssetDir()) {
          res.send(buildVscodeWorkbenchHtml(req));
        } else {
          res.setHeader('Cache-Control', 'no-store');
          res.status(503).send(buildCodeUnavailableHtml());
        }
      } catch (error) {
        sendFsError(res, error);
      }
    },
  });

  httpServer.addRoute({
    path: `${VSCODE_WEB_ROUTE}/callback`,
    method: 'GET',
    handler: async (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send('<!doctype html><meta charset="utf-8"><title>Foxwarm Code callback</title><script>window.close();</script>');
    },
  });

  httpServer.addRoute({
    path: `${VSCODE_WEB_API_PREFIX}/stat`,
    method: 'GET',
    handler: async (req, res) => {
      try {
        const { nodeId, fullPath } = getRequestTarget(req);
        if (nodeId !== 'master') {
          res.json(await requestRemoteVscodeService(nodeId, 'vscode-fs', 'stat', { path: fullPath }));
          return;
        }
        const { stat, lst } = await getExistingStats(fullPath);
        res.json(toFileStat(stat, lst));
      } catch (error) {
        sendFsError(res, error);
      }
    },
  });

  httpServer.addRoute({
    path: `${VSCODE_WEB_API_PREFIX}/read-directory`,
    method: 'GET',
    handler: async (req, res) => {
      try {
        const { nodeId, fullPath } = getRequestTarget(req);
        if (nodeId !== 'master') {
          res.json(await requestRemoteVscodeService(nodeId, 'vscode-fs', 'read-directory', { path: fullPath }));
          return;
        }
        const { stat } = await getExistingStats(fullPath);
        if (!stat.isDirectory()) {
          throw new VscodeWebFsError('FileNotADirectory', `Path is not a directory: ${fullPath}`);
        }
        const dirents = await fs.readdir(fullPath, { withFileTypes: true });
        const entries = await Promise.all(dirents.map(async (dirent) => {
          const childPath = path.join(fullPath, dirent.name);
          try {
            const { stat: childStat, lst: childLstat } = await getExistingStats(childPath);
            return { name: dirent.name, type: toVscodeFileType(childStat, childLstat) };
          } catch {
            return { name: dirent.name, type: dirent.isDirectory() ? VSCODE_FILE_TYPE.Directory : dirent.isFile() ? VSCODE_FILE_TYPE.File : VSCODE_FILE_TYPE.Unknown };
          }
        }));
        res.json({ entries });
      } catch (error) {
        sendFsError(res, error);
      }
    },
  });

  httpServer.addRoute({
    path: `${VSCODE_WEB_API_PREFIX}/read-file`,
    method: 'GET',
    handler: async (req, res) => {
      try {
        const { nodeId, fullPath } = getRequestTarget(req);
        if (nodeId !== 'master') {
          const result = await requestRemoteVscodeService(nodeId, 'vscode-fs', 'read-file', { path: fullPath });
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          res.send(Buffer.from(String(result?.contentBase64 || ''), 'base64'));
          return;
        }
        const { stat } = await getExistingStats(fullPath);
        if (!stat.isFile()) {
          throw new VscodeWebFsError('FileIsADirectory', `Path is not a file: ${fullPath}`);
        }
        if (stat.size > MAX_READ_BYTES) {
          throw new VscodeWebFsError('PayloadTooLarge', `File exceeds ${MAX_READ_BYTES} bytes: ${fullPath}`);
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.send(await fs.readFile(fullPath));
      } catch (error) {
        sendFsError(res, error);
      }
    },
  });

  httpServer.addRoute({
    path: `${VSCODE_WEB_API_PREFIX}/write-file`,
    method: 'PUT',
    handler: async (req, res) => {
      try {
        const { nodeId, fullPath } = getRequestTarget(req);
        const create = parseBool(getSingleQueryValue(req.query.create));
        const overwrite = parseBool(getSingleQueryValue(req.query.overwrite));
        if (nodeId !== 'master') {
          const content = await readRawRequestBody(req);
          res.json(await requestRemoteVscodeService(nodeId, 'vscode-fs', 'write-file', { path: fullPath, create, overwrite, contentBase64: content.toString('base64') }));
          return;
        }
        await assertParentDirectoryExists(fullPath);
        const existing = await fs.pathExists(fullPath);
        if (!existing && !create) {
          throw new VscodeWebFsError('FileNotFound', `File not found: ${fullPath}`);
        }
        if (existing) {
          const { stat } = await getExistingStats(fullPath);
          if (stat.isDirectory()) {
            throw new VscodeWebFsError('FileIsADirectory', `Path is a directory: ${fullPath}`);
          }
          if (create && !overwrite) {
            throw new VscodeWebFsError('FileExists', `File already exists: ${fullPath}`);
          }
        }
        const content = await readRawRequestBody(req);
        await fs.writeFile(fullPath, content, { flag: overwrite ? 'w' : (existing ? 'w' : 'wx') });
        const { stat, lst } = await getExistingStats(fullPath);
        res.json({ success: true, stat: toFileStat(stat, lst) });
      } catch (error) {
        sendFsError(res, error);
      }
    },
  });

  httpServer.addRoute({
    path: `${VSCODE_WEB_API_PREFIX}/create-directory`,
    method: 'POST',
    handler: async (req, res) => {
      try {
        const { nodeId, fullPath } = getRequestTarget(req);
        if (nodeId !== 'master') {
          res.json(await requestRemoteVscodeService(nodeId, 'vscode-fs', 'create-directory', { path: fullPath }));
          return;
        }
        await assertParentDirectoryExists(fullPath);
        if (await fs.pathExists(fullPath)) {
          throw new VscodeWebFsError('FileExists', `Path already exists: ${fullPath}`);
        }
        await fs.mkdir(fullPath);
        const { stat, lst } = await getExistingStats(fullPath);
        res.json({ success: true, stat: toFileStat(stat, lst) });
      } catch (error) {
        sendFsError(res, error);
      }
    },
  });

  httpServer.addRoute({
    path: `${VSCODE_WEB_API_PREFIX}/delete`,
    method: 'POST',
    handler: async (req, res) => {
      try {
        const { nodeId, fullPath } = getRequestTarget(req);
        const recursive = parseBool(req.body?.recursive);
        if (nodeId !== 'master') {
          res.json(await requestRemoteVscodeService(nodeId, 'vscode-fs', 'delete', { path: fullPath, recursive }));
          return;
        }
        const { stat } = await getExistingStats(fullPath);
        if (stat.isDirectory()) {
          await fs.rm(fullPath, { recursive, force: false });
        } else {
          await fs.unlink(fullPath);
        }
        res.json({ success: true });
      } catch (error) {
        sendFsError(res, error);
      }
    },
  });

  httpServer.addRoute({
    path: `${VSCODE_WEB_API_PREFIX}/rename`,
    method: 'POST',
    handler: async (req, res) => {
      try {
        const nodeId = normalizeNodeId(req.body?.nodeId ?? getSingleQueryValue(req.query.nodeId));
        const oldPath = normalizeRealPath(req.body?.oldPath);
        const newPath = normalizeRealPath(req.body?.newPath);
        const overwrite = parseBool(req.body?.overwrite);
        if (nodeId !== 'master') {
          res.json(await requestRemoteVscodeService(nodeId, 'vscode-fs', 'rename', { path: oldPath, newPath, overwrite }));
          return;
        }
        await getExistingStats(oldPath);
        await assertParentDirectoryExists(newPath);
        const destinationExists = await fs.pathExists(newPath);
        if (destinationExists && !overwrite) {
          throw new VscodeWebFsError('FileExists', `Destination already exists: ${newPath}`);
        }
        if (destinationExists && overwrite) {
          await fs.rm(newPath, { recursive: true, force: true });
        }
        await fs.rename(oldPath, newPath);
        res.json({ success: true });
      } catch (error) {
        sendFsError(res, error);
      }
    },
  });

  httpServer.addRoute({
    path: `${VSCODE_WEB_GIT_API_PREFIX}/status`,
    method: 'GET',
    handler: async (req, res) => {
      try {
        const { nodeId, workspace } = getGitRequestBase(req);
        if (nodeId !== 'master') {
          const result = await requestRemoteVscodeService(nodeId, 'vscode-git', 'status', { workspace });
          res.json({ nodeId, ...result });
          return;
        }
        const topLevel = (await runGit(workspace, ['rev-parse', '--show-toplevel'], { maxStdoutBytes: 1024 * 1024, safeDirectory: '*' })).toString('utf8').trim();
        const rawStatus = await runGit(topLevel, ['status', '--porcelain=v2', '-z', '-uall'], { maxStdoutBytes: MAX_GIT_OUTPUT_BYTES });
        const changes = await enrichSubmoduleChanges(topLevel, parseGitStatusPorcelainV2(rawStatus));
        res.json({
          nodeId,
          workspace: topLevel,
          topLevel,
          changes,
        });
      } catch (error) {
        sendFsError(res, error);
      }
    },
  });

  httpServer.addRoute({
    path: `${VSCODE_WEB_GIT_API_PREFIX}/commit`,
    method: 'GET',
    handler: async (req, res) => {
      try {
        const { nodeId, workspace } = getGitRequestBase(req);
        const id = getSingleQueryValue(req.query.id);
        if (nodeId !== 'master') {
          const result = await requestRemoteVscodeService(
            nodeId,
            'vscode-git',
            'commit',
            { workspace, id },
            VSCODE_GIT_COMMIT_SERVICE_VERSION,
          );
          res.setHeader('Cache-Control', 'no-store');
          res.json({ nodeId, ...result });
          return;
        }
        const details = await readVscodeGitCommitDetails(workspace, id, (cwd, args, maxStdoutBytes) => (
          runGit(cwd, args, { maxStdoutBytes, safeDirectory: '*' })
        ));
        res.setHeader('Cache-Control', 'no-store');
        res.json({ nodeId, ...details });
      } catch (error) {
        if (error instanceof VscodeGitCommitDetailsError) {
          sendFsError(res, new VscodeWebFsError(
            error.code === 'PayloadTooLarge' ? 'PayloadTooLarge' : 'InvalidCommit',
            error.message,
          ));
          return;
        }
        sendFsError(res, error);
      }
    },
  });

  httpServer.addRoute({
    path: `${VSCODE_WEB_GIT_API_PREFIX}/content`,
    method: 'GET',
    handler: async (req, res) => {
      try {
        const { nodeId, workspace, relativePath, fullPath } = getGitFileRequest(req);
        const side = getSingleQueryValue(req.query.side) ?? 'base';
        let ref: string;
        try { ref = normalizeVscodeGitContentRef(getSingleQueryValue(req.query.ref)); }
        catch (error) { throw new VscodeWebFsError('InvalidCommit', error instanceof Error ? error.message : String(error)); }
        if (nodeId !== 'master') {
          const result = await requestRemoteVscodeService(nodeId, 'vscode-git', 'content', { workspace, path: relativePath, side, ref });
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.send(Buffer.from(String(result?.contentBase64 || ''), 'base64'));
          return;
        }
        let content: Buffer;
        if (side === 'working') {
          try {
            const stat = await fs.stat(fullPath);
            if (!stat.isFile()) {
              content = Buffer.alloc(0);
            } else {
              if (stat.size > MAX_GIT_CONTENT_BYTES) {
                throw new VscodeWebFsError('PayloadTooLarge', `File exceeds ${MAX_GIT_CONTENT_BYTES} bytes: ${fullPath}`);
              }
              content = await fs.readFile(fullPath);
            }
          } catch (error: any) {
            if (error instanceof VscodeWebFsError) {
              throw error;
            }
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
              content = Buffer.alloc(0);
            } else {
              throw error;
            }
          }
        } else if (side === 'base') {
          try {
            content = await runGit(workspace, ['show', `${ref}:${relativePath}`], { maxStdoutBytes: MAX_GIT_CONTENT_BYTES });
          } catch (error) {
            if (error instanceof VscodeWebFsError && error.code === 'GitError') {
              content = Buffer.alloc(0);
            } else {
              throw error;
            }
          }
        } else {
          throw new VscodeWebFsError('InvalidPath', 'side must be `base` or `working`.');
        }
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.send(content);
      } catch (error) {
        sendFsError(res, error);
      }
    },
  });
}
