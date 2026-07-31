---
name: mcp-management
description: Configure, list, disable, troubleshoot, discover, and call Model Context Protocol (MCP) servers in Foxwarm. Use when adding or changing an MCP server, checking configured servers, choosing HTTP/SSE/stdio transport, handling MCP credentials, or explaining when configuration changes take effect.
---
# MCP management

Use this skill for MCP server setup and configuration changes. MCP configuration tools are discoverable builtins rather than default-injected tools.

## Non-negotiable configuration lifecycle

- Change MCP configuration only through the hidden `mcp_config` builtin, invoked with `call_tool`.
- A successful `mcp_config` call updates the live runtime configuration immediately. Subsequent MCP discovery and calls use the change; **no Foxwarm restart is required**.
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

Invoke that descriptor with `call_tool`. The result includes safe metadata such as enabled state, transport, command/URL, argument count, environment/header key names, and whether a token exists. It does not return secret values.

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

## Failure handling

- A disabled server must be enabled before discovery/calls.
- For connection errors, verify transport and endpoint/command first; do not respond by editing the state file or restarting Foxwarm.
- For authentication errors, verify that the expected token/header/environment key is configured, but never reveal its value.
- `search_tools` may return warnings for one broken MCP server while preserving results from healthy servers. Treat the per-server warning as scoped rather than assuming all MCP integration is unavailable.
