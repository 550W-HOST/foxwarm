# Unit: WebUI guest tokens

Files: src/webuiGuestTokens.ts, src/webuiGuestTokens.test.ts
Secondary files: src/httpServer.ts, src/channels/webuiChannel.ts, src/channels/webuiRealtime.ts

## Purpose

Persists hashed WebUI guest credentials with exact existing canonical Session ID bindings; issue-time aliases and retargeted persisted aliases are not guest authority. A guest token is browser-channel authority only and never creates a Session, Agent, or agent tool policy.

## Public functions

- `createWebUiGuestToken` returns a one-time `fwg_<id>_<secret>` credential and a stored record containing label, creation time, optional expiration, bound Session IDs, and revocation state.
- `verifyWebUiGuestToken` parses and hashes a credential, compares its hash safely, and rejects expired or revoked records.
- `listWebUiGuestTokens` and `revokeWebUiGuestToken` are storage helpers; there is no browser token-management interface.
- `normalizeWebUiGuestTokensPayload` reads the persisted store defensively; current writes contain hashes, not raw credentials.

## Integration

The WebUI channel configures the HTTP guest verifier and exposes administrator-only token creation. Selected browser routes and multiplexed Session subscriptions check the verified role and exact bound ID. Canonical browser scope: [D-webui-guest-session-scope](../modules/webui.md#d-webui-guest-session-scope).
