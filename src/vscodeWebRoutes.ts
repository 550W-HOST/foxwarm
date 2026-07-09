import express from 'express';
import path from 'path';
import fs from 'fs-extra';
import type { HttpServer } from './httpServer';
import { BASE_DIR } from './config';
import { logger } from './common';

const VSCODE_WEB_ROUTE = '/vscode-web';
const VSCODE_WEB_API_PREFIX = '/api/vscode-web/fs';
const VSCODE_WEB_STATIC_ROUTE = `${VSCODE_WEB_ROUTE}/static`;
const VSCODE_WEB_EXTENSION_ROUTE = `${VSCODE_WEB_ROUTE}/extensions/foxwarm-fs`;
const VSCODE_WEB_ASSET_DIR_ENV = 'FOXWARM_VSCODE_WEB_ASSET_DIR';
const VSCODE_WEB_DEFAULT_FOLDER_URI_ENV = 'FOXWARM_VSCODE_WEB_DEFAULT_FOLDER_URI';
const DEFAULT_VSCODE_WEB_ASSET_DIR = path.join(BASE_DIR, 'packages', 'vscode-web', 'assets', 'vscode-web');
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

function registerAuthenticatedDynamicStatic(httpServer: HttpServer, mountPath: string, resolveDirectory: () => string | undefined): void {
  httpServer.app.use(mountPath, (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!httpServer.checkToken(req)) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const directory = resolveDirectory();
    if (!directory) {
      res.status(404).json({ error: 'VS Code Web assets are not prepared' });
      return;
    }
    express.static(directory)(req, res, next);
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
    return 'foxwarm://node/master/app/';
  }
  if (fs.existsSync('/home/ldmbot/git/foxwarm/package.json')) {
    return 'foxwarm://node/master/home/ldmbot/git/foxwarm/';
  }
  return 'foxwarm://node/master/';
}

function getRequestOrigin(req: express.Request): string {
  const forwardedProto = getSingleQueryValue(req.headers['x-forwarded-proto']) ?? req.protocol;
  const forwardedHost = getSingleQueryValue(req.headers['x-forwarded-host']) ?? req.get('host') ?? 'localhost';
  return `${forwardedProto}://${forwardedHost}`;
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
  const requestedFolderUri = getSingleQueryValue(req.query.folderUri) ?? getDefaultFolderUri();
  const baseUrl = `${origin}${VSCODE_WEB_STATIC_ROUTE}`;
  const extensionUri = `${origin}${VSCODE_WEB_EXTENSION_ROUTE}`;
  return {
    baseUrl,
    configuration: {
      folderUri: toFoxwarmFolderUriComponents(requestedFolderUri),
      callbackRoute: `${VSCODE_WEB_ROUTE}/callback`,
      productConfiguration: {
        enableTelemetry: false,
        // The official static workbench needs these product URLs for web
        // extension host / webview resources. Keeping them under the same
        // authenticated origin avoids a code-server style backend extension host.
        webEndpointUrlTemplate: baseUrl,
        webviewContentExternalBaseUrlTemplate: `${baseUrl}/out/vs/workbench/contrib/webview/browser/pre/`,
      },
      additionalBuiltinExtensions: [toUriComponents(extensionUri)],
    },
  };
}

function buildVscodeWorkbenchHtml(req: express.Request): string {
  const { baseUrl, configuration } = buildWorkbenchConfiguration(req);
  const escapedConfiguration = escapeHtmlAttribute(configuration);
  const escapedBaseUrl = escapeHtmlText(baseUrl);
  const jsBaseUrl = JSON.stringify(baseUrl).replace(/</g, '\u003c');
  const jsCallbackRoute = JSON.stringify(`${VSCODE_WEB_ROUTE}/callback`);
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
  <link rel="icon" href="${escapedBaseUrl}/favicon.ico" type="image/x-icon" />
  <link rel="manifest" href="${escapedBaseUrl}/manifest.json" crossorigin="use-credentials" />
  <link data-name="vs/workbench/workbench.web.main" rel="stylesheet" href="${escapedBaseUrl}/out/vs/workbench/workbench.web.main.internal.css" />
  <title>Foxwarm VS Code Web</title>
</head>
<body aria-label=""></body>
<script>
  const baseUrl = ${jsBaseUrl};
  globalThis._VSCODE_FILE_ROOT = baseUrl + '/out/';
</script>
<script>performance.mark('code/willLoadWorkbenchMain');</script>
<script type="module" src="${escapedBaseUrl}/out/nls.messages.js"></script>
<script type="module">
  import { create, Emitter, URI } from '${escapedBaseUrl}/out/vs/workbench/workbench.web.main.internal.js';

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
    create(document.body, {
      ...config,
      workspaceProvider: WorkspaceProvider.create(config),
      urlCallbackProvider: new LocalStorageURLCallbackProvider(${jsCallbackRoute}),
    });
  } catch (error) {
    console.error('Failed to bootstrap Foxwarm VS Code Web', error);
    const pre = document.createElement('pre');
    pre.textContent = String(error?.stack || error);
    document.body.appendChild(pre);
  }
</script>
</html>`;
}

function buildVscodeWebPlaceholderHtml(): string {
  const escapedApiPrefix = VSCODE_WEB_API_PREFIX.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const escapedAssetDir = escapeHtmlText(resolveVscodeWebAssetDir());
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
  <p>This route is reserved for a self-hosted official VS Code for the Web build. Prepare static VS Code Web assets at <code>${escapedAssetDir}</code> or set <code>${VSCODE_WEB_ASSET_DIR_ENV}</code> to enable the workbench bootstrap.</p>
  <p>The browser filesystem extension is served from <code>${VSCODE_WEB_EXTENSION_ROUTE}/</code>.</p>
  <p>The filesystem API prefix is <code>${escapedApiPrefix}</code>.</p>
  <p>Intended workspace URI shape: <code>foxwarm://node/master/home/ldmbot/git/foxwarm/</code>.</p>
</body>
</html>`;
}

export function registerVscodeWebRoutes(httpServer: HttpServer): void {
  const extensionDir = path.join(BASE_DIR, 'packages', 'vscode-web', 'foxwarm-fs');
  if (fs.existsSync(extensionDir)) {
    registerAuthenticatedStatic(httpServer, VSCODE_WEB_EXTENSION_ROUTE, extensionDir);
  }

  registerAuthenticatedDynamicStatic(httpServer, VSCODE_WEB_STATIC_ROUTE, getPreparedVscodeWebAssetDir);

  httpServer.addRoute({
    path: VSCODE_WEB_ROUTE,
    method: 'GET',
    handler: async (req, res) => {
      try {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (getPreparedVscodeWebAssetDir()) {
          res.send(buildVscodeWorkbenchHtml(req));
        } else {
          res.send(buildVscodeWebPlaceholderHtml());
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
      res.send('<!doctype html><meta charset="utf-8"><title>Foxwarm VS Code Web callback</title><script>window.close();</script>');
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
