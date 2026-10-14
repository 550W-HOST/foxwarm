# Outbound MCP connections

This reference covers Foxwarm connecting to another tool server. It does not configure Foxwarm's inbound `access.identities`; for entry-identity configuration and its supported live update path, load [access-control](../../access-control/SKILL.md). MCP configuration tools are discoverable builtins rather than default-injected tools.

## Outbound configuration lifecycle

- Use the hidden `mcp_config` builtin, invoked with `call_tool`, for connection settings. Administrators manage shared OAuth accounts through WebUI Setup → Authorizations.
- A successful `mcp_config` call updates the live runtime configuration immediately. Existing HTTP caller connections are closed after the update, and subsequent discovery/calls use the change; **no Foxwarm restart is required**.
- Do **not** manually edit the MCP state/config file. Manual file edits do not update the live cached configuration immediately and can leave disk and runtime behavior inconsistent.
- Never print, copy into chat, or commit real tokens, environment secrets, private headers, or credentials. Use values supplied through an approved secret-handling path and keep diagnostic output redacted.

## Safe listing

List configured servers through the hidden safe-summary builtin:

```json
{
  "toolId": "builtin:list_mcp_servers",
  "args": {}
}
```

Invoke that descriptor with `call_tool`. The result includes safe metadata such as enabled state, transport, command/URL, argument count, environment/header key names, whether a token exists, and the configured tool-call timeout override (`null` means the MCP SDK default). It does not return secret values.

If the builtin names are uncertain, first use:

```json
{
  "query": "MCP server config list",
  "sources": ["builtin"],
  "includeSchema": true
}
```

with `search_tools`.

## Configure a server

Invoke `mcp_config` through `call_tool` and pass the complete connection settings being created or changed.

Streamable HTTP example:

```json
{
  "toolId": "builtin:mcp_config",
  "args": {
    "name": "example",
    "transport": "streamable-http",
    "url": "https://mcp.example.invalid/mcp",
    "token": "<secret supplied at runtime>",
    "timeoutSeconds": 240,
    "enable": true
  }
}
```

Stdio example:

```json
{
  "toolId": "builtin:mcp_config",
  "args": {
    "name": "example-local",
    "transport": "stdio",
    "command": "example-mcp-server",
    "args": ["--stdio"],
    "env": {
      "EXAMPLE_API_KEY": "<secret supplied at runtime>"
    },
    "enable": true
  }
}
```

Provider schemas may hide free-form objects. In that case, use the documented `envJson` or `headersJson` JSON-object-string fallback instead of passing both forms.

### Tool-call timeout

`timeoutSeconds` is optional and applies only to tool calls for that server. Acceptable overrides are finite values from 1 through 3600 seconds. Omitting it preserves the installed MCP SDK default (currently 60 seconds). To remove an existing override without changing the connection settings, invoke `mcp_config` with the server name and `timeoutSeconds: 0`; the canonical persisted configuration removes the field. Connection setup and tool listing do not use this override.

## Administrator-managed OAuth

For an HTTP MCP server that uses browser OAuth, configure its name/URL/transport first, then ask the administrator to open **Setup → Authorizations**:

1. Set the top-level app Config `url` to the instance's public HTTPS URL, including any deployment prefix, and restart if it changed. It is distinct from the third-party MCP server URL. Localhost HTTP is supported for development; no public URL is needed for static or stdio installations.
2. Choose OAuth for the named server. Supply requested scopes and pre-registered client ID/secret only when needed. Otherwise Foxwarm uses supported public client metadata or dynamic registration. The panel displays the generated callback URL.
3. If static Authorization is already configured, explicitly choose to replace it; OAuth cannot silently override it. Other resource headers remain unchanged.
4. Select Authorize and complete the third-party consent page. Status and returned scopes appear in the panel. Client secrets and tokens are not returned by its API or safe summaries.
5. Reauthorize when expired, revoked or additional scope is required. Disconnect removes local account authorization and closes this server's caller bindings; it does not promise upstream revocation or rollback of running effects.

