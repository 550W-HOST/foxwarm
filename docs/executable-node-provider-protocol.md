# Executable Node Provider Protocol

Foxwarm can load trusted executable Node providers from startup configuration. This adapter is for custom or sandbox Nodes that do not run the authenticated Foxwarm WebSocket Node runtime.

A custom provider supplies only provider-neutral filesystem primitives, an optional complete exec backend, and optional lifecycle operations. Foxwarm—not the provider—owns the canonical model-visible `read`, `write`, `edit`, and `apply_patch` schemas, patch grammar, validation, and result formatting. Provider identity is internal routing/lifecycle metadata; it is not a tool source, permission identity, or Session binding.

## Configuration

```yaml
nodeProviders:
  provider-id:
    type: executable
    command: /path/to/provider
    args: [fixed, trusted, arguments]
    timeoutSeconds: 90
```

Provider IDs use 1-64 ASCII letters, digits, dots, underscores, or hyphens. Node IDs use the slash-free grammar `[A-Za-z0-9][A-Za-z0-9._:-]*`, are at most 128 characters, and cannot equal reserved `master` in any letter case. Commands and fixed arguments are trusted startup authority. Foxwarm launches with `shell:false`, does not interpolate model values into the command line, and passes only a small allowlisted environment.

## Transport

The current protocol identifier is:

```text
foxwarm-node-provider@1
```

Each request launches one process. Foxwarm writes exactly one JSON request to stdin and closes stdin. The provider writes exactly one JSON response to stdout and exits. Every response echoes the exact `protocol`, `providerId`, `requestId`, and `operation`.

Envelope:

```json
{
  "protocol": "foxwarm-node-provider@1",
  "providerId": "provider-id",
  "requestId": "generated-request-id",
  "operation": "list",
  "request": {}
}
```

Success adds `"ok": true, "result": ...`; failure adds `"ok": false, "error": { "code": "SafeCode", "message": "Safe message", "retryable": false }`.

## List

A `list` response returns sandbox Node descriptors:

```json
{
  "nodes": [
    {
      "id": "sandbox-a",
      "kind": "sandbox",
      "type": "provider-defined-type",
      "availability": "ready",
      "defaultCwd": "provider-defined://root",
      "filesystem": "read-write",
      "exec": true
    }
  ]
}
```

Allowed backend fields:

- `filesystem: "read"` — Foxwarm derives only canonical `read`.
- `filesystem: "read-write"` — Foxwarm derives canonical `read`, `write`, `edit`, and `apply_patch`.
- `exec: true` — Foxwarm exposes canonical `exec` and sends a complete exec request.

At least one backend must be present. Providers do not send model tool names, descriptions, or JSON schemas. A provider cannot customize Foxwarm patch grammar or file-tool formatting.

`defaultCwd` is an exact opaque target-namespace value. Foxwarm checks only that it is nonempty and does not trim or otherwise normalize it.

## Filesystem

A `filesystem` request carries one primitive operation:

```json
{
  "sourceSessionId": "exact-source-session",
  "nodeId": "sandbox-a",
  "operation": "read",
  "path": "provider-defined://file",
  "offset": 0,
  "count": 65536,
  "context": {
    "agent": "exact-source-agent",
    "currentNode": "sandbox-a",
    "cwd": "provider-defined://cwd"
  }
}
```

The fixed operations are:

| Operation | Request fields | Successful result |
|---|---|---|
| `parent` | `path` | `{ "path": "provider-defined parent" }` |
| `stat` | `path` | `{ "kind": "file|directory|symlink|other", "size": 0, "modifiedAtMs": 0 }` |
| `read` | `path`, nonnegative safe integer `offset`, `count` | `{ "dataBase64": "..." }` |
| `readdir` | `path` | array of stat objects plus exact `name` |
| `write` | `path`, `contentBase64`, `flag: "w"|"wx"` | any JSON result, normally `null` |
| `mkdir` | `path` | any JSON result, normally `null` |
| `remove` | `path` | any JSON result, normally `null` |

