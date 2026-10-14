import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens, OAuthClientInformationMixed } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { McpServerConfig } from './mcpClient';
import { PUBLIC_BASE_URL, STATE_DIR } from './config';
import { replaceConfigFile } from './configFile';
import { closeMcpCallerConnections } from './mcpCallerConnections';
import { createOAuthFetch, oauthEndpoint } from './mcpOAuthHttp';

const sdk: typeof import('@modelcontextprotocol/sdk/client/auth.js') = require('@modelcontextprotocol/sdk/client/auth.js');
const { checkResourceAllowed } = require('@modelcontextprotocol/sdk/shared/auth-utils.js');
export const MCP_OAUTH_CALLBACK_PATH = '/api/mcp/oauth/callback';
export const MCP_OAUTH_CLIENT_PATH = '/api/mcp/oauth/client.json';
const FLOW_TTL_MS = 10 * 60_000;

export type McpOAuthConfig = { scope?: string; clientId?: string; clientSecret?: string };
export class McpOAuthError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'McpOAuthError'; }
}

type Grant = {
  serverUrl: string;
  publicBaseUrl: string;
  settings: { scope?: string; clientId?: string };
  discovery: OAuthDiscoveryState;
  clientInformation: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  expiresAt?: number;
  requiredScope?: string;
  error?: string;
};
type Flow = {
  server: string;
  config: McpServerConfig;
  epoch: number;
  createdAt: number;
  state: string;
  grant: Grant;
  verifier?: string;
  authorizationUrl?: string;
  tokens?: OAuthTokens;
};
export type McpOAuthStatus = {
  state: 'not-authorized' | 'authorizing' | 'authorized' | 'expired' | 'needs-authorization';
  requestedScope?: string;
  grantedScope?: string;
  expiresAt?: number;
  hasClientSecret: boolean;
  clientId?: string;
  error?: string;
};
type Options = {
  filePath?: string;
  publicBaseUrl?: string;
  getServer: (name: string) => Promise<McpServerConfig | undefined>;
  closeConnections?: (name: string) => Promise<void>;
};

export function normalizeMcpOAuthConfig(value: unknown): McpOAuthConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['scope', 'clientId', 'clientSecret'].includes(key))) {
    throw new McpOAuthError('configuration', 'OAuth configuration accepts only scope and pre-registered client credentials.');
  }
  const result: McpOAuthConfig = {};
  for (const key of ['scope', 'clientId', 'clientSecret'] as const) {
    const item = (value as McpOAuthConfig)[key];
    if (item === undefined) continue;
    if (typeof item !== 'string' || item.length > 8192 || /[\r\n\0]/.test(item)) {
      throw new McpOAuthError('configuration', 'OAuth fields must be bounded single-line strings.');
    }
    if (item) result[key] = item;
  }
  if (result.clientSecret && !result.clientId) {
    throw new McpOAuthError('configuration', 'A client secret requires a pre-registered client ID.');
  }
  return result;
}

export function oauthPublicUrl(base: string | undefined, suffix: string): string {
  if (!base) throw new McpOAuthError('public-url', 'Set url in Config to the public instance URL, then restart before authorizing.');
  try {
    const url = oauthEndpoint(base);
    if (url.search) throw new Error();
    url.pathname = `${url.pathname.replace(/\/$/, '')}${suffix}`;
    return url.href;
  } catch {
    throw new McpOAuthError('public-url', 'Set url to an HTTPS public instance URL, then restart. Localhost HTTP is supported for development.');
  }
}

function publicSettings(config: McpServerConfig): Grant['settings'] {
  return { ...(config.oauth?.scope ? { scope: config.oauth.scope } : {}),
    ...(config.oauth?.clientId ? { clientId: config.oauth.clientId } : {}) };
}
function safeScope(scope: unknown): string | undefined {
  return typeof scope === 'string' && scope.length <= 8192 && !/[\r\n\0]/.test(scope) ? scope : undefined;
}
function unionScopes(...values: Array<string | undefined>): string | undefined {
  const scope = [...new Set(values.flatMap(value => value?.split(/ +/).filter(Boolean) || []))].join(' ');
  return scope || undefined;
}

