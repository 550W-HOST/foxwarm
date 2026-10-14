# Unit: outbound MCP OAuth

Files: `src/mcpOAuth.ts`, `src/mcpOAuthHttp.ts`, `src/mcpOAuthRoutes.ts`, `src/mcpOAuth.test.ts`, `src/mcpOAuthTestFixture.ts`, `src/mcpOAuthUiTestMain.ts`
Secondary files: `src/mcpClient.ts`, `src/mcpCallerConnections.ts`, `src/mcpExternalService.ts`, `src/index.ts`, `src/configFile.ts`, `packages/webui/src/components/AuthorizationsPanel.tsx`, `packages/webui/test/authorizationsHarness.html`, `packages/webui/test/authorizations.e2e.mjs`

## Purpose

Main-owned OAuth client authorization for configured outbound HTTP MCP servers. One administrator-approved third-party account is shared by the instance for a named server; existing caller/tool permission checks remain authoritative. The service is not an inbound authorization server, a general credential vault or an internal Session owner.

## Current management surface

[2026-10-14] Setup no longer exposes the Authorizations tab or mounts its component. The retained MCP-only `AuthorizationsPanel` is exercised directly by its dedicated test harness, not by a hidden production route. Existing MCP configuration, persisted grants, administrator APIs and callback capability remain intact. No replacement MCP management page or inbound authorization service is exposed by this change.

## Stable symbols

| Symbol | Responsibility |
| --- | --- |
| `McpOAuthConfig` / `normalizeMcpOAuthConfig` | Small configuration containing optional scope and pre-registered client ID/secret |
| `McpOAuthService` | Persist named-server registrations/grants, admit browser flows, complete PKCE exchange, serialize refresh and fence replaced grants |
| `oauthPublicUrl` | Append fixed public paths to startup `config.url` without discarding its deployment prefix |
| `createOAuthFetch` / `oauthEndpoint` | Credential-separated, bounded OAuth discovery/token requests with vetted pinned DNS and no redirects |
| `registerMcpOAuthRoutes` | Administrator-only management/completion APIs and fixed public callback/client metadata |
| `resourceFetch` | Grant-aware HTTP/SSE request authentication and one bounded same-grant refresh retry after a standard Bearer 401 |
| `containsOAuthCredential` | Refuse recognized OAuth secrets in textual metadata/results/errors without changing binary media |
| `guardOperation` | Track credentials actually used by one MCP operation through its result/error boundary; clear the context on completion |

## Configuration and persistence

- A named MCP server may contain `oauth: { scope?, clientId?, clientSecret? }`. Omission retains static token/custom-header behavior. Stdio rejects OAuth. OAuth rejects a configured token or any case-insensitive explicit Authorization header; the UI can explicitly replace those fields while retaining other headers.
- MCP configuration remains under the existing store, with mode-0600 temporary writes. Configuration secrets are never returned in summaries or management status. The separate mode-0600 `state/mcp-oauth.json` uses the existing synced atomic replacement helper for version-1 named-server registration/grant records.
- A grant binds the named server URL, public callback base, requested configuration, selected issuer, canonical protected resource and registered client. Tokens and registration are distinct from ephemeral caller transports. Access tokens are not principal IDs or pool keys.
- Optional reported token scope comes only from the token response; requested scope comes from configured input and a supported scope challenge. Missing token scope is not presented as an invented grant.
- Pending state/verifier flows are memory-only, expire after ten minutes and are bounded. Process restart discards pending callbacks but retains completed grants/registrations. Changing startup `url` requires the existing config restart path; old callback bindings need fresh authorization.

## Browser and discovery flow

- `config.url` is the sole public/callback/CIMD base. Missing URL is harmless without OAuth and produces an actionable Authorizations message when needed. Production uses HTTPS; loopback HTTP is allowed for development. No link is derived from an untrusted Host header.
- An administrator starts browser authorization. Discovery handles PRM challenges and well-known fallback, AS/OIDC metadata, exact issuer checking, S256 advertisement, and resource containment on the same origin/path boundary. AS endpoints must be HTTPS except loopback development.
- Existing pre-registration or retained registration is preferred. Otherwise advertised public-client CIMD with `none` support and an HTTPS metadata URL is selected; DCR is the compatibility fallback. Missing registration support requires client credentials, rather than guessing endpoints or repeatedly registering.
- Public CIMD is fixed non-secret metadata with one generated callback URI. Discovery and token fetches never inherit resource Authorization/API-key headers, do not redirect, bound response size/time, and pin vetted DNS addresses. A configured private resource can discover its own origin; unrelated private endpoints are refused, with a narrow loopback development allowance.
- Public callback GET returns one fixed completion document. It reflects no callback parameter and performs no token exchange. It strips code/state from browser history, then submits them through a first-party JSON POST that requires the current administrator identity, origin and live pending binding. This preserves the existing Strict login cookie across a genuine cross-site AS consent page.
- Completion validates state, selected issuer (including advertised RFC 9207 response support), configuration generation, PKCE and fixed redirect/resource before persisting tokens. The pinned SDK's OIDC parser drops the issuer-response extension, so it is preserved from the same fetched metadata document.
- The completion page shows fixed success/failure, works without an opener, and sends only a status notification to an opener. The management page re-reads authenticated status. Codes, token responses and provider error descriptions do not enter HTML, model output or logs.

