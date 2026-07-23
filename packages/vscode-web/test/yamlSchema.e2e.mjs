import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(testDir, '..');
const repoRoot = path.resolve(packageRoot, '../..');
const workbenchDir = process.env.FOXWARM_VSCODE_WEB_ASSET_DIR || path.join(packageRoot, 'assets', 'vscode-web');
const yamlExtensionDir = process.env.FOXWARM_VSCODE_YAML_EXTENSION_DIR || path.join(packageRoot, 'assets', 'extensions', 'redhat.vscode-yaml');
const chromium = process.env.CHROMIUM_PATH || '/usr/bin/chromium';
const assetsReady = fsSync.existsSync(path.join(workbenchDir, 'out/vs/workbench/workbench.web.main.internal.js'))
  && fsSync.existsSync(path.join(yamlExtensionDir, 'dist/extension-web.js'))
  && fsSync.existsSync(chromium);

async function chord(page, key) {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
}

async function inspectYaml(browser, baseUrl, token, nodeId, filePath) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const externalRequests = [];
  page.on('request', (request) => {
    const requested = new URL(request.url());
    if ((requested.protocol === 'http:' || requested.protocol === 'https:') && requested.origin !== new URL(baseUrl).origin) {
      externalRequests.push(request.url());
    }
  });
  await page.setCookie({ name: 'foxwarm_token', value: token, url: baseUrl });
  const url = `${baseUrl}/vscode-web/?embedded=true&initialFolderUri=${encodeURIComponent(`foxwarm://node+master${path.dirname(path.dirname(filePath))}`)}&openFileNodeId=${encodeURIComponent(nodeId)}&openFilePath=${encodeURIComponent(filePath)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.editor-instance .view-lines')?.textContent.trim(), { timeout: 30_000 });
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  const diagnostics = await page.$$eval('.squiggly-error', (elements) => elements.length);
  const notifications = await page.$$eval('.notifications-toasts .notification-list-item', (elements) => elements.map((element) => element.textContent || ''));
  await page.click('.editor-instance .view-lines');
  await chord(page, 'End');
  await page.keyboard.press('Enter');
  await chord(page, 'Space');
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const suggestions = await page.$$eval('.suggest-widget.visible .monaco-list-row', (elements) => (
    elements.map((element) => element.getAttribute('aria-label') || element.textContent || '')
  ));
  await context.close();
  return { diagnostics, notifications, suggestions, externalRequests };
}

test('pinned Red Hat YAML Web extension applies shared schemas only to exact master config files', { skip: !assetsReady, timeout: 90_000 }, async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-code-yaml-schema-'));
  const stateDir = path.join(dataDir, 'state');
  const workspacePath = path.join(stateDir, 'vscode-web', 'foxwarm.code-workspace');
  const modelsPath = path.join(stateDir, 'models.yaml');
  const appPath = path.join(stateDir, 'config.yaml');
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  await fs.writeFile(modelsPath, 'default: 42\nproviders:\n  demo:\n    providerType: openai\n    models:\n      - demo-model\n');
  await fs.writeFile(appPath, 'bot:\n  httpPort: invalid\n');
  await fs.writeFile(workspacePath, JSON.stringify({
    folders: [
      { uri: `foxwarm://node+master${dataDir}`, name: 'Master Data' },
      { uri: `foxwarm://node+yaml-e2e-remote${dataDir}`, name: 'Remote Data' },
    ],
    settings: {
      'redhat.telemetry.enabled': false,
      'yaml.schemaStore.enable': false,
      'yaml.kubernetesCRDStore.enable': false,
      'yaml.extension.recommendations': false,
    },
  }));

  const previous = {
    dataDir: process.env.FOXWARM_DATA_DIR,
    workbenchDir: process.env.FOXWARM_VSCODE_WEB_ASSET_DIR,
    yamlExtensionDir: process.env.FOXWARM_VSCODE_YAML_EXTENSION_DIR,
  };
  process.env.FOXWARM_DATA_DIR = dataDir;
  process.env.FOXWARM_VSCODE_WEB_ASSET_DIR = workbenchDir;
  process.env.FOXWARM_VSCODE_YAML_EXTENSION_DIR = yamlExtensionDir;

  const require = createRequire(import.meta.url);
  const { HttpServer } = require(path.join(repoRoot, 'lib/httpServer.js'));
  const { registerVscodeWebRoutes } = require(path.join(repoRoot, 'lib/vscodeWebRoutes.js'));
  const { nodesManager } = require(path.join(repoRoot, 'lib/nodes/manager.js'));
  const { executeVscodeNodeService, serializeVscodeNodeServiceError } = require(path.join(repoRoot, 'packages/shared/dist/vscodeNodeService.js'));
  const remoteNodeId = 'yaml-e2e-remote';
  const fakeSocket = {
    send(raw) {
      const message = JSON.parse(raw);
      if (message.type !== 'node_service_request') return;
      void executeVscodeNodeService(message.service, message.operation, message.args)
        .then((result) => nodesManager.handleNodeServiceResponse(remoteNodeId, message.requestId, result))
        .catch((error) => nodesManager.handleNodeServiceError(remoteNodeId, message.requestId, serializeVscodeNodeServiceError(error)));
    },
    close() {},
  };
  nodesManager.registerNodeWithTools(fakeSocket, {}, 'cli-node', { tools: [], services: { 'vscode-fs': 1 } }, remoteNodeId);

  const port = 34_000 + Math.floor(Math.random() * 1_000);
  const token = 'yaml-schema-e2e-token';
  const server = new HttpServer(port, token);
  registerVscodeWebRoutes(server);
  await server.start();
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath: chromium, headless: true, args: ['--no-sandbox'] });
    const baseUrl = `http://127.0.0.1:${port}`;
    const models = await inspectYaml(browser, baseUrl, token, 'master', modelsPath);
    assert.ok(models.diagnostics > 0);
    assert.ok(models.suggestions.some((label) => label === 'models, Property'));
    assert.equal(models.notifications.some((text) => /Help Red Hat improve/.test(text)), false);
    assert.deepEqual(models.externalRequests, []);

    const app = await inspectYaml(browser, baseUrl, token, 'master', appPath);
    assert.ok(app.diagnostics > 0);
    assert.ok(app.suggestions.some((label) => label === 'llm, Property'));

    const remote = await inspectYaml(browser, baseUrl, token, remoteNodeId, modelsPath);
    assert.equal(remote.diagnostics, 0);
    assert.equal(remote.suggestions.some((label) => /, Property$/.test(label)), false);
  } finally {
    await browser?.close();
    await server.stop();
    nodesManager.unregisterNode(remoteNodeId, fakeSocket);
    await fs.rm(dataDir, { recursive: true, force: true });
    if (previous.dataDir === undefined) delete process.env.FOXWARM_DATA_DIR;
    else process.env.FOXWARM_DATA_DIR = previous.dataDir;
    if (previous.workbenchDir === undefined) delete process.env.FOXWARM_VSCODE_WEB_ASSET_DIR;
    else process.env.FOXWARM_VSCODE_WEB_ASSET_DIR = previous.workbenchDir;
    if (previous.yamlExtensionDir === undefined) delete process.env.FOXWARM_VSCODE_YAML_EXTENSION_DIR;
    else process.env.FOXWARM_VSCODE_YAML_EXTENSION_DIR = previous.yamlExtensionDir;
  }
});
