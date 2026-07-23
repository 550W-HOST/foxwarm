import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { HttpServer } from './httpServer';
import { registerVscodeWebRoutes } from './vscodeWebRoutes';
import { BASE_DIR, DATA_ROOT_DIR } from './config';
import { nodesManager } from './nodes/manager';
import { executeVscodeNodeService, serializeVscodeNodeServiceError } from '../packages/shared/dist/vscodeNodeService';
import type { WebSocket } from 'ws';

const TEST_TOKEN = 'secret-token';
const execFileAsync = promisify(execFile);

async function withServer(fn: (server: HttpServer, baseUrl: string) => Promise<void>) {
  const port = 33180 + Math.floor(Math.random() * 1000);
  const server = new HttpServer(port, TEST_TOKEN);
  registerVscodeWebRoutes(server);
  await server.start();
  try {
    await fn(server, `http://127.0.0.1:${port}`);
  } finally {
    await server.stop();
  }
}

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-vscode-web-routes-'));
  try {
    await run(dirPath);
  } finally {
    await fs.remove(dirPath).catch(() => {});
  }
}

function bearerHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Authorization: `Bearer ${TEST_TOKEN}`, ...extra };
}

function cookieHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Cookie: `foxwarm_token=${encodeURIComponent(TEST_TOKEN)}`, ...extra };
}

test('VS Code Web route, extension assets, and filesystem API require the WebUI token', async () => {
  await withServer(async (_server, baseUrl) => {
    const routeNoAuth = await fetch(`${baseUrl}/vscode-web`);
    assert.equal(routeNoAuth.status, 401);

    const routeWithBearer = await fetch(`${baseUrl}/vscode-web`, { headers: bearerHeaders() });
    assert.ok(routeWithBearer.status === 200 || routeWithBearer.status === 503);
    assert.match(await routeWithBearer.text(), /Code is not built|vscode-workbench-web-configuration/);

    const extensionNoAuth = await fetch(`${baseUrl}/vscode-web/extensions/foxwarm-fs/package.json`);
    assert.equal(extensionNoAuth.status, 401);

    const extensionWithCookie = await fetch(`${baseUrl}/vscode-web/extensions/foxwarm-fs/package.json`, { headers: cookieHeaders() });
    assert.equal(extensionWithCookie.status, 200);
    const extensionManifest = await extensionWithCookie.json() as { name?: string };
    assert.equal(extensionManifest.name, '@foxwarm/vscode-web-foxwarm-fs');

    const terminalExtensionWithCookie = await fetch(`${baseUrl}/vscode-web/extensions/foxwarm-terminal/package.json`, { headers: cookieHeaders() });
    assert.equal(terminalExtensionWithCookie.status, 200);
    const terminalExtensionManifest = await terminalExtensionWithCookie.json() as { name?: string };
    assert.equal(terminalExtensionManifest.name, '@foxwarm/vscode-web-foxwarm-terminal');

    const scmExtensionWithCookie = await fetch(`${baseUrl}/vscode-web/extensions/foxwarm-scm/package.json`, { headers: cookieHeaders() });
    assert.equal(scmExtensionWithCookie.status, 200);
    const scmExtensionManifest = await scmExtensionWithCookie.json() as { name?: string };
    assert.equal(scmExtensionManifest.name, '@foxwarm/vscode-web-foxwarm-scm');

    const webUiExtensionWithCookie = await fetch(`${baseUrl}/vscode-web/extensions/foxwarm-webui/package.json`, { headers: cookieHeaders() });
    assert.equal(webUiExtensionWithCookie.status, 200);
    const webUiExtensionManifest = await webUiExtensionWithCookie.json() as { name?: string };
    assert.equal(webUiExtensionManifest.name, '@foxwarm/vscode-web-foxwarm-webui');

    const fsNoAuth = await fetch(`${baseUrl}/api/vscode-web/fs/stat?nodeId=master&path=${encodeURIComponent(__filename)}`);
    assert.equal(fsNoAuth.status, 401);

    const fsWithBearer = await fetch(`${baseUrl}/api/vscode-web/fs/stat?nodeId=master&path=${encodeURIComponent(__filename)}`, { headers: bearerHeaders() });
    assert.equal(fsWithBearer.status, 200);
    const statPayload = await fsWithBearer.json() as { type?: number };
    assert.equal(statPayload.type, 1);

    const rootsNoAuth = await fetch(`${baseUrl}/api/vscode-web/fs/workspace-roots`);
    assert.equal(rootsNoAuth.status, 401);
    const rootsWithCookie = await fetch(`${baseUrl}/api/vscode-web/fs/workspace-roots`, { headers: cookieHeaders() });
    assert.equal(rootsWithCookie.status, 200);
    assert.equal(rootsWithCookie.headers.get('cache-control'), 'no-store');
    const rootsPayload = await rootsWithCookie.json() as Record<string, any>;
    assert.deepEqual(rootsPayload, {
      version: 1,
      roots: {
        app: { nodeId: 'master', path: BASE_DIR },
        data: { nodeId: 'master', path: DATA_ROOT_DIR },
      },
    });
    assert.equal(JSON.stringify(rootsPayload).includes(TEST_TOKEN), false);
  });
});

