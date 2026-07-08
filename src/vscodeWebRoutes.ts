import express from 'express';
import path from 'path';
import fs from 'fs-extra';
import type { HttpServer } from './httpServer';
import { BASE_DIR } from './config';
import { logger } from './common';

const VSCODE_WEB_ROUTE = '/vscode-web';
const VSCODE_WEB_API_PREFIX = '/api/vscode-web/fs';
const MAX_WRITE_BYTES = 50 * 1024 * 1024;
const MAX_READ_BYTES = 50 * 1024 * 1024;

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
  | 'PayloadTooLarge'
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
      return 400;
    case 'NoPermissions':
      return 403;
    case 'PayloadTooLarge':
      return 413;
    case 'Unavailable':
      return 503;
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
  if (nodeId !== 'master') {
    throw new VscodeWebFsError('UnsupportedNode', `VS Code Web filesystem MVP currently supports only node \`master\` (requested \`${nodeId}\`).`);
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
  const anyError = error as any;
  logger.error({ err: error }, 'VS Code Web filesystem route failed');
  res.status(500).json({ error: anyError?.message || 'Internal Server Error', code: 'Unknown' });
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

function buildVscodeWebPlaceholderHtml(): string {
  const escapedApiPrefix = VSCODE_WEB_API_PREFIX.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Foxwarm VS Code Web spike</title>
  <style>
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 2rem; line-height: 1.45; }
    code { background: #f2f2f2; padding: 0.1rem 0.25rem; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>Foxwarm VS Code Web spike route</h1>
  <p>This route is reserved for a self-hosted official VS Code for the Web build. The static VS Code workbench assets are not vendored in this spike skeleton yet.</p>
  <p>The browser filesystem extension is served from <code>${VSCODE_WEB_ROUTE}/extensions/foxwarm-fs/</code>.</p>
  <p>The filesystem API prefix is <code>${escapedApiPrefix}</code>.</p>
  <p>Intended workspace URI shape: <code>foxwarm://node/master/home/ldmbot/git/foxwarm/</code>.</p>
</body>
</html>`;
}

export function registerVscodeWebRoutes(httpServer: HttpServer): void {
  const extensionDir = path.join(BASE_DIR, 'packages', 'vscode-web', 'foxwarm-fs');
  if (fs.existsSync(extensionDir)) {
    registerAuthenticatedStatic(httpServer, `${VSCODE_WEB_ROUTE}/extensions/foxwarm-fs`, extensionDir);
  }

  httpServer.addRoute({
    path: VSCODE_WEB_ROUTE,
    method: 'GET',
    handler: async (_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(buildVscodeWebPlaceholderHtml());
    },
  });

  httpServer.addRoute({
    path: `${VSCODE_WEB_API_PREFIX}/stat`,
    method: 'GET',
    handler: async (req, res) => {
      try {
        const { fullPath } = getRequestTarget(req);
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
        const { fullPath } = getRequestTarget(req);
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
        const { fullPath } = getRequestTarget(req);
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
        const { fullPath } = getRequestTarget(req);
        const create = parseBool(getSingleQueryValue(req.query.create));
        const overwrite = parseBool(getSingleQueryValue(req.query.overwrite));
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
        const { fullPath } = getRequestTarget(req);
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
        const { fullPath } = getRequestTarget(req);
        const recursive = parseBool(req.body?.recursive);
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
        void nodeId;
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
}
