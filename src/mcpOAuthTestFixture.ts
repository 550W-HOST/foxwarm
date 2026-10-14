import express from 'express';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** Real loopback OAuth AS and MCP resource server, with auth before dispatch. */
export async function createMcpOAuthFixture() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  const listener = http.createServer(app);
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = (listener.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const issuer = `${baseUrl}/issuer`;
  const resource = `${baseUrl}/mcp`;
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const sseTransports = new Map<string, SSEServerTransport>();
  const tokens = new Map<string, { resource: string; scope: string }>();
  const refreshTokens = new Map<string, { resource: string; scope: string }>();
  const codes = new Map<string, Record<string, string>>();
  const peers = new Set<Server>();
  const state = {
    registration: 'dcr' as 'dcr' | 'cimd' | 'none', registrations: 0, exchanges: 0, refreshes: 0,
    effects: 0, contexts: 0, deletes: 0, force401: 0, requiredScope: '',
    mismatchIssuer: false, mismatchResource: false, pkce: true, invalidRefresh: false,
    asHeaders: [] as http.IncomingHttpHeaders[], registeredMetadata: [] as Record<string, unknown>[],
    resourceHeaders: [] as http.IncomingHttpHeaders[],
    fetchClientMetadata: undefined as undefined | ((url: string) => Promise<Record<string, unknown>>),
    browserConsent: false,
    refreshGate: undefined as Promise<void> | undefined,
    refreshEntered: undefined as (() => void) | undefined,
    echoCredential: false,
    issueRefreshTokens: true,
    tokenLifetime: 60,
    omitRefreshScope: false,
    imageData: undefined as string | undefined,
    deepResult: false,
  };
  const protectedResource = (pathname: string) => ({
    resource: state.mismatchResource ? `${baseUrl}/different` : `${baseUrl}${pathname}`,
    authorization_servers: [issuer], scopes_supported: ['read', 'write'],
  });
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(protectedResource('/mcp')));
  app.get('/.well-known/oauth-protected-resource/sse', (_req, res) => res.json(protectedResource('/sse')));
  app.get('/.well-known/oauth-authorization-server/issuer', (req, res) => {
    state.asHeaders.push(req.headers);
    res.json({ issuer: state.mismatchIssuer ? `${baseUrl}/evil` : issuer, authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`, response_types_supported: ['code'],
      ...(state.pkce ? { code_challenge_methods_supported: ['S256'] } : {}),
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
      authorization_response_iss_parameter_supported: true,
      ...(state.registration === 'cimd' ? { client_id_metadata_document_supported: true } : {}),
      ...(state.registration === 'dcr' ? { registration_endpoint: `${baseUrl}/register` } : {}),
    });
  });
  app.post('/register', (req, res) => {
    state.asHeaders.push(req.headers);
    state.registrations++;
    state.registeredMetadata.push(req.body);
    res.status(201).json({ ...req.body, client_id: `fixture-client-${state.registrations}`, client_secret: 'fixture-client-secret' });
  });
  app.get('/authorize', async (req, res) => {
    const params = Object.fromEntries(Object.entries(req.query).map(([key, value]) => [key, String(value)]));
    if (params.client_id.startsWith('https:')) {
      const metadata = await state.fetchClientMetadata?.(params.client_id);
      if (!metadata || metadata.client_id !== params.client_id
        || !(metadata.redirect_uris as string[])?.includes(params.redirect_uri)) {
        res.status(400).send('Invalid client metadata'); return;
      }
    }
    const code = randomUUID();
    codes.set(code, params);
    const callback = new URL(params.redirect_uri);
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', params.state);
    callback.searchParams.set('iss', issuer);
    if (state.browserConsent) {
      const href = callback.href.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      res.type('html').send(`<!doctype html><html><title>Fixture consent</title><h1>Allow Foxwarm to access Fixture MCP?</h1><a id="consent" href="${href}">Allow Fixture MCP</a></html>`);
    } else res.redirect(303, callback.href);
  });
  const issue = (binding: { resource: string; scope: string }) => {
    const access = randomUUID();
    const refresh = randomUUID();
    tokens.set(access, binding);
    refreshTokens.set(refresh, binding);
    return { access_token: access, ...(state.issueRefreshTokens ? { refresh_token: refresh } : {}),
      token_type: 'Bearer', expires_in: state.tokenLifetime, scope: binding.scope };
  };
  app.post('/token', async (req, res) => {
    state.asHeaders.push(req.headers);
    if (req.headers.authorization?.startsWith('Basic ')) {
      req.body.client_id = decodeURIComponent(Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')[0]);
    }
    if (req.body.grant_type === 'authorization_code') {
      const code = codes.get(req.body.code);
      codes.delete(req.body.code);
      const challenge = createHash('sha256').update(req.body.code_verifier || '').digest('base64url');
      if (!code || code.code_challenge !== challenge || code.redirect_uri !== req.body.redirect_uri
        || code.resource !== req.body.resource || code.client_id !== req.body.client_id) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'fixture-secret-must-not-escape' }); return;
      }
      state.exchanges++;
      res.json(issue({ resource: req.body.resource, scope: code.scope || 'read' }));
    } else if (req.body.grant_type === 'refresh_token') {
      const gate = state.refreshGate;
      state.refreshGate = undefined;
      state.refreshEntered?.();
      if (gate) await gate;
      const old = refreshTokens.get(req.body.refresh_token);
      refreshTokens.delete(req.body.refresh_token);
      if (!old || state.invalidRefresh || old.resource !== req.body.resource) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'fixture-secret-must-not-escape' }); return;
      }
      state.refreshes++;
      const refreshed = issue(old);
      if (state.omitRefreshScope) delete refreshed.scope;
      res.json(refreshed);
    } else res.status(400).json({ error: 'unsupported_grant_type' });
  });
  const authenticate: express.RequestHandler = (req, res, next) => {
    state.resourceHeaders.push(req.headers);
    const token = req.headers.authorization?.replace(/^Bearer /, '');
    const binding = tokens.get(token);
    const expectedResource = req.path === '/mcp' ? resource : `${baseUrl}/sse`;
    const reject = () => res.set('WWW-Authenticate', `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource${req.path === '/mcp' ? '/mcp' : '/sse'}"`).status(401).json({ error: 'invalid_token' });
    if (token !== 'fixture-static-token' && (!binding || binding.resource !== expectedResource)) { reject(); return; }
    if (state.force401 > 0) { state.force401--; reject(); return; }
    if (state.requiredScope && !binding?.scope.split(' ').includes(state.requiredScope)) {
      res.set('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${state.requiredScope}"`).status(403).json({ error: 'insufficient_scope' }); return;
    }
    next();
  };
  const makeServer = () => {
    const server = new Server({ name: 'oauth-fixture', version: '1.0.0' }, {
      capabilities: { tools: {}, experimental: { 'foxwarm/session-notifications': { version: 1 } } },
    });
    peers.add(server);
    let value = '';
    state.contexts++;
    const context = state.contexts;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'state', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      state.effects++;
      if (state.echoCredential) return { content: [{ type: 'text', text: [...tokens.keys()].join(' ') }] };
      if (state.imageData) return { content: [{ type: 'image', mimeType: 'image/png', data: state.imageData }] };
      if (state.deepResult) {
        let nested: Record<string, unknown> = { value: 'ordinary result' };
        for (let level = 0; level < 64; level++) nested = { nested };
        return { content: [], structuredContent: nested };
      }
      if (typeof request.params.arguments?.value === 'string') value = request.params.arguments.value;
      return { content: [{ type: 'text', text: JSON.stringify({ context, value }) }] };
    });
    return server;
  };
  app.all('/mcp', authenticate, async (req, res) => {
    let transport = transports.get(String(req.headers['mcp-session-id'] || ''));
    if (!transport && req.method === 'POST' && req.body?.method === 'initialize') {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true,
        onsessioninitialized: id => { transports.set(id, transport); } });
      await makeServer().connect(transport);
      transport.onclose = () => { if (transport.sessionId) transports.delete(transport.sessionId); };
    }
    if (!transport) { res.status(404).send('Remote context lost'); return; }
    if (req.method === 'DELETE') state.deletes++;
    await transport.handleRequest(req, res, req.body);
  });
  app.get('/sse', authenticate, async (_req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    sseTransports.set(transport.sessionId, transport);
    transport.onclose = () => sseTransports.delete(transport.sessionId);
    await makeServer().connect(transport);
  });
  app.post('/messages', authenticate, async (req, res) => {
    const transport = sseTransports.get(String(req.query.sessionId || ''));
    if (!transport) { res.status(404).send('Remote context lost'); return; }
    await transport.handlePostMessage(req, res, req.body);
  });
  return { app, baseUrl, issuer, resource, state, tokens, refreshTokens, transports,
    notify: async (message: string) => { await Promise.all([...peers].map(peer => (peer as any).notification({
      method: 'notifications/foxwarm/session_message', params: { message, endpoint: 'fixture-endpoint' },
    }).catch(() => {}))); },
    close: async () => {
      await Promise.all([...transports.values(), ...sseTransports.values()].map(transport => transport.close()));
      listener.closeAllConnections();
      await new Promise<void>(resolve => listener.close(() => resolve()));
    } };
}