test('Code route returns a friendly actionable page when optional assets are missing', async () => {
  const previousAssetDir = process.env.FOXWARM_VSCODE_WEB_ASSET_DIR;
  try {
    await withTempDir(async (dirPath) => {
      process.env.FOXWARM_VSCODE_WEB_ASSET_DIR = dirPath;
      await withServer(async (_server, baseUrl) => {
        const response = await fetch(`${baseUrl}/vscode-web`, { headers: bearerHeaders() });
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const html = await response.text();
        assert.match(html, /Code is not built/);
        assert.match(html, /npm run build:code/);
        assert.match(html, /npm run download:code/);
        assert.doesNotMatch(html, /<title>[^<]*VS Code/i);

        const staticResponse = await fetch(`${baseUrl}/vscode-web/static/out/nls.messages.js`, { headers: bearerHeaders() });
        assert.equal(staticResponse.status, 404);
      });
    });
  } finally {
    if (previousAssetDir === undefined) delete process.env.FOXWARM_VSCODE_WEB_ASSET_DIR;
    else process.env.FOXWARM_VSCODE_WEB_ASSET_DIR = previousAssetDir;
  }
});

test('VS Code Web filesystem API rejects unavailable nodes and non-absolute paths', async () => {
  await withServer(async (_server, baseUrl) => {
    const unavailableNode = await fetch(`${baseUrl}/api/vscode-web/fs/stat?nodeId=worker-a&path=${encodeURIComponent(__filename)}`, { headers: bearerHeaders() });
    assert.equal(unavailableNode.status, 503);
    const unavailableNodePayload = await unavailableNode.json() as { code?: string };
    assert.equal(unavailableNodePayload.code, 'NodeUnavailable');

    const relativePath = await fetch(`${baseUrl}/api/vscode-web/fs/stat?nodeId=master&path=relative/path`, { headers: bearerHeaders() });
    assert.equal(relativePath.status, 400);
    const relativePathPayload = await relativePath.json() as { code?: string };
    assert.equal(relativePathPayload.code, 'InvalidPath');
  });
});