export function containsOAuthCredential(value: unknown, credentials: string[]): boolean {
  if (!credentials.length) return false;
  const pending: unknown[] = [value];
  // SDK JSON data is acyclic. An iterative walk preserves ordinary deep JSON
  // rather than treating an arbitrary nesting threshold as a credential leak.
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') {
      if (credentials.some(secret => item.includes(secret))) return true;
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) {
      for (const child of item) pending.push(child);
      continue;
    }
    const record = item as Record<string, unknown>;
    const media = record.type === 'image' || record.type === 'audio'
      || (typeof record.mimeType === 'string' && /^(image|audio)\//.test(record.mimeType));
    for (const [key, child] of Object.entries(record)) {
      if (media && (key === 'data' || key === 'blob')) continue;
      pending.push(key, child);
    }
  }
  return false;
}

/** Main-owned instance grants; never pooled by an internal Session or token string. */
export class McpOAuthService {
  private readonly filePath: string;
  private readonly publicBaseUrl: string | undefined;
  private grants: Record<string, Grant> | undefined;
  private readonly flows = new Map<string, Flow>();
  private readonly epochs = new Map<string, number>();
  private readonly refreshing = new Map<string, { epoch: number; promise: Promise<OAuthTokens> }>();
  private readonly starting = new Set<string>();
  private readonly operationCredentials = new AsyncLocalStorage<{ server: string; active: boolean; values: Set<string> }>();
  constructor(private readonly options: Options) {
    this.filePath = options.filePath || path.join(STATE_DIR, 'mcp-oauth.json');
    this.publicBaseUrl = options.publicBaseUrl ?? PUBLIC_BASE_URL;
  }

  publicUrl(suffix: string): string { return oauthPublicUrl(this.publicBaseUrl, suffix); }
  callbackUrl(): string { return this.publicUrl(MCP_OAUTH_CALLBACK_PATH); }
  clientMetadata() {
    const callback = this.callbackUrl();
    const clientId = this.publicUrl(MCP_OAUTH_CLIENT_PATH);
    return { client_id: clientId, client_name: 'Foxwarm', redirect_uris: [callback],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'web' };
  }
  private load(): Record<string, Grant> {
    if (!this.grants) {
      try {
        const raw = fs.existsSync(this.filePath) ? JSON.parse(fs.readFileSync(this.filePath, 'utf8')) : { version: 1, servers: {} };
        if (raw.version !== 1 || !raw.servers || typeof raw.servers !== 'object' || Array.isArray(raw.servers)) throw new Error();
        this.grants = raw.servers;
      } catch { throw new McpOAuthError('storage', 'Authorization storage is unavailable. Check the instance data directory.'); }
    }
    return this.grants;
  }
  private save(name: string, grant: Grant | undefined): void {
    const next = grant ? { ...this.load(), [name]: grant } : { ...this.load() };
    if (!grant) delete next[name];
    try { replaceConfigFile(this.filePath, JSON.stringify({ version: 1, servers: next }, null, 2)); }
    catch { throw new McpOAuthError('storage', 'Authorization could not be saved. Check the instance data directory.'); }
    this.grants = next;
  }
  private epoch(name: string): number { return this.epochs.get(name) || 0; }
  private matches(grant: Grant, config: McpServerConfig): boolean {
    return !!config.oauth && grant?.serverUrl === config.url && grant.publicBaseUrl === this.publicBaseUrl
      && isDeepStrictEqual(grant.settings, publicSettings(config));
  }
  private prune(): void {
    for (const [state, flow] of this.flows) if (Date.now() - flow.createdAt > FLOW_TTL_MS) this.flows.delete(state);
  }
  async status(name: string, config: McpServerConfig): Promise<McpOAuthStatus> {
    this.prune();
    const candidate = this.load()[name];
    const grant = this.matches(candidate, config) ? candidate : undefined;
    const pending = [...this.flows.values()].some(flow => flow.server === name);
    return {
      state: pending ? 'authorizing' : grant?.error || grant?.requiredScope ? 'needs-authorization'
        : !grant?.tokens ? 'not-authorized' : grant.expiresAt && grant.expiresAt <= Date.now() && !grant.tokens.refresh_token ? 'expired' : 'authorized',
      requestedScope: unionScopes(config.oauth?.scope, grant?.requiredScope),
      ...(grant?.tokens?.scope !== undefined ? { grantedScope: grant.tokens.scope } : {}),
      ...(grant?.expiresAt ? { expiresAt: grant.expiresAt } : {}),
      hasClientSecret: !!config.oauth?.clientSecret,
      ...(config.oauth?.clientId ? { clientId: config.oauth.clientId } : {}),
      ...(grant?.error ? { error: grant.error } : {}),
    };
  }

