# Executable Node Provider Protocol

Foxwarm can load trusted executable Node providers from startup application configuration. This adapter is intended for externally implemented sandbox Nodes that do not run the authenticated Foxwarm WebSocket Node runtime.

This phase provides discovery and complete Node capability invocation only. It does not define Node lifecycle, profiles, ownership, Docker, bwrap, VM behavior, workspaces, fixed Node services, or compound file transfer.

## Configuration

```yaml
nodeProviders:
  provider-id:
    type: executable
    command: /path/to/provider
    args: [fixed, trusted, arguments]
    timeoutSeconds: 90
```

Provider IDs use 1-64 ASCII letters, digits, dots, underscores, or hyphens. Executable-provider Node IDs use 1-128 ASCII letters, digits, dots, underscores, colons, or hyphens, must begin with a letter or digit, and cannot be the reserved `master` ID in any letter case. `/` is excluded so canonical `node:<node-id>/<tool>` IDs remain unambiguous. `command` and every `args` entry are trusted startup configuration. Foxwarm never interpolates model or tool values into the command line and launches the command with `shell:false`.

Each protocol request launches one provider process. The child receives a small allowlisted environment rather than Foxwarm's complete environment. Configuration changes require a Foxwarm restart.

## Transport

Protocol name:

```text
foxwarm-node-provider@1
```

Foxwarm writes exactly one JSON request to stdin and closes stdin. The provider writes exactly one JSON response to stdout and exits. Leading or trailing stdout whitespace is accepted; any second/trailing payload is rejected. Diagnostic stderr is never included in a tool-visible error.

Every response must echo the exact `protocol`, `providerId`, `requestId`, and `operation` values from its request.

## List operation

Request:

```json
{
  "protocol": "foxwarm-node-provider@1",
  "providerId": "provider-id",
  "requestId": "generated-request-id",
  "operation": "list"
}
```

Successful response:

```json
{
  "protocol": "foxwarm-node-provider@1",
  "providerId": "provider-id",
  "requestId": "generated-request-id",
  "operation": "list",
  "ok": true,
  "result": {
    "nodes": [
      {
        "id": "provider-defined-node-id",
        "kind": "sandbox",
        "type": "provider-defined-type",
        "availability": "ready",
        "defaultCwd": "provider-defined://root",
        "tools": [
          {
            "name": "read",
            "description": "Provider-safe capability description.",
            "parameters": { "type": "object" }
          }
        ]
      }
    ]
  }
}
```

Executable providers may advertise one or more Nodes. In this protocol version their Node kind is exactly `sandbox`. Supported availability values are `ready`, `unavailable`, `offline`, and `error`. Paths and `defaultCwd` are opaque provider-local strings; Foxwarm does not impose a host path or workspace convention.

## Invoke operation

Request:

```json
{
  "protocol": "foxwarm-node-provider@1",
  "providerId": "provider-id",
  "requestId": "generated-request-id",
  "operation": "invoke",
  "request": {
    "sourceSessionId": "exact-source-session",
    "nodeId": "provider-defined-node-id",
    "toolName": "read",
    "args": { "filePath": "provider-defined://file" },
    "context": {
      "agent": "exact-source-agent",
      "currentNode": "provider-defined-node-id",
      "cwd": "provider-defined://cwd"
    }
  }
}
```

`currentNode` and `cwd` are included only when the canonical Node dispatcher has an authoritative routing snapshot for the selected Node. The request contains no mutable Session, callback, provider command, provider credential, or Foxwarm credential.

Successful response:

```json
{
  "protocol": "foxwarm-node-provider@1",
  "providerId": "provider-id",
  "requestId": "generated-request-id",
  "operation": "invoke",
  "ok": true,
  "result": { "output": "provider-defined result" }
}
```

The provider receives one complete Node capability call. It owns path interpretation, execution, and environmental restrictions. A provider may advertise a partial tool set; Foxwarm rejects unadvertised capabilities before `invoke` and never falls back to the master Node.

## Error response

```json
{
  "protocol": "foxwarm-node-provider@1",
  "providerId": "provider-id",
  "requestId": "generated-request-id",
  "operation": "invoke",
  "ok": false,
  "error": {
    "code": "ProviderDefinedCode",
    "message": "Safe bounded error summary.",
    "retryable": false
  }
}
```

A failed envelope contains `error` and no `result`; a successful envelope contains `result` and no `error`. Providers must keep the error message safe for the caller. Raw stderr, launch paths, and abnormal-process diagnostics are not forwarded.

## Fixed limits and termination

- request JSON: 4 MiB;
- list stdout: 256 KiB;
- invoke stdout: 8 MiB;
- stderr: 64 KiB;
- Nodes per provider: 100;
- tools per Node: 200;
- tool schema: 16 KiB;
- active requests per provider: 8;
- configured timeout: 1-300 seconds, default 90. The default exceeds the canonical Node `exec` foreground wait plus its outer transport allowance.

Malformed JSON, multiple payloads, identity mismatches, invalid descriptors, oversized data, unavailable capabilities, nonzero exits, and signal exits fail without retry or master fallback. Timeout, cancellation, and stream-limit termination send a graceful termination signal first, then use a kill fallback and wait for the direct child process to exit. Direct-child exit also starts a bounded close confirmation; if inherited stdout/stderr remains open, Foxwarm destroys its owned pipe ends and rejects deterministically rather than waiting indefinitely. This is direct-child/stdin/stdout lifecycle handling, not a provider process-tree manager.