test('VS Code Web workbench bootstrap is emitted when official static assets are prepared and assets remain authenticated', async () => {
  const previousAssetDir = process.env.FOXWARM_VSCODE_WEB_ASSET_DIR;
  const previousWorkspacePath = process.env.FOXWARM_VSCODE_WEB_WORKSPACE_PATH;
  try {
    await withTempDir(async (dirPath) => {
      process.env.FOXWARM_VSCODE_WEB_ASSET_DIR = dirPath;
      process.env.FOXWARM_VSCODE_WEB_WORKSPACE_PATH = path.join(dirPath, 'foxwarm.code-workspace');
      await fs.outputFile(path.join(dirPath, 'out/nls.messages.js'), '');
      await fs.outputFile(path.join(dirPath, 'out/vs/workbench/workbench.web.main.internal.css'), 'body{}');
      await fs.outputFile(path.join(dirPath, 'out/vs/workbench/workbench.web.main.internal.js'), `async function hvt(a,o){if(!crypto.subtle)throw new Error("'crypto.subtle' is not available so webviews will not work.");let e=JSON.stringify({parentOrigin:a,salt:o}),i=new TextEncoder().encode(e),n=await crypto.subtle.digest("sha-256",i);return r2o(n)}function r2o(a){return a} class ClipboardService { async hasResources(){try{let e=await ao().navigator.clipboard.read();return e.length>0}catch{}return this.resources.length>0} } export const URI = {}; export class Emitter {}; export function create() {}`);
      await fs.outputFile(path.join(dirPath, 'out/vs/workbench/contrib/webview/browser/pre/index.html'), `<meta http-equiv="Content-Security-Policy" content="script-src 'sha256-old' 'self'">
<script async type="module">
const searchParams = new URLSearchParams(location.search);
const disableServiceWorker = searchParams.has('disableServiceWorker');
const parentOrigin = searchParams.get('parentOrigin');
const hostname = location.hostname;

if (!crypto.subtle) {
  throw new Error('missing subtle');
}
if (hostname === parentOriginHash || hostname.startsWith(parentOriginHash + '.')) {
  start(parentOrigin);
}
</script>`);

      await withServer(async (_server, baseUrl) => {
        const noAuthStatic = await fetch(`${baseUrl}/vscode-web/static/out/nls.messages.js`);
        assert.equal(noAuthStatic.status, 401);

        const staticWithCookie = await fetch(`${baseUrl}/vscode-web/static/out/nls.messages.js`, { headers: cookieHeaders() });
        assert.equal(staticWithCookie.status, 200);

        const folderUri = 'foxwarm://node+master/tmp/hello%20world';
        const workbench = await fetch(`${baseUrl}/vscode-web?folderUri=${encodeURIComponent(folderUri)}`, { headers: cookieHeaders() });
        assert.equal(workbench.status, 200);
        const html = await workbench.text();
        assert.match(html, /vscode-workbench-web-configuration/);
        assert.match(html, /foxwarm-code-bridge/);
        assert.match(html, /foxwarm-fs\.handleOpenRequest/);
        assert.match(html, /foxwarm-scm\.openCommitDetails/);
        assert.match(html, /Unsupported Foxwarm Code bridge request/);
        assert.match(html, /openCommitId/);
        assert.match(html, /__foxwarmSha256Digest/);
        assert.match(html, /trimTrailingSlash\(webviewOrigin\) \+ routePath/);
        assert.match(html, /\/vscode-web\/static\/out\/vs\/workbench\/workbench\.web\.main\.internal\.js/);
        assert.match(html, /\/vscode-web\/static\/out\/vs\/workbench\/workbench\.web\.main\.internal\.css/);
        assert.match(html, /\/vscode-web\/extensions\/foxwarm-fs/);
        assert.match(html, /\/vscode-web\/extensions\/foxwarm-terminal/);
        assert.match(html, /\/vscode-web\/extensions\/foxwarm-scm/);
        assert.match(html, /\/vscode-web\/extensions\/foxwarm-webui/);
        assert.match(html, /&quot;scheme&quot;:&quot;foxwarm&quot;/);
        assert.match(html, /&quot;authority&quot;:&quot;node\+master&quot;/);
        assert.match(html, /&quot;path&quot;:&quot;\/tmp\/hello%20world&quot;/);
        assert.match(html, /window\.menuBarVisibility/);
        assert.match(html, /&quot;visible&quot;/);
        assert.match(html, /terminal\.integrated\.defaultProfile\.linux/);
        const webviewCapability = html.match(/\/vscode-web\/webview\/([0-9a-f]{48})\//)?.[1];
        assert.ok(webviewCapability);
        assert.match(html, new RegExp(`http:\\/\\/\\{\\{uuid\\}\\}\\.localhost:${new URL(baseUrl).port}\\/vscode-web\\/webview\\/${webviewCapability}\\/`));
        const webviewBootstrap = await fetch(`${baseUrl}/vscode-web/webview/${webviewCapability}/index.html`);
        assert.equal(webviewBootstrap.status, 200);
        const webviewBootstrapHtml = await webviewBootstrap.text();
        assert.match(webviewBootstrapHtml, /new URL\(parentOrigin\)\.origin === new URL\(location\.href\)\.origin/);
        assert.match(webviewBootstrapHtml, /!window\.isSecureContext/);
        assert.match(webviewBootstrapHtml, /parentOrigin.*window\.location\.origin/);
        assert.match(webviewBootstrapHtml, /return start\(parentOrigin\)/);
        assert.doesNotMatch(webviewBootstrapHtml, /sha256-old/);
        const instancedWebviewBootstrap = await fetch(`${baseUrl}/vscode-web/webview/${webviewCapability}/unit-instance/index.html`);
        assert.equal(instancedWebviewBootstrap.status, 200);
        assert.equal(await instancedWebviewBootstrap.text(), webviewBootstrapHtml);
        const patchedWorkbench = await fetch(`${baseUrl}/vscode-web/static/out/vs/workbench/workbench.web.main.internal.js`, { headers: cookieHeaders() });
        assert.equal(patchedWorkbench.status, 200);
        const patchedWorkbenchSource = await patchedWorkbench.text();
        assert.match(patchedWorkbenchSource, /globalThis\.__foxwarmSha256Digest/);
        assert.doesNotMatch(patchedWorkbenchSource, /if\(!crypto\.subtle\)throw/);
        assert.match(patchedWorkbenchSource, /Firefox\\\/.*this\.resources\.length/);
        assert.doesNotMatch(patchedWorkbenchSource, /async hasResources\(\)\{try\{let e=await ao\(\)\.navigator\.clipboard\.read/);
        const wrongCapability = await fetch(`${baseUrl}/vscode-web/webview/${'0'.repeat(48)}/index.html`);
        assert.equal(wrongCapability.status, 404);

        const embeddedWorkbench = await fetch(`${baseUrl}/vscode-web?embedded=true&initialFolderUri=${encodeURIComponent(folderUri)}`, { headers: cookieHeaders() });
        assert.equal(embeddedWorkbench.status, 200);
        const embeddedHtml = await embeddedWorkbench.text();
        assert.match(embeddedHtml, /&quot;workspaceUri&quot;/);
        assert.match(embeddedHtml, /foxwarm\.code-workspace/);
      });
    });
  } finally {
    if (previousWorkspacePath === undefined) {
      delete process.env.FOXWARM_VSCODE_WEB_WORKSPACE_PATH;
    } else {
      process.env.FOXWARM_VSCODE_WEB_WORKSPACE_PATH = previousWorkspacePath;
    }
    if (previousAssetDir === undefined) {
      delete process.env.FOXWARM_VSCODE_WEB_ASSET_DIR;
    } else {
      process.env.FOXWARM_VSCODE_WEB_ASSET_DIR = previousAssetDir;
    }
  }
});

test('VS Code Web workbench bootstrap honors forwarded base path prefixes', async () => {
  const previousAssetDir = process.env.FOXWARM_VSCODE_WEB_ASSET_DIR;
  try {
    await withTempDir(async (dirPath) => {
      process.env.FOXWARM_VSCODE_WEB_ASSET_DIR = dirPath;
      await fs.outputFile(path.join(dirPath, 'out/nls.messages.js'), '');
      await fs.outputFile(path.join(dirPath, 'out/vs/workbench/workbench.web.main.internal.css'), 'body{}');
      await fs.outputFile(path.join(dirPath, 'out/vs/workbench/workbench.web.main.internal.js'), 'export const URI = {}; export class Emitter {}; export function create() {}');

      await withServer(async (_server, baseUrl) => {
        const workbench = await fetch(`${baseUrl}/vscode-web`, {
          headers: cookieHeaders({
            'x-forwarded-prefix': '/proxy-prefix',
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'example.test',
          }),
        });
        assert.equal(workbench.status, 200);
        const html = await workbench.text();
        assert.match(html, /\/proxy-prefix\/vscode-web\/static\/out\/nls\.messages\.js/);
        assert.match(html, /\/proxy-prefix\/vscode-web\/static\/out\/vs\/workbench\/workbench\.web\.main\.internal\.js/);
        assert.match(html, /\/proxy-prefix\/vscode-web\/extensions\/foxwarm-fs/);
        assert.match(html, /\/proxy-prefix\/vscode-web\/extensions\/foxwarm-terminal/);
        assert.match(html, /\/proxy-prefix\/vscode-web\/extensions\/foxwarm-scm/);
        assert.match(html, /\/proxy-prefix\/vscode-web\/extensions\/foxwarm-webui/);
        assert.match(html, /\/proxy-prefix\/vscode-web\/webview\/[0-9a-f]{48}\//);
        assert.match(html, /https:\/\/example\.test\/proxy-prefix\/vscode-web\/webview\/[0-9a-f]{48}\/\{\{uuid\}\}\//);
        assert.match(html, /&quot;webEndpointUrlTemplate&quot;:&quot;https:\/\/example\.test\/proxy-prefix\/vscode-web\/static&quot;/);
        assert.match(html, /&quot;path&quot;:&quot;\/proxy-prefix\/vscode-web\/extensions\/foxwarm-fs&quot;/);
        assert.match(html, /&quot;callbackRoute&quot;:&quot;\/proxy-prefix\/vscode-web\/callback&quot;/);
        assert.doesNotMatch(html, /https:\/\/example\.test\/vscode-web\/static/);
        assert.doesNotMatch(html, /href="\/vscode-web\/static/);
      });
    });
  } finally {
    if (previousAssetDir === undefined) {
      delete process.env.FOXWARM_VSCODE_WEB_ASSET_DIR;
    } else {
      process.env.FOXWARM_VSCODE_WEB_ASSET_DIR = previousAssetDir;
    }
  }
});

test('VS Code Web workbench bootstrap can use relative assets from a trailing-slash route', async () => {
  const previousAssetDir = process.env.FOXWARM_VSCODE_WEB_ASSET_DIR;
  try {
    await withTempDir(async (dirPath) => {
      process.env.FOXWARM_VSCODE_WEB_ASSET_DIR = dirPath;
      await fs.outputFile(path.join(dirPath, 'out/nls.messages.js'), '');
      await fs.outputFile(path.join(dirPath, 'out/vs/workbench/workbench.web.main.internal.css'), 'body{}');
      await fs.outputFile(path.join(dirPath, 'out/vs/workbench/workbench.web.main.internal.js'), 'export const URI = {}; export class Emitter {}; export function create() {}');

      await withServer(async (_server, baseUrl) => {
        const workbench = await fetch(`${baseUrl}/vscode-web/`, { headers: cookieHeaders() });
        assert.equal(workbench.status, 200);
        const html = await workbench.text();
        assert.match(html, /href="\.\/static\/favicon\.ico"/);
        assert.match(html, /src="\.\/static\/out\/nls\.messages\.js"/);
        assert.match(html, /import \{ create, commands, Emitter, URI \} from '\.\/static\/out\/vs\/workbench\/workbench\.web\.main\.internal\.js'/);
        assert.match(html, /new URL\('static', routeBaseUrl\)/);
        assert.match(html, /extensionUrl\('extensions\/foxwarm-terminal'\)/);
      });
    });
  } finally {
    if (previousAssetDir === undefined) {
      delete process.env.FOXWARM_VSCODE_WEB_ASSET_DIR;
    } else {
      process.env.FOXWARM_VSCODE_WEB_ASSET_DIR = previousAssetDir;
    }
  }
});

test('VS Code Web git API reports status and returns base/working content', async () => {
  await withTempDir(async (repoPath) => {
    await execFileAsync('git', ['init'], { cwd: repoPath });
    await execFileAsync('git', ['config', 'user.email', 'foxwarm-test@example.invalid'], { cwd: repoPath });
    await execFileAsync('git', ['config', 'user.name', 'Foxwarm Test'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'tracked.txt'), 'before\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: repoPath });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoPath });
    const commitOid = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoPath })).stdout.trim();

    await fs.writeFile(path.join(repoPath, 'tracked.txt'), 'after\n');
    await fs.writeFile(path.join(repoPath, 'new.txt'), 'new file\n');

    await withServer(async (_server, baseUrl) => {
      const statusNoAuth = await fetch(`${baseUrl}/api/vscode-web/git/status?nodeId=master&workspace=${encodeURIComponent(repoPath)}`);
      assert.equal(statusNoAuth.status, 401);

      const status = await fetch(`${baseUrl}/api/vscode-web/git/status?nodeId=master&workspace=${encodeURIComponent(repoPath)}`, { headers: bearerHeaders() });
      assert.equal(status.status, 200);
      const payload = await status.json() as { changes: Array<{ path: string; kind: string; indexStatus: string; workingTreeStatus: string }> };
      assert.deepEqual(payload.changes.map((change) => [change.path, change.kind]).sort(), [['new.txt', 'untracked'], ['tracked.txt', 'modified']]);

      const base = await fetch(`${baseUrl}/api/vscode-web/git/content?nodeId=master&workspace=${encodeURIComponent(repoPath)}&path=tracked.txt&side=base`, { headers: bearerHeaders() });
      assert.equal(base.status, 200);
      assert.equal(await base.text(), 'before\n');

      const working = await fetch(`${baseUrl}/api/vscode-web/git/content?nodeId=master&workspace=${encodeURIComponent(repoPath)}&path=tracked.txt&side=working`, { headers: bearerHeaders() });
      assert.equal(working.status, 200);
      assert.equal(await working.text(), 'after\n');

      const addedBase = await fetch(`${baseUrl}/api/vscode-web/git/content?nodeId=master&workspace=${encodeURIComponent(repoPath)}&path=new.txt&side=base`, { headers: bearerHeaders() });
      assert.equal(addedBase.status, 200);
      assert.equal(await addedBase.text(), '');

      const commitDetails = await fetch(`${baseUrl}/api/vscode-web/git/commit?nodeId=master&workspace=${encodeURIComponent(repoPath)}&id=${commitOid.slice(0, 9)}`, { headers: bearerHeaders() });
      assert.equal(commitDetails.status, 200);
      const commitPayload = await commitDetails.json() as { workspace: string; commit: { oid: string; subject: string }; comparison: { mode: string }; files: Array<{ path: string }> };
      assert.equal(commitPayload.workspace, repoPath);
      assert.equal(commitPayload.commit.oid, commitOid);
      assert.equal(commitPayload.commit.subject, 'initial');
      assert.equal(commitPayload.comparison.mode, 'empty-tree');
      assert.deepEqual(commitPayload.files.map((file) => file.path), ['tracked.txt']);

      const immutableContent = await fetch(`${baseUrl}/api/vscode-web/git/content?nodeId=master&workspace=${encodeURIComponent(repoPath)}&path=tracked.txt&side=base&ref=${commitOid}`, { headers: bearerHeaders() });
      assert.equal(await immutableContent.text(), 'before\n');
      const unsafeRef = await fetch(`${baseUrl}/api/vscode-web/git/content?nodeId=master&workspace=${encodeURIComponent(repoPath)}&path=tracked.txt&side=base&ref=${encodeURIComponent('HEAD~1')}`, { headers: bearerHeaders() });
      assert.equal(unsafeRef.status, 422);
    });
  });
});

test('VS Code Web filesystem and Git APIs dispatch to an advertised remote node service', async () => {
  await withTempDir(async (remotePath) => {
    const nodeId = `vscode-remote-${Date.now()}`;
    const fakeSocket = {
      send(raw: string) {
        const message = JSON.parse(raw);
        if (message.type !== 'node_service_request') return;
        void executeVscodeNodeService(message.service, message.operation, message.args)
          .then((result) => nodesManager.handleNodeServiceResponse(nodeId, message.requestId, result))
          .catch((error) => nodesManager.handleNodeServiceError(nodeId, message.requestId, serializeVscodeNodeServiceError(error)));
      },
      close() {},
    } as unknown as WebSocket;
    nodesManager.registerNodeWithTools(fakeSocket, {} as any, 'cli-node', {
      tools: [],
      services: { 'vscode-fs': 1, 'vscode-git': 2 },
    }, nodeId);
    try {
      await fs.writeFile(path.join(remotePath, 'remote.txt'), 'remote before\n');
      await execFileAsync('git', ['init'], { cwd: remotePath });
      await execFileAsync('git', ['config', 'user.email', 'foxwarm-test@example.invalid'], { cwd: remotePath });
      await execFileAsync('git', ['config', 'user.name', 'Foxwarm Test'], { cwd: remotePath });
      await execFileAsync('git', ['add', 'remote.txt'], { cwd: remotePath });
      await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: remotePath });
      const remoteCommitOid = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: remotePath })).stdout.trim();
      await fs.writeFile(path.join(remotePath, 'remote.txt'), 'remote after\n');

      await withServer(async (_server, baseUrl) => {
        const stat = await fetch(`${baseUrl}/api/vscode-web/fs/stat?nodeId=${nodeId}&path=${encodeURIComponent(path.join(remotePath, 'remote.txt'))}`, { headers: bearerHeaders() });
        assert.equal(stat.status, 200);
        assert.equal((await stat.json() as { type: number }).type, 1);

        const read = await fetch(`${baseUrl}/api/vscode-web/fs/read-file?nodeId=${nodeId}&path=${encodeURIComponent(path.join(remotePath, 'remote.txt'))}`, { headers: bearerHeaders() });
        assert.equal(await read.text(), 'remote after\n');

        const writePath = path.join(remotePath, 'created.txt');
        const write = await fetch(`${baseUrl}/api/vscode-web/fs/write-file?nodeId=${nodeId}&path=${encodeURIComponent(writePath)}&create=1&overwrite=0`, {
          method: 'PUT', headers: bearerHeaders({ 'Content-Type': 'application/octet-stream' }), body: 'created remotely\n',
        });
        assert.equal(write.status, 200);
        assert.equal(await fs.readFile(writePath, 'utf8'), 'created remotely\n');

        const status = await fetch(`${baseUrl}/api/vscode-web/git/status?nodeId=${nodeId}&workspace=${encodeURIComponent(remotePath)}`, { headers: bearerHeaders() });
        assert.equal(status.status, 200);
        const payload = await status.json() as { nodeId: string; changes: Array<{ path: string }> };
        assert.equal(payload.nodeId, nodeId);
        assert.deepEqual(payload.changes.map((change) => change.path).sort(), ['created.txt', 'remote.txt']);

        const commitDetails = await fetch(`${baseUrl}/api/vscode-web/git/commit?nodeId=${nodeId}&workspace=${encodeURIComponent(remotePath)}&id=${remoteCommitOid.slice(0, 8)}`, { headers: bearerHeaders() });
        assert.equal(commitDetails.status, 200);
        const commitPayload = await commitDetails.json() as { nodeId: string; commit: { oid: string } };
        assert.equal(commitPayload.nodeId, nodeId);
        assert.equal(commitPayload.commit.oid, remoteCommitOid);
      });
    } finally {
      nodesManager.unregisterNode(nodeId, fakeSocket);
    }
  });
});

