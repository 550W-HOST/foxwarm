# Unit: cli-node-master-proxy

Files: packages/cli-node/src/masterProxy.ts, packages/cli-node/src/masterProxy.test.ts

## Purpose

Provides proxy-aware WebSocket connection support for the CLI node's master connection. It resolves HTTP/HTTPS proxy settings from environment variables, creates appropriate proxy agents for `ws`/`wss` URLs, and sanitizes proxy URLs for safe logging.

## Key Exports

- `MasterProxyProtocol` — type alias for supported protocols (`ws`, `wss`, `http`, `https`)
- `MasterProxyInfo` — interface describing resolved proxy details (target, lookup, proxy, sanitized URLs)
- `sanitizeProxyUrl(proxyUrl)` — redacts credentials from a proxy URL for logging
- `getMasterProxyInfo(targetUrl)` — resolves proxy info for a given target URL using environment variables
- `createMasterWebSocketOptions(wsUrl)` — returns `ClientOptions` with the correct proxy agent for a WebSocket URL

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `toHttpProxyLookupUrl(targetUrl)` | ~19–27 | Converts ws/wss URLs to http/https for proxy-from-env lookup |
| `sanitizeProxyUrl(proxyUrl)` | ~29–38 | Redacts password from proxy URL, returns safe string |
| `getMasterProxyInfo(targetUrl)` | ~40–51 | Resolves proxy URL from env vars and returns structured info or null |
| `createMasterWebSocketOptions(wsUrl)` | ~53–64 | Creates WebSocket ClientOptions with HttpProxyAgent or HttpsProxyAgent |
| `withProxyEnv(env, run)` (test helper) | ~20–38 | Temporarily sets proxy env vars, restores originals after callback |

## Dependencies

None from other project modules — only external packages (`http-proxy-agent`, `https-proxy-agent`, `proxy-from-env`).

## Behavior

- Maps `ws:` → `http:` and `wss:` → `https:` before looking up proxy settings, since `proxy-from-env` only understands HTTP protocols.
- Returns `null` (no proxy) when environment variables don't match or `NO_PROXY` excludes the target.
- Selects `HttpsProxyAgent` for `wss:` targets and `HttpProxyAgent` for `ws:` targets.
- Sanitization replaces the password portion of a proxy URL with `***`; returns a fallback string for unparseable URLs.

## Integration

- Used by the CLI node's WebSocket client when connecting to the master server, injecting the returned `ClientOptions` (with agent) into the `ws` library.
- Relies entirely on standard proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, and lowercase variants), making it transparent to upstream configuration.