Paths remain in the target Node namespace. Foxwarm does not apply Main-host `path.resolve`, agent-directory, URI, Windows, POSIX, slash, or backslash authority before calling the provider. The `parent` primitive owns the namespace parent relation used by canonical `write(createDirs)` and patch-add. The provider interprets relative paths using the supplied authoritative Node routing context and enforces its own root, symlink, namespace, and mutation restrictions at this primitive boundary.

`read` data is base64 because the protocol is JSON. `write` is a whole-content operation and must implement native-equivalent `w`/`wx` behavior. `mkdir` supplies recursive parent creation semantics required by canonical file tools. Provider errors should use safe filesystem-style codes such as `ENOENT`, `ENOTDIR`, or `EEXIST` when Foxwarm's canonical composition needs them. Only `ENOENT` is interpreted as a missing path; other stat errors, including malformed primitive results, propagate and fence mutation.

Foxwarm composes bounded reads, directory formatting, image promotion, parent diagnostics, exact edit replacement, patch parsing, add/update/delete sequencing, partial-application reporting, and mutation summaries above these primitives.

## Exec

An `exec` request is complete because process persistence, background delivery, cwd tracking, and cancellation may require a resident provider-specific runtime:

```json
{
  "sourceSessionId": "exact-source-session",
  "nodeId": "sandbox-a",
  "args": { "command": "pwd", "timeout": 15 },
  "context": {
    "agent": "exact-source-agent",
    "currentNode": "sandbox-a",
    "cwd": "provider-defined://cwd",
    "deferSessionCwdSync": true
  }
}
```

The provider returns the canonical exec result expected by Foxwarm. `deferSessionCwdSync` is trusted routing metadata, not a model argument. Providers without an exec backend omit `exec` from descriptors, and Foxwarm never falls back to master.

## Lifecycle

`create`, `ensure`, `inspect`, and `destroy` retain the provider-neutral lifecycle envelope. Create/ensure route by exact configured provider ID and may include an optional exact top-level `nodeId`; inspect/destroy resolve the existing Node's provider first.

```json
{
  "sourceSessionId": "exact-source-session",
  "nodeId": "optional-or-required-by-operation",
  "parameters": { "providerDefined": "plain JSON" },
  "context": { "agent": "exact-source-agent" }
}
```

Create/ensure/inspect return `node` using the same primitive descriptor shape as `list`. Destroy returns the exact `nodeId`. Results may also contain bounded `effect`, `dataRetention`, and plain-JSON `details`. Providers that do not implement an action return error code `UnsupportedOperation`.

Foxwarm validates global Node identity, serializes create/ensure/destroy ownership/effect windows inside Main, requires exact destroy confirmation before provider execution, and never infers generic deletion, erasure, security, isolation, lease, or ownership guarantees from provider success.

## Context and authority

Requests contain only bounded cloneable data: exact source Session/agent identity, exact Node identity, primitive or exec data, and authoritative routing context when available. They contain no mutable Session, callback, provider configuration, launch command, credentials, or Main secrets.

Unsupported backends, unavailable Nodes, invalid primitive responses, malformed envelopes, cancellation, timeout, or provider failure reject without retry or master fallback. Authenticated remote Nodes remain a separate adapter: their resident runtime may continue receiving complete historical model-tool calls internally, but that transport does not define this custom-provider API.

## Limits and termination

- request JSON: 4 MiB;
- list stdout: 256 KiB;
- filesystem/exec stdout: 8 MiB;
- lifecycle stdout: 512 KiB;
- lifecycle details: 64 KiB;
- stderr: 64 KiB;
- Nodes per provider: 100;
- active requests per provider: 8;
- configured timeout: 1-300 seconds, default 90.

Malformed/multiple/oversized responses, identity mismatches, invalid descriptors or primitive results, abnormal exits, signal exits, timeout, cancellation, and stream-limit failures are terminal for that call. Foxwarm uses graceful-first termination followed by kill-and-confirm handling for the direct child and never exposes raw stderr or configured launch paths to the caller.