  private async current(name: string, config: McpServerConfig, epoch: number): Promise<void> {
    const latest = await this.options.getServer(name);
    if (this.epoch(name) !== epoch || latest?.enable === false || !latest?.oauth
      || latest.url !== config.url || !isDeepStrictEqual(latest.oauth, config.oauth)) {
      throw new McpOAuthError('changed', 'The MCP authorization settings changed. Start authorization again.');
    }
  }
  private async close(name: string): Promise<void> {
    await (this.options.closeConnections || (server => closeMcpCallerConnections({ server })))(name);
  }
  async configurationChanged(name: string, clearGrant = true): Promise<void> {
    this.epochs.set(name, this.epoch(name) + 1);
    for (const [state, flow] of this.flows) if (flow.server === name) this.flows.delete(state);
    if (clearGrant) this.save(name, undefined);
    await this.close(name);
  }
  async disconnect(name: string): Promise<void> {
    this.epochs.set(name, this.epoch(name) + 1);
    for (const [state, flow] of this.flows) if (flow.server === name) this.flows.delete(state);
    const grant = this.load()[name];
    // Keep the registered client, not the account grant. No remote revocation
    // is promised; removing local credentials immediately fences callers.
    this.save(name, grant ? { ...grant, tokens: undefined, expiresAt: undefined, error: undefined, requiredScope: undefined } : undefined);
    await this.close(name);
  }

  private async discover(config: McpServerConfig, resourceMetadataUrl?: URL): Promise<OAuthDiscoveryState> {
    const fetchFn = createOAuthFetch(config.url);
    const resource = await sdk.discoverOAuthProtectedResourceMetadata(config.url, { resourceMetadataUrl }, fetchFn);
    const requested = oauthEndpoint(config.url);
    const canonical = oauthEndpoint(resource.resource);
    if (!checkResourceAllowed({ requestedResource: requested, configuredResource: canonical })
      || (canonical.search && canonical.search !== requested.search)) {
      throw new McpOAuthError('resource', 'The OAuth resource does not match this MCP server.');
    }
    const issuer = resource.authorization_servers?.[0];
    if (!issuer) throw new McpOAuthError('discovery', 'The MCP server does not advertise an authorization server.');
    const issuerUrl = oauthEndpoint(issuer);
    if (issuerUrl.search) throw new McpOAuthError('issuer', 'The authorization server advertises an invalid issuer.');
    // The pinned SDK's OIDC schema drops the RFC 9207 extension. Preserve this
    // capability from the same successfully fetched metadata document.
    let issuerResponseSupported = false;
    const metadataFetch: typeof fetch = async (input, init) => {
      const response = await fetchFn(input, init);
      if (response.ok) {
        const raw = await response.clone().json() as { authorization_response_iss_parameter_supported?: boolean };
        issuerResponseSupported = raw.authorization_response_iss_parameter_supported === true;
      }
      return response;
    };
    const metadata = await sdk.discoverAuthorizationServerMetadata(issuerUrl, { fetchFn: metadataFetch });
    if (!metadata || metadata.issuer !== issuer) throw new McpOAuthError('issuer', 'The authorization server metadata issuer does not match.');
    if (!metadata.code_challenge_methods_supported?.includes('S256')) {
      throw new McpOAuthError('pkce', 'The authorization server must advertise PKCE S256 support.');
    }
    oauthEndpoint(metadata.authorization_endpoint);
    oauthEndpoint(metadata.token_endpoint);
    if (metadata.registration_endpoint) oauthEndpoint(metadata.registration_endpoint);
    Object.assign(metadata, { authorization_response_iss_parameter_supported: issuerResponseSupported });
    return { authorizationServerUrl: issuer, resourceMetadata: resource, authorizationServerMetadata: metadata,
      ...(resourceMetadataUrl ? { resourceMetadataUrl: resourceMetadataUrl.href } : {}) };
  }

