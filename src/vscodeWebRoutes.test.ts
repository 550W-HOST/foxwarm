import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { HttpServer } from './httpServer';
import { registerVscodeWebRoutes } from './vscodeWebRoutes';

const TEST_TOKEN = 'secret-token';

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
    assert.equal(routeWithBearer.status, 200);
    assert.match(await routeWithBearer.text(), /Foxwarm VS Code Web spike route|vscode-workbench-web-configuration/);

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

    const fsNoAuth = await fetch(`${baseUrl}/api/vscode-web/fs/stat?nodeId=master&path=${encodeURIComponent(__filename)}`);
    assert.equal(fsNoAuth.status, 401);

    const fsWithBearer = await fetch(`${baseUrl}/api/vscode-web/fs/stat?nodeId=master&path=${encodeURIComponent(__filename)}`, { headers: bearerHeaders() });
    assert.equal(fsWithBearer.status, 200);
    const statPayload = await fsWithBearer.json() as { type?: number };
    assert.equal(statPayload.type, 1);
  });
});

test('VS Code Web filesystem API is master-only and rejects non-absolute paths', async () => {
  await withServer(async (_server, baseUrl) => {
    const unsupportedNode = await fetch(`${baseUrl}/api/vscode-web/fs/stat?nodeId=worker-a&path=${encodeURIComponent(__filename)}`, { headers: bearerHeaders() });
    assert.equal(unsupportedNode.status, 400);
    const unsupportedNodePayload = await unsupportedNode.json() as { code?: string };
    assert.equal(unsupportedNodePayload.code, 'UnsupportedNode');

    const relativePath = await fetch(`${baseUrl}/api/vscode-web/fs/stat?nodeId=master&path=relative/path`, { headers: bearerHeaders() });
    assert.equal(relativePath.status, 400);
    const relativePathPayload = await relativePath.json() as { code?: string };
    assert.equal(relativePathPayload.code, 'InvalidPath');
  });
});

test('VS Code Web workbench bootstrap is emitted when official static assets are prepared and assets remain authenticated', async () => {
  const previousAssetDir = process.env.FOXWARM_VSCODE_WEB_ASSET_DIR;
  try {
    await withTempDir(async (dirPath) => {
      process.env.FOXWARM_VSCODE_WEB_ASSET_DIR = dirPath;
      await fs.outputFile(path.join(dirPath, 'out/nls.messages.js'), '');
      await fs.outputFile(path.join(dirPath, 'out/vs/workbench/workbench.web.main.internal.css'), 'body{}');
      await fs.outputFile(path.join(dirPath, 'out/vs/workbench/workbench.web.main.internal.js'), 'export const URI = {}; export class Emitter {}; export function create() {}');

      await withServer(async (_server, baseUrl) => {
        const noAuthStatic = await fetch(`${baseUrl}/vscode-web/static/out/nls.messages.js`);
        assert.equal(noAuthStatic.status, 401);

        const staticWithCookie = await fetch(`${baseUrl}/vscode-web/static/out/nls.messages.js`, { headers: cookieHeaders() });
        assert.equal(staticWithCookie.status, 200);

        const folderUri = 'foxwarm://node/master/tmp/hello%20world';
        const workbench = await fetch(`${baseUrl}/vscode-web?folderUri=${encodeURIComponent(folderUri)}`, { headers: cookieHeaders() });
        assert.equal(workbench.status, 200);
        const html = await workbench.text();
        assert.match(html, /vscode-workbench-web-configuration/);
        assert.match(html, /\/vscode-web\/static\/out\/vs\/workbench\/workbench\.web\.main\.internal\.js/);
        assert.match(html, /\/vscode-web\/static\/out\/vs\/workbench\/workbench\.web\.main\.internal\.css/);
        assert.match(html, /\/vscode-web\/extensions\/foxwarm-fs/);
        assert.match(html, /\/vscode-web\/extensions\/foxwarm-terminal/);
        assert.match(html, /&quot;scheme&quot;:&quot;foxwarm&quot;/);
        assert.match(html, /&quot;authority&quot;:&quot;node&quot;/);
        assert.match(html, /&quot;path&quot;:&quot;\/master\/tmp\/hello%20world&quot;/);
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
        assert.match(html, /import \{ create, Emitter, URI \} from '\.\/static\/out\/vs\/workbench\/workbench\.web\.main\.internal\.js'/);
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
