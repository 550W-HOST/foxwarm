# Unit: src-mcp-inbound-config

Files: `src/mcpInboundConfig.ts`, `src/mcpInboundConfig.test.ts`
Secondary files: `src/config.ts`, `src/setupConfig.ts`, `src/toolAuthorization.ts`, `src/toolAuthorization.test.ts`

## Purpose

Validates optional inbound MCP identities from the application YAML and creates verified external principals from explicit HTTP Bearer Authorization headers. The HTTP ingress is owned by [src-mcp-inbound-http](./src-mcp-inbound-http.md); no Node operation or Session message interface is connected yet. Outbound MCP server storage and credentials are independent.

## Key exports

- `normalizeMcpInboundConfig(value)` — strict validation of enabled flag, bounded identity map, names, independent Bearer tokens, and unknown fields. An omitted block is disabled; an explicit disabled block is still fully validated. An enabled block needs at least one identity. Errors never include token values or raw parser source lines.
- `authenticateMcpInboundBearer(config, authorization)` — verifies only one Authorization header against configured identities and returns an opaque process-local verified principal or `null`. No request body, cookie, clientInfo, environment variable, or management token is an identity source.
- `requireVerifiedMcpInboundExternalId(principal)` — checks that the principal was minted by that verifier in the current process before supplying its external ID to policy construction. Caller-provided lookalike objects fail.
- `McpInboundConfig`, `NormalizedMcpInboundConfig`, `VerifiedMcpInboundPrincipal` — configuration and principal types.

## Integration

`config.ts` adds `AppConfig.mcpInbound` and validates it at application startup through `MCP_INBOUND_CONFIG`. `setupConfig.ts` applies the same validation before writing raw app YAML. Malformed YAML is reported with safe 1-based line/column locations but without raw parser snippets, reasons, keys or values; the existing administrator-only raw YAML editor otherwise retains its behavior. This unit does not accept an environment-token override. `toolAuthorization.ts` uses only a verified principal for external source facts.

## Tests

Focused tests check omitted/disabled and enabled config, invalid shapes even when disabled, duplicate YAML keys and effective tokens, non-secret error messages, unchanged file after rejected setup write, distinct verified identities, malformed/unrecognized Authorization values, and disabled-auth denial.

## Design decisions

### D-config-mcp-inbound-foundation

[2026-09-19] Inbound MCP identity configuration is a distinct top-level YAML block, `mcpInbound: { enabled, identities: { <externalId>: { token } } }`. Omission defaults off; an enabled block requires at least one independent token. Validate supplied disabled blocks, reject duplicate effective tokens and malformed or unknown fields, and avoid echoing secret-bearing input. External IDs are derived exclusively from successful Bearer verification. The enabled endpoint has a fixed `/mcp` path; no configurable path, environment fallback, OAuth mode, or per-identity enable switch is part of this configuration. Its transport is specified by [D-mcp-inbound-http-transport](./src-mcp-inbound-http.md#d-mcp-inbound-http-transport); its separately owned discovery/call scope is documented in [tool dispatch](../threads/tool-dispatch.md#d-dispatch-mcp-inbound-bridge).