test('VS Code Web commit API requires vscode-git service version 2 on remote nodes', async () => {
  await withTempDir(async (repoPath) => {
    await execFileAsync('git', ['init'], { cwd: repoPath });
    await execFileAsync('git', ['config', 'user.email', 'foxwarm-test@example.invalid'], { cwd: repoPath });
    await execFileAsync('git', ['config', 'user.name', 'Foxwarm Test'], { cwd: repoPath });
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'value\n');
    await execFileAsync('git', ['add', 'file.txt'], { cwd: repoPath });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: repoPath });
    const oid = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repoPath })).stdout.trim();
    const nodeId = `vscode-git-v1-${Date.now()}`;
    const fakeSocket = {
      send(raw: string) {
        if (JSON.parse(raw).type === 'node_service_request') throw new Error('v1 node should be rejected before dispatch');
      },
      close() {},
    } as unknown as WebSocket;
    nodesManager.registerNodeWithTools(fakeSocket, {} as any, 'cli-node', { tools: [], services: { 'vscode-git': 1 } }, nodeId);
    try {
      await withServer(async (_server, baseUrl) => {
        const response = await fetch(`${baseUrl}/api/vscode-web/git/commit?nodeId=${nodeId}&workspace=${encodeURIComponent(repoPath)}&id=${oid}`, { headers: bearerHeaders() });
        assert.equal(response.status, 501);
        assert.match((await response.json() as { error: string }).error, /version 2 or newer/);
      });
    } finally {
      nodesManager.unregisterNode(nodeId, fakeSocket);
    }
  });
});