  private provider(flow: Flow): OAuthClientProvider {
    const { client_id, ...clientMetadata } = this.clientMetadata();
    const supportsCimd = flow.grant.discovery.authorizationServerMetadata?.client_id_metadata_document_supported
      && flow.grant.discovery.authorizationServerMetadata.token_endpoint_auth_methods_supported?.includes('none')
      && new URL(client_id).protocol === 'https:';
    return {
      redirectUrl: this.callbackUrl(),
      ...(supportsCimd ? { clientMetadataUrl: client_id } : {}),
      clientMetadata: { ...clientMetadata, scope: unionScopes(flow.config.oauth.scope, flow.grant.requiredScope) },
      state: () => flow.state,
      discoveryState: () => flow.grant.discovery,
      validateResourceURL: async () => new URL(flow.grant.discovery.resourceMetadata.resource),
      clientInformation: () => flow.grant.clientInformation,
      saveClientInformation: async information => { flow.grant.clientInformation = information; },
      tokens: () => flow.tokens,
      saveTokens: async tokens => { flow.tokens = tokens; },
      saveCodeVerifier: async verifier => { flow.verifier = verifier; },
      codeVerifier: () => {
        if (!flow.verifier) throw new McpOAuthError('callback', 'Authorization has expired. Start again.');
        return flow.verifier;
      },
      redirectToAuthorization: async url => { flow.authorizationUrl = url.href; },
      // Do not transparently re-register or reuse an already consumed code.
      invalidateCredentials: async () => { throw new McpOAuthError('credentials', 'Authorization was rejected. Check client credentials and authorize again.'); },
    };
  }

