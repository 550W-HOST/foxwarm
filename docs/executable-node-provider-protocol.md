# Executable Node Provider Protocol

Foxwarm can load trusted executable Node providers from startup application configuration. This adapter is intended for externally implemented sandbox Nodes that do not run the authenticated Foxwarm WebSocket Node runtime.

This protocol provides discovery, complete Node capability invocation, and provider-neutral Node lifecycle operations. It does not define profiles, ownership, Docker, bwrap, VM behavior, workspaces, fixed Node services, or compound file transfer. A Node is the selected execution identity; a provider is a Main-owned implementation that may advertise and manage multiple globally unique Nodes.

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

## Lifecycle operations

The lifecycle operations are `create`, `ensure`, `inspect`, and `destroy`. They use the same one-request/one-response transport, identity echoes, timeout, cancellation, stderr, and direct-child cleanup rules as `list` and `invoke`.

`create` and `ensure` route to the exact configured `providerId`; the Node may not exist yet. Their request body is:

```json
{
  "sourceSessionId": "exact-source-session",
  "nodeId": "optional-exact-requested-node-id",
  "parameters": { "providerDefined": "plain JSON" },
  "context": { "agent": "exact-source-agent" }
}
```

`nodeId` is optional for `create` and `ensure`. When supplied, it is the Node identity rather than provider-opaque data: it must use the slash-free 1-128 ASCII grammar `[A-Za-z0-9][A-Za-z0-9._:-]*`, cannot be `master` in any letter case, is passed unchanged to the provider, and must match the returned descriptor ID. Foxwarm does not trim an invalid requested identity into another ID. Before provider execution, `create` rejects any already-owned requested ID; `ensure` permits no owner or the selected provider as owner and rejects another provider's ownership. Provider-generated IDs remain subject to the post-result global duplicate check.

Within one Foxwarm Main process, all `create`, `ensure`, and `destroy` calls share one registry-owned serial mutation lane. The lane covers authoritative ownership resolution/preflight, provider execution, result identity validation, and the post-result duplicate check, so concurrent lifecycle calls cannot cross those windows. `inspect` remains read-only and does not enter the lane. A queued call rechecks cancellation after acquiring the lane and rejects without provider execution if already cancelled; an active provider call retains the normal provider-level cancellation contract. The lane is local serialization only, not a distributed lock, lease, transaction, retry, or provider rollback guarantee.

`inspect` and `destroy` resolve the owning provider from an existing exact `nodeId` before launching the provider process. Their request body additionally contains that exact identity:

```json
{
  "sourceSessionId": "exact-source-session",
  "nodeId": "provider-defined-node-id",
  "parameters": { "providerDefined": "plain JSON" },
  "context": { "agent": "exact-source-agent" }
}
```

Foxwarm validates the exact user confirmation phrase `destroy node <nodeId>` before sending a `destroy` operation. The confirmation phrase is not provider authority and is not included in the provider request. Lifecycle requests contain no provider configuration, launch command, credentials, mutable Session, callbacks, or ownership claim.

Successful `create`, `ensure`, and `inspect` results contain the provider's exact safe Node descriptor. A successful `destroy` result echoes the exact `nodeId`. Every lifecycle result may additionally include bounded provider-described effect, data-retention, and opaque details:

```json
{
  "node": {
    "id": "provider-defined-node-id",
    "kind": "sandbox",
    "type": "provider-defined-type",
    "availability": "ready",
    "tools": []
  },
  "effect": "Provider-safe description of what the operation did.",
  "dataRetention": "Provider-safe description of what data may remain.",
  "details": { "providerDefined": "plain JSON" }
}
```

For `destroy`, replace `node` with `"nodeId": "provider-defined-node-id"`. Foxwarm reports these fields as provider statements; it does not convert successful completion into a generic deletion, erasure, isolation, or security guarantee. Descriptor/provider/Node identity mismatches and duplicate global Node IDs fail closed. A provider that does not implement an operation must return error code `UnsupportedOperation`, which Foxwarm exposes as an unsupported lifecycle operation without retry or master fallback.

Lifecycle `parameters` are provider-opaque plain finite JSON objects; they are not the Node identity field. They are at most 64 KiB after normalization, with depth at most 12, at most 2,048 entries per object/array, and keys at most 256 characters. The complete normalized lifecycle result is at most 128 KiB at the Main service boundary. Executable-provider lifecycle stdout is at most 512 KiB; `effect` and `dataRetention` are each at most 4,096 characters, and `details` is plain finite JSON at most 64 KiB.

Effectively isolated sessions are structurally denied `create`, `ensure`, and `destroy` regardless of an exact builtin `node` allow rule because Phase 3A defines no Node ownership/sharing policy. Read-only `inspect` must pass the existing exact bound/current-Node access check. Non-isolated sessions may use lifecycle operations supported by the selected provider.

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

A failed envelope contains `error` and no `result`; a successful envelope contains `result` and no `error`. Providers must keep the error message safe for the caller. Raw stderr, launch paths, and abnormal-process diagnostics are not forwarded. Lifecycle implementations that fail outside the bounded provider-error contract are converted to a generic retryable lifecycle-provider failure rather than exposing the raw exception.

## Fixed limits and termination

- request JSON: 4 MiB;
- list stdout: 256 KiB;
- invoke stdout: 8 MiB;
- lifecycle stdout: 512 KiB;
- stderr: 64 KiB;
- Nodes per provider: 100;
- tools per Node: 200;
- tool schema: 16 KiB;
- active requests per provider: 8;
- configured timeout: 1-300 seconds, default 90. The default exceeds the canonical Node `exec` foreground wait plus its outer transport allowance.

Malformed JSON, multiple payloads, identity mismatches, invalid descriptors, oversized data, unavailable capabilities, nonzero exits, and signal exits fail without retry or master fallback. Timeout, cancellation, and stream-limit termination send a graceful termination signal first, then use a kill fallback and wait for the direct child process to exit. Direct-child exit also starts a bounded close confirmation; if inherited stdout/stderr remains open, Foxwarm destroys its owned pipe ends and rejects deterministically rather than waiting indefinitely. This is direct-child/stdin/stdout lifecycle handling, not a provider process-tree manager.