test('VS Code Web git status reports submodule commit changes without a separate git diff', async () => {
  await withTempDir(async (dirPath) => {
    const sourcePath = path.join(dirPath, 'submodule-source');
    const repoPath = path.join(dirPath, 'parent');
    await fs.ensureDir(sourcePath);
    await fs.ensureDir(repoPath);
    for (const target of [sourcePath, repoPath]) {
      await execFileAsync('git', ['init'], { cwd: target });
      await execFileAsync('git', ['config', 'user.email', 'foxwarm-test@example.invalid'], { cwd: target });
      await execFileAsync('git', ['config', 'user.name', 'Foxwarm Test'], { cwd: target });
    }
    await fs.writeFile(path.join(sourcePath, 'tracked.txt'), 'before\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: sourcePath });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: sourcePath });
    await execFileAsync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', sourcePath, 'modules/sub'], { cwd: repoPath });
    await execFileAsync('git', ['commit', '-m', 'add submodule'], { cwd: repoPath });

    const checkoutPath = path.join(repoPath, 'modules/sub');
    await execFileAsync('git', ['config', 'user.email', 'foxwarm-test@example.invalid'], { cwd: checkoutPath });
    await execFileAsync('git', ['config', 'user.name', 'Foxwarm Test'], { cwd: checkoutPath });
    const oldOid = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath })).stdout.trim();
    await fs.writeFile(path.join(checkoutPath, 'tracked.txt'), 'after\n');
    await execFileAsync('git', ['add', 'tracked.txt'], { cwd: checkoutPath });
    await execFileAsync('git', ['commit', '-m', 'advance submodule'], { cwd: checkoutPath });
    const newOid = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: checkoutPath })).stdout.trim();

    await withServer(async (_server, baseUrl) => {
      const workspace = path.join(repoPath, 'modules');
      const status = await fetch(`${baseUrl}/api/vscode-web/git/status?nodeId=master&workspace=${encodeURIComponent(workspace)}`, { headers: bearerHeaders() });
      assert.equal(status.status, 200);
      const payload = await status.json() as {
        workspace: string;
        changes: Array<{ path: string; submodule?: { headOid: string; indexOid: string; worktreeOid?: string; dirty: boolean } }>;
      };
      assert.equal(payload.workspace, repoPath);
      const change = payload.changes.find((candidate) => candidate.path === 'modules/sub');
      assert.deepEqual(change?.submodule, {
        headOid: oldOid,
        indexOid: oldOid,
        worktreeOid: newOid,
        dirty: false,
      });
    });
  });
});

