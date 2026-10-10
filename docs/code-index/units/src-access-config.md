# Unit: src-access-config

Files: `src/accessConfig.ts`, `src/accessConfig.test.ts`
Secondary files: `src/config.ts`, `src/setupConfig.ts`, `src/httpServer.ts`, `src/channels/webuiChannel.ts`, `src/mcpInboundHttp.ts`, `src/toolAuthorization.ts`

## Purpose

Validates the startup-only `access.identities` YAML block and creates verified process-local identities shared by the WebUI and inbound MCP surfaces. A configured identity has one token and explicitly declares `surfaces.webui.sessions`, `surfaces.mcp: {}`, or both. The instance token remains the separate WebUI/HTTP superuser credential and does not imply MCP access.

## Key exports

- `normalizeAccessConfig(value)` — validates bounded identity IDs, distinct Bearer tokens, explicit surfaces, exact Session IDs or valid Agent wildcard scopes, empty MCP surface objects, and unknown fields without echoing secrets.
- `webUiScopeAgent(binding)` — recognizes only `<agent>/*` with the supported Agent-name alphabet.
- `authenticateAccessToken(config, token, surface)` — verifies one configured token for the requested surface and returns an opaque identity with `identityId`, policy-compatible `externalId`, and declared surfaces.
- `authenticateAccessBearer(config, authorization, 'mcp')` — strict single-header Bearer authentication used by inbound MCP. Cookies and the instance token are not MCP identity sources.
- `hasAccessSurface(config, surface)` — determines whether startup should expose a surface.
- `requireVerifiedAccessIdentity(principal)` — prevents caller-supplied lookalike principals from becoming policy identities.
- `AccessConfig`, `NormalizedAccessConfig`, `VerifiedAccessIdentity` — configuration and verified-identity types.

## Integration

`config.ts` adds `AppConfig.access` and exports the startup-normalized `ACCESS_CONFIG`; `setupConfig.ts` validates the same block before writing raw YAML. `HttpServer` uses a WebUI surface verifier for cookie/Bearer HTTP and WebSocket auth. `McpInboundHttpService` authenticates each `/mcp` request with the MCP surface and passes the verified identity to the existing external tool policy, where `externalId` is the configured identity ID. WebUI Session bindings and Agent scopes are presentation scope only and do not grant MCP tools; MCP authorization does not grant WebUI management access.

There is no persisted guest-token store, token-issuance route, legacy `mcpInbound` block, or hot-update system. Changes take effect on the existing process restart/startup lifecycle.

Operator guidance is available through the bundled access-control skill (`skills/access-control/SKILL.md`); MCP connection and use workflows are linked from mcp-management (`skills/mcp-management/SKILL.md`).

## Tests

Focused tests cover omitted configuration, surface-specific authentication, duplicate and malformed identities, secret-safe setup validation, WebUI `/api/auth` and `/api/auth/session`, HTTP/WS Session isolation, MCP-only denial at WebUI, MCP SDK access, headless MCP startup, policy identity matching, and the existing superuser path.

## Design decisions

### D-config-shared-access-identities

[2026-10-08] Replace the unused separate inbound MCP identity block and persisted WebUI guest-token store with one top-level `access.identities.<identityId>` map. Each identity declares one token and one or both entry surfaces: `webui: { sessions: [...] }` and `mcp: {}`. Surface declaration is an entry-point capability, not a permission tier. The HTTP/WebUI instance token remains a superuser and is not automatically a valid MCP identity. WebUI exact bindings and Agent scopes use the canonical [WebUI Session scope contract](../modules/webui.md#d-webui-identity-session-scope); MCP still requires Bearer-only transport and its existing concrete tool policy.