  async begin(name: string, config: McpServerConfig): Promise<string> {
    if (!config.oauth || config.enable === false) throw new McpOAuthError('configuration', 'Configure OAuth on an enabled HTTP MCP server first.');
    this.callbackUrl();
    this.prune();
    if (this.starting.has(name)) throw new McpOAuthError('pending', 'Authorization is already starting for this server.');
    if (this.flows.size >= 32) throw new McpOAuthError('pending', 'Too many pending authorizations. Finish one or try again later.');
    this.starting.add(name);
    let epoch = this.epoch(name);
    try {
      // Probe authentication, not initialize/call a remote MCP tool.
      oauthEndpoint(config.url);
      const response = await fetch(config.url, { method: 'GET', headers: { Accept: 'application/json, text/event-stream' },
        redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const challenge = sdk.extractWWWAuthenticateParams(response);
      // Legacy SSE can admit an anonymous GET. Only its challenge headers are
      // useful here; do not wait for or retain a notification stream.
      await response.body?.cancel();
      const discovery = await this.discover(config, challenge.resourceMetadataUrl);
      const previous = this.load()[name];
      const reuse = this.matches(previous, config) && previous.discovery.authorizationServerUrl === discovery.authorizationServerUrl
        && previous.discovery.resourceMetadata.resource === discovery.resourceMetadata.resource;
      if (!reuse && previous?.tokens) {
        await this.disconnect(name);
        epoch = this.epoch(name);
      }
      const registered = config.oauth.clientId ? { client_id: config.oauth.clientId,
        ...(config.oauth.clientSecret ? { client_secret: config.oauth.clientSecret } : {}) } : reuse ? previous.clientInformation : undefined;
      const metadata = discovery.authorizationServerMetadata;
      const cimd = metadata.client_id_metadata_document_supported === true
        && metadata.token_endpoint_auth_methods_supported?.includes('none') && new URL(this.clientMetadata().client_id).protocol === 'https:';
      if (!registered && !cimd && !metadata.registration_endpoint) {
        throw new McpOAuthError('client-required', 'This server requires a pre-registered client ID. Enter client credentials in Authorizations.');
      }
      const flow: Flow = { server: name, config: structuredClone(config), epoch, createdAt: Date.now(), state: randomBytes(32).toString('hex'),
        grant: { serverUrl: config.url, publicBaseUrl: this.publicBaseUrl, settings: publicSettings(config), discovery,
          clientInformation: registered, requiredScope: safeScope(challenge.scope) || (reuse ? previous.requiredScope : undefined) } };
      const result = await sdk.auth(this.provider(flow), { serverUrl: config.url, scope: unionScopes(config.oauth.scope, flow.grant.requiredScope), fetchFn: createOAuthFetch(config.url) });
      if (result !== 'REDIRECT' || !flow.authorizationUrl || !flow.verifier) throw new McpOAuthError('authorization', 'The server did not start browser authorization.');
      await this.current(name, config, epoch);
      // Retain client registration, but do not publish a new account grant until callback succeeds.
      const live = this.load()[name];
      this.save(name, reuse ? { ...live, discovery, clientInformation: flow.grant.clientInformation } : flow.grant);
      for (const [state, pending] of this.flows) if (pending.server === name) this.flows.delete(state);
      this.flows.set(flow.state, flow);
      return flow.authorizationUrl;
    } catch (error) { throw this.safeError(error); }
    finally { this.starting.delete(name); }
  }

  async finish(query: Record<string, unknown>): Promise<string> {
    this.prune();
    const state = typeof query.state === 'string' ? query.state : '';
    const flow = this.flows.get(state);
    if (!flow) throw new McpOAuthError('callback', 'Authorization has expired or the callback is invalid. Start again.');
    const metadata = flow.grant.discovery.authorizationServerMetadata;
    const issuer = query.iss;
    if ((issuer !== undefined && issuer !== flow.grant.discovery.authorizationServerUrl)
      || ((metadata as { authorization_response_iss_parameter_supported?: boolean }).authorization_response_iss_parameter_supported === true && issuer === undefined)) {
      throw new McpOAuthError('issuer', 'The authorization callback issuer does not match.');
    }
    if (typeof query.code !== 'string' || !query.code || query.code.length > 8192 || query.error !== undefined) {
      this.flows.delete(state);
      throw new McpOAuthError('callback', 'Authorization was not completed. Start again when ready.');
    }
    this.flows.delete(state); // A callback can exchange a code only once.
    try {
      await this.current(flow.server, flow.config, flow.epoch);
      const result = await sdk.auth(this.provider(flow), { serverUrl: flow.config.url,
        authorizationCode: query.code, fetchFn: createOAuthFetch(flow.config.url) });
      if (result !== 'AUTHORIZED' || !flow.tokens) throw new McpOAuthError('callback', 'Authorization did not return credentials.');
      await this.current(flow.server, flow.config, flow.epoch);
      const grant = this.withTokens(flow.grant, flow.tokens);
      this.save(flow.server, grant);
      // The browser may have selected a different account. Only a refresh of
      // this grant preserves a remote context; a new grant does not relabel it.
      this.epochs.set(flow.server, flow.epoch + 1);
      await this.close(flow.server);
      return flow.server;
    } catch (error) { throw this.safeError(error); }
  }

  private withTokens(grant: Grant, tokens: OAuthTokens): Grant {
    if (tokens.token_type.toLowerCase() !== 'bearer' || !/^[A-Za-z0-9._~+/-]+=*$/.test(tokens.access_token)
      || (tokens.expires_in !== undefined && (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0))) {
      throw new McpOAuthError('token', 'The server returned unsupported credentials.');
    }
    const persistedTokens = { ...tokens, ...(tokens.scope === undefined && grant.tokens?.scope !== undefined ? { scope: grant.tokens.scope } : {}) };
    return { ...grant, tokens: persistedTokens, expiresAt: tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000,
      requiredScope: undefined, error: undefined };
  }

  private requireGrant(name: string, config: McpServerConfig): Grant {
    const grant = this.load()[name];
    if (!this.matches(grant, config) || !grant.tokens) {
      throw new McpOAuthError('needs-authorization', 'This MCP server needs administrator authorization in Setup → Authorizations.');
    }
    return grant;
  }

  private invalidateGrant(name: string, grant: Grant, error: string): void {
    this.save(name, { ...grant, tokens: undefined, expiresAt: undefined, error });
    this.epochs.set(name, this.epoch(name) + 1);
    // Fence before asynchronous cleanup, including any active notification stream.
    void this.close(name).catch(() => {});
  }

  private refresh(name: string, config: McpServerConfig, rejectedToken?: string): Promise<OAuthTokens> {
    const epoch = this.epoch(name);
    const running = this.refreshing.get(name);
    if (running?.epoch === epoch) return running.promise;
    const run = (async () => {
      await this.current(name, config, epoch);
      const grant = this.requireGrant(name, config);
      if (rejectedToken && grant.tokens.access_token !== rejectedToken) return grant.tokens;
      if (!grant.tokens.refresh_token) {
        this.invalidateGrant(name, grant, 'Authorize again to renew access.');
        throw new McpOAuthError('needs-authorization', 'This MCP server needs administrator reauthorization.');
      }
      try {
        const tokens = await sdk.refreshAuthorization(new URL(grant.discovery.authorizationServerUrl), {
          metadata: grant.discovery.authorizationServerMetadata,
          clientInformation: config.oauth.clientId ? { client_id: config.oauth.clientId,
            ...(config.oauth.clientSecret ? { client_secret: config.oauth.clientSecret } : {}) } : grant.clientInformation,
          refreshToken: grant.tokens.refresh_token,
          resource: new URL(grant.discovery.resourceMetadata.resource),
          fetchFn: createOAuthFetch(config.url),
        });
        await this.current(name, config, epoch);
        this.save(name, this.withTokens(this.requireGrant(name, config), tokens));
        return tokens;
      } catch (error) {
        await this.current(name, config, epoch);
        const invalid = (error as { name?: string }).name === 'InvalidGrantError'
          || (error as { name?: string }).name === 'InvalidClientError';
        if (invalid) {
          this.invalidateGrant(name, grant, 'Authorization expired or was revoked. Authorize again.');
        }
        throw this.safeError(error);
      }
    })();
    const entry = { epoch, promise: run };
    this.refreshing.set(name, entry);
    void run.finally(() => { if (this.refreshing.get(name) === entry) this.refreshing.delete(name); }).catch(() => {});
    return run;
  }

  private async access(name: string, config: McpServerConfig): Promise<OAuthTokens> {
    const grant = this.requireGrant(name, config);
    if (grant.expiresAt && grant.expiresAt <= Date.now() + (grant.tokens.refresh_token ? 5000 : 0)) return this.refresh(name, config);
    return grant.tokens;
  }

  /** One authenticated fetch per caller transport; credentials are shared, remote state is not. */
  resourceFetch(name: string, config: McpServerConfig, streamCredentials?: Set<string>): typeof fetch | undefined {
    if (!config.oauth) return undefined;
    const epoch = this.epoch(name);
    const origin = new URL(config.url).origin;
    return async (input, init = {}) => {
      await this.current(name, config, epoch);
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.origin !== origin) throw new McpOAuthError('resource', 'MCP credentials cannot be sent to another server.');
      let tokens = await this.access(name, config);
      const send = async () => {
        await this.current(name, config, epoch);
        const values = [tokens.access_token, tokens.refresh_token, config.oauth.clientSecret,
          this.requireGrant(name, config).clientInformation?.client_secret].filter(Boolean);
        const operation = this.operationCredentials.getStore();
        if (operation?.active && operation.server === name) for (const value of values) operation.values.add(value);
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${tokens.access_token}`);
        // Prevent credential-bearing resource requests from redirecting to a
        // different origin or forwarding private custom headers.
        const response = await fetch(input, { ...init, headers, redirect: 'error' });
        if (init.method === 'GET' && response.ok && streamCredentials) {
          streamCredentials.clear();
          for (const value of values) streamCredentials.add(value);
        }
        return response;
      };
      let response = await send();
      if (response.status === 401 && /^Bearer(?:\s|$)/i.test(response.headers.get('www-authenticate') || '')) {
        // A standard HTTP authentication rejection occurs before MCP dispatch.
        // Retry once after a same-grant refresh; never retry network errors,
        // JSON-RPC/tool errors, 404, or any unknown-effect failure.
        await response.body?.cancel();
        tokens = await this.refresh(name, config, tokens.access_token);
        response = await send();
        if (response.status === 401) {
          const grant = this.requireGrant(name, config);
          this.invalidateGrant(name, grant, 'Authorization was rejected. Authorize again.');
          throw new McpOAuthError('needs-authorization', 'MCP authorization was rejected. Ask an administrator to authorize again.');
        }
      }
      if (response.status === 403) {
        const challenge = sdk.extractWWWAuthenticateParams(response);
        if (challenge.error === 'insufficient_scope') {
          const grant = this.requireGrant(name, config);
          this.save(name, { ...grant, requiredScope: safeScope(challenge.scope), error: 'Additional access is required. Review the scopes and authorize again.' });
          await response.body?.cancel();
          throw new McpOAuthError('scope', 'Additional MCP access requires administrator authorization in Setup → Authorizations.');
        }
      }
      return response;
    };
  }

  credentials(name?: string): string[] {
    const grants = this.load();
    const operation = this.operationCredentials.getStore();
    return [...(name ? [grants[name]] : Object.values(grants)).flatMap(grant => grant
      ? [grant.tokens?.access_token, grant.tokens?.refresh_token, grant.clientInformation?.client_secret] : [])
      .filter((value): value is string => typeof value === 'string' && !!value),
      ...(operation?.active && (!name || operation.server === name) ? operation.values : [])];
  }

  async guardOperation<T>(name: string, clientSecret: string | undefined, run: () => Promise<T>): Promise<T> {
    const operation = { server: name, active: true, values: new Set([clientSecret, ...this.credentials(name)].filter(Boolean)) };
    return this.operationCredentials.run(operation, async () => {
      try {
        const result = await run();
        if (containsOAuthCredential(result, this.credentials(name))) {
          throw new Error('The MCP operation may have completed, but its output contained OAuth credentials and was withheld. Do not retry automatically.');
        }
        return result;
      } catch (error) {
        if (containsOAuthCredential(error instanceof Error ? error.message : error, this.credentials(name))) {
          throw new Error('The MCP operation failed with private credential data. Its outcome may be unknown; do not retry automatically.');
        }
        throw error;
      } finally {
        operation.active = false;
        operation.values.clear();
      }
    });
  }

  safeError(error: unknown): McpOAuthError {
    if (error instanceof McpOAuthError) return error;
    const name = (error as { name?: string })?.name;
    if (name === 'InvalidClientError' || name === 'UnauthorizedClientError') {
      return new McpOAuthError('credentials', 'Client credentials were rejected. Check them in Authorizations.');
    }
    if (name === 'InvalidGrantError') {
      return new McpOAuthError('needs-authorization', 'Authorization expired or was revoked. Authorize again.');
    }
    return new McpOAuthError('authorization', 'OAuth could not be completed. Check the server connection and authorization settings.');
  }
}

let service: McpOAuthService;
export function getMcpOAuthService(): McpOAuthService {
  if (!service) service = new McpOAuthService({ getServer: async name => (await require('./mcpClient').getServers())[name] });
  return service;
}
export function setMcpOAuthServiceForTests(value: McpOAuthService | undefined): void { service = value; }
