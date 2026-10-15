import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { HttpServer } from './httpServer';
import { McpOAuthService, setMcpOAuthServiceForTests } from './mcpOAuth';
import { registerMcpOAuthRoutes } from './mcpOAuthRoutes';
import * as client from './mcpClient';
import { closeMcpCallerConnections } from './mcpCallerConnections';
import { createMcpOAuthFixture } from './mcpOAuthTestFixture';

/** Isolated browser fixture: real administrator cookie, TLS prefix proxy, AS and MCP. */
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-oauth-browser-'));
  const keyPath = path.join(directory, 'key.pem');
  const certPath = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' });
  const certificate = fs.readFileSync(certPath);
  const resource = await createMcpOAuthFixture();
  resource.state.browserConsent = true;
  const root = path.resolve(__dirname, '..');
  const webuiRoot = path.join(root, 'packages', 'webui');
  const { createServer } = require(path.join(webuiRoot, 'node_modules', 'vite'));
  const vite = await createServer({ root: webuiRoot, cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, proxy: {} }, logLevel: 'error' });
  await vite.listen();
  const vitePort = vite.httpServer.address().port;
  const main = new HttpServer(0, 'fixture-admin');
  main.setWebUiIdentityVerifier(token => token === 'fixture-scoped' ? { role: 'webui', identityId: 'scoped', sessionIds: [] } : null);
  main.app.use((req, _res, next) => {
    if (req.url === '/preview') req.url = '/';
    else if (req.url.startsWith('/preview/')) req.url = req.url.slice('/preview'.length);
    next();
  });
  const callback = { cookieOnRedirect: false, cookieOnComplete: false };
  main.app.use((req, _res, next) => {
    if (req.path === '/api/mcp/oauth/callback') callback.cookieOnRedirect = !!req.headers.cookie?.includes('foxwarm_token=');
    if (req.path === '/api/mcp/oauth/complete') callback.cookieOnComplete = !!req.headers.cookie?.includes('foxwarm_token=');
    next();
  });
  const listener = https.createServer({ key: fs.readFileSync(keyPath), cert: certificate }, main.app);
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  const publicBaseUrl = `https://localhost:${port}/preview`;
  client.setMcpConfigStoreForTests(client.createMcpConfigStore(path.join(directory, 'mcp.json')));
  const service = new McpOAuthService({ publicBaseUrl, filePath: path.join(directory, 'mcp-oauth.json'),
    getServer: async name => (await client.getServers())[name] });
  setMcpOAuthServiceForTests(service);
  resource.state.fetchClientMetadata = url => new Promise((resolve, reject) => {
    const req = https.get(url, { ca: certificate }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (error) { reject(error); } });
    });
    req.on('error', reject);
  });
  await client.upsertServer('Fixture MCP', { transport: 'streamable-http', url: resource.resource });
  registerMcpOAuthRoutes(main);
  main.addRoute({ path: '/api/auth', method: 'POST', noAuth: true, handler: async (req, res) => {
    if (!['fixture-admin', 'fixture-scoped'].includes(req.body?.token)) { res.status(401).json({ error: 'Unauthorized' }); return; }
    res.json({ success: true });
  } });
  main.addRoute({ path: '/api/setup/status', method: 'GET', handler: async (_req, res) => {
    res.json({ oobe: false, models: { exists: true, hasPlaceholderSecrets: false, rawYaml: 'default: fixture\nproviders: {}',
      path: 'state/models.yaml', templatePath: 'templates/models.example.yaml', providerCount: 1, defaultModel: 'fixture', placeholderProviders: [] },
      config: { appConfigPath: 'state/config.yaml', rawYaml: '{}', channelsYaml: '{}', channelCount: 0 }, channels: [] });
  } });
  main.addRoute({ path: '/api/test/registration', method: 'POST', handler: async (req, res) => {
    if (!['cimd', 'dcr', 'none'].includes(req.body.mode)) { res.status(400).json({ error: 'Invalid fixture mode' }); return; }
    resource.state.registration = req.body.mode;
    res.json({ success: true });
  } });
  main.addRoute({ path: '/api/test/state', method: 'GET', handler: async (_req, res) => {
    res.json({ registrations: resource.state.registrations, exchanges: resource.state.exchanges,
      grantStatus: await service.status('Fixture MCP', (await client.getServers())['Fixture MCP']), callback });
  } });
  main.addRoute({ path: '/api/test/missing-url', method: 'POST', handler: async (_req, res) => {
    setMcpOAuthServiceForTests(new McpOAuthService({ publicBaseUrl: '', filePath: path.join(directory, 'mcp-oauth.json'),
      getServer: async name => (await client.getServers())[name] }));
    res.json({ success: true });
  } });
  main.app.get('/', async (req, res) => {
    if (!await main.getAuthContext(req)) { res.type('html').send(fs.readFileSync(path.join(webuiRoot, 'public', 'login.html'), 'utf8')); return; }
    const html = fs.readFileSync(path.join(webuiRoot, 'test', 'authorizationsHarness.html'), 'utf8');
    res.type('html').send(await vite.transformIndexHtml('/test/authorizationsHarness.html', html));
  });
  main.app.use((req, res) => {
    const proxy = http.request({ hostname: '127.0.0.1', port: vitePort, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode || 500, response.headers);
      response.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) res.status(502).send('Fixture preview unavailable'); });
    req.pipe(proxy);
  });
  process.stdout.write(`${JSON.stringify({ ready: true, url: `${publicBaseUrl}/`, resourceUrl: resource.resource })}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await closeMcpCallerConnections();
    await resource.close();
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
    await vite.close();
    fs.rmSync(directory, { recursive: true, force: true });
  };
  process.once('SIGTERM', () => { void stop().then(() => process.exit(0)); });
  process.once('SIGINT', () => { void stop().then(() => process.exit(0)); });
}
if (require.main === module) void main().catch(() => { process.stderr.write('OAuth browser fixture failed to start.\n'); process.exitCode = 1; });