The selected account is deliberately shared by the instance. Existing tool permissions still apply and each caller retains a separate remote MCP context. Same-grant refresh preserves those contexts; explicit reauthorization may select another account and replaces them. Stdio continues to use environment credentials. Do not turn a model/tool error into a human OAuth flow or request a token in chat; direct the administrator to this panel.

## Disable or re-enable

Disable an existing server without repeating its connection details:

```json
{
  "toolId": "builtin:mcp_config",
  "args": {
    "name": "example",
    "enable": false
  }
}
```

Use `enable: true` to re-enable an existing server. List safe summaries afterward to confirm the state.

## Transport basics

- `streamable-http`: preferred standard HTTP transport; normally use the server's `/mcp` endpoint.
- `sse`: use only when the server exposes the legacy-compatible MCP SSE endpoint expected by its documentation.
- `stdio`: launches a local command. Specify `command`; optional fields include `args`, `env`, `cwd`, and `stderr`.
- `auto`: HTTP mode that lets the client negotiate the supported standard HTTP behavior for the configured URL.

### HTTP connection ownership

HTTP/SSE discovery and calls from the same calling Session to one configured server share its connection, even before message reception is enabled. Different Sessions do not share the server's selected Node, working directory or exec-result context. An inbound external client forwarding a call has its own verified context owner, not a fabricated internal Session. Stdio retains its existing process-pool behavior.

Ordinary HTTP connections are released after 15 minutes idle; active calls prevent idle cleanup. Explicit notification reception uses standard ping keepalive instead. Server updates/disable, source deletion, external-context disposal and shutdown also release connections. Streamable HTTP cleanup attempts session DELETE before close; legacy SSE uses its transport's close.

A new connection after expiry, a closed context or a managed configuration change starts with the server's default context. Do not assume a previous Node/cwd selection or exec result belongs to it. A failed invocation is not automatically repeated, and a later new connection does not establish that the earlier effect was undone. Ordinary calls do not turn on message reception; use [explicit instance replies](instance-replies.md) for that opt-in workflow.

Do not guess a URL, executable, arguments, or authentication format. Use the MCP server's own documentation or ask the user for the missing deployment-specific value.

## Discover and call tools after configuration

1. Configure or enable the server with hidden `mcp_config` via `call_tool`.
2. Use `search_tools` with `sources: ["mcp"]` and, when known, `server: "<name>"`.
3. Prefer the returned `toolId`, such as `mcp:example/tool_name`.
4. Invoke it with `call_tool`, passing target arguments in `args` (or `argsJson` only when the provider hides the object field).
5. If discovery fails, safely list servers and verify enabled state, transport, endpoint/command, and secret presence without exposing values.

Example discovery:

```json
{
  "query": "repository search",
  "sources": ["mcp"],
  "server": "example",
  "includeSchema": true
}
```

Example call descriptor:

```json
{
  "toolId": "mcp:example/search_repositories",
  "args": {
    "query": "foxwarm"
  }
}
```

## Internal result shape

Normal MCP calls through `call_tool`, including ToolScript, use source normalization. Plain text JSON duplicating `structuredContent` is removed; a structured-only result returns its own fields at the top level rather than inside `structuredContent` or a new `output` wrapper. Fields defined by the tool itself are not flattened or renamed.

Errors, additional explanations, meaningful block/result metadata and multimodal data are retained. Image promotion and output limits keep their existing behavior. External MCP passthrough returns the original wire result, so external clients may still see both text and `structuredContent`. Existing history is not rewritten.

## Failure handling

- A disabled server must be enabled before discovery/calls.
- For connection errors, verify transport and endpoint/command first; do not respond by editing the state file or restarting Foxwarm.
- A closed/404 context may be rebuilt on a later operation, but do not repeat a possibly executed tool merely to restore the connection. Re-establish any required remote Node/cwd explicitly.
- For authentication errors, verify that the expected token/header/environment key is configured, but never reveal its value.
- `search_tools` may return warnings for one broken MCP server while preserving results from healthy servers. Treat the per-server warning as scoped rather than assuming all MCP integration is unavailable.