## Runtime lifecycle

- Ordinary tool calls never start human consent or dynamic registration. They use the named server's administrator-managed grant. SDK helpers own discovery, PKCE/code exchange and refresh; the resource fetch adapter keeps those credentials separate from resource headers and existing transport lifecycle.
- Refresh is single-flight for the same named-server grant generation. Rotating credentials are atomically persisted. Starting consent updates registration/discovery fields on the current live record, never a captured credential snapshot; token publication also merges into the current same-grant record. A new grant cannot join or publish an old refresh. Missing refresh credentials or `invalid_grant` require explicit reauthorization and fence dependent caller bindings/notifications.
- An operation-local async context records credentials actually selected by resource requests, including intermediate refreshed tokens. Its result/error guard runs before releasing that context; completion marks it inactive and clears it even when a transport stream retains the async ancestry. This is not a global token history.
- Caller entries retain only credentials used by their active authenticated GET stream and clear them on stream end/cancellation or disposal. Notification admission checks message and endpoint against that captured stream context and currently known dynamic credentials before ordinary Session ingress. Known dynamic access/refresh/registration credentials also participate in the external facade's existing before/after result and error inventory, including calls through static aliases.
- A standard Bearer HTTP 401 is an authentication rejection before MCP dispatch and permits one refresh/resend. Network errors, 404 and unknown-effect tool errors are never replayed. An insufficient-scope 403 records a reviewable scope request without retrying an effect or discarding the still-valid remote context.
- Same-grant renewal retains caller-specific remote context and notifications. Explicit browser reauthorization may select another account and closes only that named server's bindings. Local Disconnect clears access/refresh authority, retains client registration for later consent, and fences bindings; it does not promise upstream revocation or rollback of started effects.
- Existing Session/external-context owner keys, concrete permission checks, stdio pooling and auto HTTP-to-SSE initialization fallback remain in their existing owners. OAuth authorization errors are not treated as a reason to try a different transport.

## HTTP routes

| Method/path | Authority and purpose |
| --- | --- |
| GET `/api/setup/authorizations` | Administrator; safe configured HTTP server/status list |
| PUT `/api/setup/authorizations/:server` | Administrator JSON; choose static/OAuth and save small client settings |
| POST `/api/setup/authorizations/:server/authorize` | Administrator JSON; admit a bounded flow and return the browser URL |
| POST `/api/setup/authorizations/:server/disconnect` | Administrator JSON; remove local account authorization |
| GET `/api/mcp/oauth/client.json` | Public non-secret client metadata |
| GET `/api/mcp/oauth/callback` | Public fixed completion page, no token exchange |
| POST `/api/mcp/oauth/complete` | Administrator JSON; complete the already admitted flow |

Backend paths remain deployment-relative behind the existing prefix proxy; generated public URLs retain `config.url`'s pathname. Scoped WebUI identities cannot read, configure, initiate or complete shared account authorization.

## Validation

Real loopback AS/SDK resource fixtures cover pre-registration, CIMD and DCR, state/issuer/configuration rejection, S256/resource validation, persisted grant use by a fresh process, two distinct caller contexts sharing rotating credentials, scope errors, notifications, in-flight grant replacement, disconnect, secret-bearing output rejection, and static/SSE/auto regressions. Browser fixtures exercise actual login cookies and the retained authorization component directly in Chromium and Firefox, with a committed cross-site consent document, TLS path prefix, all three registration paths, fixed completion without an opener, missing public URL and scoped-identity denial. They use only owned local services and a fixture-specific Vite cache.

## Design decisions

### D-mcp-outbound-instance-oauth

[2026-10-14, initial implementation; Setup entry later withdrawn as noted above] Administrators originally configured OAuth through Setup Authorizations and explicitly share the selected named server's third-party account with the instance. Existing callers use it only through their original tool permissions; they keep independent remote MCP contexts. Use startup `config.url` for public callback and client metadata URLs. Provide outbound OAuth before any inbound consent/scopes service, keep current 2025 MCP transports, and do not add generic users, roles or a credential-vault interface.
