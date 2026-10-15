import type { Request, Response } from 'express';
import type { HttpServer } from './httpServer';
import { getServers, upsertServer } from './mcpClient';
import { getMcpOAuthService, McpOAuthError, MCP_OAUTH_CALLBACK_PATH, MCP_OAUTH_CLIENT_PATH, normalizeMcpOAuthConfig } from './mcpOAuth';

const MANAGEMENT_PATH = '/api/setup/authorizations';
function errorResponse(res: Response, error: unknown): void {
  const safe = getMcpOAuthService().safeError(error);
  res.status(400).json({ error: safe.message, code: safe.code });
}
function requireJson(req: Request): void {
  if (!req.is('application/json') || req.headers['sec-fetch-site'] === 'cross-site') {
    throw new McpOAuthError('request', 'Use the authenticated Authorizations panel for this action.');
  }
  let publicOrigin: string | undefined;
  try { publicOrigin = new URL(getMcpOAuthService().callbackUrl()).origin; } catch { /* OAuth is not enabled yet. */ }
  if (req.headers.origin && publicOrigin && req.headers.origin !== publicOrigin) {
    throw new McpOAuthError('request', 'Open Authorizations at the configured public instance URL.');
  }
}
async function serverFromRequest(req: Request) {
  const name = req.params.server;
  const servers = await getServers();
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(servers, name)) {
    throw new McpOAuthError('configuration', 'Choose a configured MCP server.');
  }
  const config = servers[name];
  if ((config.transport || 'auto') === 'stdio') throw new McpOAuthError('configuration', 'OAuth is available only for HTTP MCP servers.');
  return { name, config };
}

/** Only the instance administrator manages shared third-party accounts. */
export function registerMcpOAuthRoutes(server: HttpServer): void {
  server.addRoute({ path: MANAGEMENT_PATH, method: 'GET', handler: async (_req, res) => {
    try {
      const service = getMcpOAuthService();
      let callbackUrl: string | undefined;
      let publicUrlError: string | undefined;
      try { callbackUrl = service.callbackUrl(); } catch (error) { publicUrlError = service.safeError(error).message; }
      const servers = await getServers();
      res.json({ callbackUrl, publicUrlError, servers: await Promise.all(Object.entries(servers)
        .filter(([, config]) => (config.transport || 'auto') !== 'stdio')
        .map(async ([name, config]) => ({ name, enabled: config.enable !== false, url: config.url,
          transport: config.transport || 'auto', authentication: config.oauth ? 'oauth' : 'static',
          hasStaticAuthorization: !!config.token || Object.keys(config.headers || {}).some(key => key.toLowerCase() === 'authorization'),
          ...(config.oauth ? { scope: config.oauth.scope, ...await service.status(name, config) } : { state: 'static', hasClientSecret: false }),
        }))) });
    } catch (error) { errorResponse(res, error); }
  } });

  server.addRoute({ path: `${MANAGEMENT_PATH}/:server`, method: 'PUT', handler: async (req, res) => {
    try {
      requireJson(req);
      const { name, config } = await serverFromRequest(req);
      const body = req.body || {};
      if (!['static', 'oauth'].includes(body.authentication)) throw new McpOAuthError('configuration', 'Choose Static or OAuth authentication.');
      let next = { ...config };
      if (body.authentication === 'oauth') {
        const oauth = normalizeMcpOAuthConfig({ scope: body.scope, clientId: body.clientId,
          clientSecret: body.clientSecret === undefined ? config.oauth?.clientSecret : body.clientSecret === null ? undefined : body.clientSecret });
        if (body.replaceStaticAuthorization === true) {
          next.token = undefined;
          next.headers = Object.fromEntries(Object.entries(config.headers || {}).filter(([key]) => key.toLowerCase() !== 'authorization'));
        }
        next.oauth = oauth;
      } else {
        next.oauth = undefined;
      }
      await upsertServer(name, next);
      res.json({ success: true });
    } catch (error) { errorResponse(res, error); }
  } });

  server.addRoute({ path: `${MANAGEMENT_PATH}/:server/authorize`, method: 'POST', handler: async (req, res) => {
    try {
      requireJson(req);
      const { name, config } = await serverFromRequest(req);
      res.json({ authorizationUrl: await getMcpOAuthService().begin(name, config) });
    } catch (error) { errorResponse(res, error); }
  } });

  server.addRoute({ path: `${MANAGEMENT_PATH}/:server/disconnect`, method: 'POST', handler: async (req, res) => {
    try {
      requireJson(req);
      const { name } = await serverFromRequest(req);
      await getMcpOAuthService().disconnect(name);
      res.json({ success: true });
    } catch (error) { errorResponse(res, error); }
  } });

  // Non-secret metadata is public; this is not an inbound authorization server.
  server.addRoute({ path: MCP_OAUTH_CLIENT_PATH, method: 'GET', noAuth: true, handler: async (_req, res) => {
    try { res.set('Cache-Control', 'public, max-age=300').json(getMcpOAuthService().clientMetadata()); }
    catch (error) { errorResponse(res, error); }
  } });

  server.addRoute({ path: MCP_OAUTH_CALLBACK_PATH, method: 'GET', noAuth: true, handler: async (_req, res) => {
    // The existing administrator cookie is SameSite=Strict, so a redirect from
    // the AS cannot authenticate this GET. This public document performs no
    // exchange: its first-party POST must pass the normal administrator check.
    try {
      const service = getMcpOAuthService();
      const completeUrl = JSON.stringify(service.publicUrl('/api/mcp/oauth/complete'));
      const homeUrl = JSON.stringify(service.publicUrl(''));
      res.set('Cache-Control', 'no-store').set('Referrer-Policy', 'no-referrer')
        .set('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
        .type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Completing authorization</title>
<body><h1 id="status">Completing authorization…</h1><p id="detail"></p><a id="home">Return to Foxwarm</a><script>(async()=>{
const query=new URLSearchParams(window.location.search);const keys=[...query.keys()];
window.history.replaceState(null,'',window.location.pathname);
let success=false;if(new Set(keys).size===keys.length){try{
const response=await fetch(${completeUrl},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(query))});success=response.ok;
}catch{}}
document.title=success?'Authorization complete':'Authorization not completed';
document.getElementById('status').textContent=document.title;
document.getElementById('detail').textContent=success?'You can close this window and return to Authorizations.':'Review the server settings in Authorizations and start again.';
document.getElementById('home').href=${homeUrl};
if(window.opener)window.opener.postMessage({type:'foxwarm-mcp-oauth',success},window.location.origin);
})()</script></body></html>`);
    } catch { res.status(400).type('text').send('Authorization settings changed. Open Authorizations and start again.'); }
  } });

  server.addRoute({ path: '/api/mcp/oauth/complete', method: 'POST', handler: async (req, res) => {
    try {
      requireJson(req);
      await getMcpOAuthService().finish(req.body || {});
      res.set('Cache-Control', 'no-store').json({ success: true });
    } catch (error) { errorResponse(res, error); }
  } });

}
