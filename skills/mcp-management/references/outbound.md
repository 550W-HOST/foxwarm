# Outbound MCP connections

This reference covers Foxwarm connecting to another tool server. It does not configure Foxwarm's inbound `access.identities`; for entry-identity configuration and its supported live update path, load [access-control](../../access-control/SKILL.md). MCP configuration tools are discoverable builtins rather than default-injected tools.

## Outbound configuration lifecycle

- Use `ctl mcp set` (the `mcp_config` builtin) for connection settings. The former Setup Authorizations entry is not available; existing OAuth grants and administrator APIs remain intact.
- A successful `mcp_config` call updates the live runtime configuration immediately. Existing HTTP caller connections are closed after the update, and subsequent discovery/calls use the change; **no Foxwarm restart is required**.
- Do **not** manually edit the MCP state/config file. Manual file edits do not update the live cached configuration immediately and can leave disk and runtime behavior inconsistent.
- Never print, copy into chat, or commit real tokens, environment secrets, private headers, or credentials. Use values supplied through an approved secret-handling path and keep diagnostic output redacted.

## Safe listing

List configured servers with the safe-summary command:

```text
mcp list
```

The result includes safe metadata such as enabled state, transport, command/URL, argument count, environment/header key names, whether a token exists, and the configured tool-call timeout override (`null` means the default of 60 seconds). It does not return secret values.

`ctl mcp --help` lists the MCP commands.

## Configure a server

Run `ctl mcp set` with the complete connection settings being created or changed; `ctl mcp set --help` shows every option.

Streamable HTTP example:

```text
mcp set example --transport streamable-http --url https://mcp.example.invalid/mcp --token @token --timeout-seconds 240 --enable
  values: {"token": "<secret supplied at runtime>"}
```

Stdio example:

```text
mcp set example-local --transport stdio --command example-mcp-server --args=--stdio --env @env --enable
  values: {"env": {"EXAMPLE_API_KEY": "<secret supplied at runtime>"}}
```

Pass `--env` and `--headers` as `@name` values or one JSON object text; repeat `--args` for each server argument.

### Tool-call timeout

`timeoutSeconds` is optional and applies only to tool calls for that server. Acceptable overrides are finite values from 1 through 3600 seconds. Omitting the field leaves the current timeout setting unchanged; servers without an override use 60 seconds. To remove an existing override without changing the connection settings, run `ctl mcp set <name> --timeout-seconds 0`; the canonical persisted configuration removes the field. Connection setup and tool listing do not use this override.

## Administrator-managed OAuth

The former **Setup → Authorizations** entry has been removed. No replacement MCP management page is currently exposed. Existing OAuth configuration, persisted grants, administrator management APIs and browser callback flow remain intact; authorized connections can continue using their stored grants. Do not direct users to a deleted button or claim that a new MCP page exists.

New or replacement browser consent must be arranged by the administrator through the retained administrator APIs, using an approved credential-handling path rather than asking for tokens or client secrets in chat. OAuth still uses startup app Config `url` as its public HTTPS callback/client-metadata prefix; localhost HTTP remains available for development. Static Authorization and OAuth remain mutually exclusive, and ordinary resource headers are not forwarded to authorization-server requests.

The selected account is deliberately shared by the instance. Existing tool permissions still apply and each caller retains a separate remote MCP context. Same-grant refresh preserves those contexts; explicit reauthorization may select another account and replaces them. Disconnect removes local account authorization without promising upstream revocation or rollback of running effects. Stdio continues to use environment credentials.

## Disable or re-enable

Disable an existing server without repeating its connection details:

```text
mcp set example --no-enable
```

Use `ctl mcp set <name> --enable` to re-enable an existing server. List safe summaries afterward to confirm the state.

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

1. Configure or enable the server with `ctl mcp set`.
2. Run `ctl tool search --source mcp` and, when known, `--server <name>`.
3. Prefer the returned `toolId`, such as `mcp:example/tool_name`.
4. Run it with `ctl tool call <tool-id> --args @args`, passing the target arguments as `values.args`.
5. If discovery fails, safely list servers and verify enabled state, transport, endpoint/command, and secret presence without exposing values.

Example discovery:

```text
tool search --source mcp --server example 'repository search'
```

Example call descriptor:

```text
tool call mcp:example/search_repositories --args @args
  values: {"args": {"query": "foxwarm"}}
```

## Internal result shape

Normal MCP calls through `ctl tool call`, including ToolScript's `call_tool`, use source normalization. Plain text JSON duplicating `structuredContent` is removed; a structured-only result returns its own fields at the top level rather than inside `structuredContent` or a new `output` wrapper. Fields defined by the tool itself are not flattened or renamed.

Errors, additional explanations, meaningful block/result metadata and multimodal data are retained. Image promotion and output limits keep their existing behavior. External MCP passthrough returns the original wire result, so external clients may still see both text and `structuredContent`. Existing history is not rewritten.

## Failure handling

- A disabled server must be enabled before discovery/calls.
- For connection errors, verify transport and endpoint/command first; do not respond by editing the state file or restarting Foxwarm.
- A closed/404 context may be rebuilt on a later operation, but do not repeat a possibly executed tool merely to restore the connection. Re-establish any required remote Node/cwd explicitly.
- For authentication errors, verify that the expected token/header/environment key is configured, but never reveal its value.
- `tool search` may return warnings for one broken MCP server while preserving results from healthy servers. Treat the per-server warning as scoped rather than assuming all MCP integration is unavailable.