test('VS Code Web git API rejects unavailable/invalid nodes and path traversal', async () => {
  await withTempDir(async (repoPath) => {
    await execFileAsync('git', ['init'], { cwd: repoPath });
    await withServer(async (_server, baseUrl) => {
      const unavailableNode = await fetch(`${baseUrl}/api/vscode-web/git/status?nodeId=worker&workspace=${encodeURIComponent(repoPath)}`, { headers: bearerHeaders() });
      assert.equal(unavailableNode.status, 503);
      assert.equal((await unavailableNode.json() as { code?: string }).code, 'NodeUnavailable');

      const invalidNode = await fetch(`${baseUrl}/api/vscode-web/git/status?nodeId=bad%20node&workspace=${encodeURIComponent(repoPath)}`, { headers: bearerHeaders() });
      assert.equal(invalidNode.status, 400);
      assert.equal((await invalidNode.json() as { code?: string }).code, 'InvalidNode');

      const traversal = await fetch(`${baseUrl}/api/vscode-web/git/content?nodeId=master&workspace=${encodeURIComponent(repoPath)}&path=..%2Fsecret&side=working`, { headers: bearerHeaders() });
      assert.equal(traversal.status, 400);
      assert.equal((await traversal.json() as { code?: string }).code, 'InvalidPath');
    });
  });
});
