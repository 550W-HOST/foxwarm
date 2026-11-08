# Executable Node Provider Protocol

A trusted external executable can expose execution environments without installing the authenticated Foxwarm CLI Node runtime. Core derives canonical file tools and manages command waiting, background tracking, output and completion delivery. A provider supplies filesystem primitives, optional process start/poll primitives and optional lifecycle operations. Node is the execution identity; provider identity is routing metadata, not a caller principal or a sandbox guarantee.

The independent [Linux SSH reference provider](../skills/node-setup/examples/linux-ssh/README.md) uses this exact protocol. Core has no SSH backend, dependency or SSH-specific tool.

## Startup configuration

```yaml
nodeProviders:
  provider-id:
    type: executable
    command: /path/to/provider
    args: [fixed, trusted, arguments]
    timeoutSeconds: 90
```

The provider ID uses 1–64 ASCII letters, digits, dots, underscores or hyphens. Adapter-local Node IDs use `[A-Za-z0-9][A-Za-z0-9._:-]*`, at most 128 characters, and cannot equal `master` in any letter case. Core exposes them as `provider-id/local-id` (at most 193 characters). Local IDs need be unique only inside their Provider. Core qualifies descriptor/lifecycle identity fields and removes the namespace before invoking the executable; all protocol examples below intentionally use local IDs. Native `master` and authenticated CLI IDs/protocols are unchanged.

Commands and fixed arguments are administrator configuration. Core uses `shell:false`, never interpolates model commands into the launcher command line and passes only its small existing allowlisted child environment. Providers own their connection configuration and credentials. Configuration is loaded at startup, not hot-reloaded.

## Transport

The single current protocol identifier is `foxwarm-node-provider`. There is no protocol-version field, negotiation, legacy exec adapter or fallback.

Each model-tool, exec, lifecycle and discovery request launches a new process. Core writes one JSON request to stdin and closes stdin. The provider writes exactly one JSON response to stdout and exits. Diagnostics belong on stderr. Code and Terminal services use the separate, optional [service channel](#optional-service-channel) below. Echo these four identity fields exactly:

```json
{
  "protocol": "foxwarm-node-provider",
  "providerId": "provider-id",
  "requestId": "generated-request-id",
  "operation": "list"
}
```

Operations with inputs add `request`. Success adds `"ok": true, "result": ...`; failure adds `"ok": false, "error": { "code": "SafeCode", "message": "Safe message", "retryable": false }`. Result and error are mutually exclusive. Error text must be safe for the caller: do not include credentials, private launcher arguments or raw transport diagnostics.

Operations are `describe`, `list`, `filesystem`, `exec-start`, `exec-poll`, declared `create`, `ensure`, `inspect`, `destroy` lifecycle actions, and `connect`, which opens the optional service channel instead of answering one request. A response identity mismatch or malformed response fails the call; Core does not try another protocol or replay effects.

## Describe

`describe` has no request payload and returns structured provider metadata:

```json
{
  "label": "Example environments",
  "description": "Execution environments managed by this adapter.",
  "lifecycle": ["create", "ensure", "inspect", "destroy"],
  "createParameters": {
    "type": "object",
    "properties": { "size": { "type": "string", "enum": ["small", "large"] } },
    "required": ["size"]
  },
  "ensureParameters": { "type": "object" },
  "lifecycleDescription": "Describe concrete resource effects here.",
  "dataRetention": "Describe retained or removed data here."
}
```

`label`, `description` and `lifecycle` are required. The other fields are optional. Lifecycle can be empty: accessing an existing machine does not imply creating or destroying it. Parameter schemas are bounded plain JSON for discovery; the adapter performs final business-parameter validation. Core does not implement another schema-validation engine. Successful descriptions are cached for the configured process lifetime.

Agents use qualified IDs in Node selection, file/exec tools and Node lifecycle requests, for example `node({action:"select",nodeId:"provider-id/example-node"})`. A supplied create/ensure Node ID must also have that Provider prefix; the adapter receives only `example-node`. Provider-defined `details` remain opaque.

Agents use `node({action:"inspect",providerId:"provider-id"})` to discover the description, supported operations and parameters. `providerId` and `nodeId` are mutually exclusive for inspection. Programmatic `node({action:"list"})` returns structured `nodes`, `providers` and `currentNode` beside readable `output`.

## List

`list` returns `{ "nodes": [...] }`. Each descriptor has:

```json
{
  "id": "example-node",
  "label": "Example Node",
  "kind": "remote",
  "type": "provider-defined-type",
  "availability": "ready",
  "defaultCwd": "provider-defined://root",
  "filesystem": "read-write",
  "exec": true,
  "services": { "vscode-fs": 1, "vscode-git": 2, "vscode-pty": 1 }
}
```

`label`, `kind`, `defaultCwd`, `exec` and `services` are optional. `services` declares the fixed Code/Terminal services the Node can serve over the [service channel](#optional-service-channel), with the same names and versions as a resident Node's capabilities. A Provider that omits it keeps today's behavior; no version or negotiation field is added. Names Core does not know are ignored; a malformed shape or a version that is not a positive integer rejects the inventory. Kind is `remote` (the default) or `sandbox`; the latter is provider metadata, not an isolation guarantee. Availability is `ready`, `offline`, `unavailable` or `error`.

`filesystem:"read"` derives canonical `read`. `filesystem:"read-write"` also derives `write`, `edit` and `apply_patch`. `exec:true` derives canonical `exec`. Every executable-provider Node exposes at least a read filesystem: exec logs must be readable in the same Node namespace. Providers do not supply model tool schemas, tool formatting or patch semantics. Unsupported capabilities never fall back to Main.

`defaultCwd` is an exact nonempty target-namespace value. Core does not trim or host-resolve it. Relative file paths use the captured cwd for that same target, or the adapter's default. Selecting a Node does not grant isolation or reserve the environment; existing selection/cwd behavior is unchanged.

## Filesystem

The `filesystem` request is one byte-oriented primitive:

```json
{
  "nodeId": "example-node",
  "operation": "read",
  "path": "provider-defined://file",
  "offset": 0,
  "count": 65536,
  "context": { "cwd": "provider-defined://cwd" }
}
```

`context` can be empty. It is a captured target cwd, not a mutable Session. Session identity, Agent metadata, callbacks, programmatic flags and completion addresses are not sent in file or process primitive payloads. Core retains caller authority.

| Operation | Additional fields | Successful result |
|---|---|---|
| `parent` | `path` | `{ "path": "target-native parent" }` |
| `stat` | `path` | `{ "kind": "file|directory|symlink|other", "size": 0, "modifiedAtMs": 0 }` |
| `read` | `path`, nonnegative safe integer `offset`, `count` | `{ "dataBase64": "..." }` |
| `readdir` | `path` | array of stat objects plus exact `name` |
| `write` | `path`, `contentBase64`, `flag:"w"|"wx"|"a"` | any JSON result, normally `null` |
| `mkdir` | `path` | any JSON result, normally `null` |
| `remove` | `path` | any JSON result, normally `null` |

Size, offsets and counts are bytes. Read fills the requested range up to EOF and returns canonical base64 for at most `count` bytes. An incomplete log snapshot is reported unavailable rather than presented as complete retained content. Write uses binary bytes: `w` replaces the entire content, `wx` creates exclusively and fails when the destination exists, and `a` appends the supplied bytes (creating a missing file). `mkdir` creates parents recursively. Errors use filesystem codes such as `ENOENT`, `EACCES`, `ENOTDIR` and `EEXIST`; only `ENOENT` means missing. Do not translate permission or transport failures into missing files.

Core also composes `copy_between_nodes` and file-delivery preparation from these primitives. Transfer reads and writes use at most 1 MiB of file bytes per primitive request; Main streams the content with bounded memory and can copy files larger than a single request envelope. The first write uses `w` or `wx`; subsequent writes use `a`. Empty files still create one empty initial write. A later failure or cancellation leaves the written prefix, with no automatic replay, rollback or successful receipt. Relative primitive-transfer paths use the environment default directory, not a Session cwd. Main and authenticated CLI Nodes publish completed files using their native temporary-file semantics.

Core composes bounded reads, directory and image presentation, parent diagnostics, exact replacement and add/update/delete patch sequencing. Existing partial-effect semantics are unchanged. Target home expansion, path separators, URI interpretation, symlinks and restrictions belong to the adapter. Core does not resolve target paths through Main's filesystem. Reserved native Agent path variables are rejected when no actual target Agent directory mapping exists.

Tool authorization applies to the original model call and exact target Node, not to additional fake model calls for each primitive. Existing master-only resolved-path policy is not a remote filesystem jail; adapters enforce their configured directory boundaries. The SSH reference uses the SSH account's real permissions and does not provide a jail.

## Process primitives

### Start

`exec-start` receives only:

```json
{ "nodeId": "example-node", "command": "printf hello", "cwd": "provider-defined://cwd" }
```

`cwd` is optional. Pass the command unchanged to the target's command interpreter. Return after submitting the execution, not after waiting for the command:

```json
{
  "ref": "opaque-persistable-execution-reference",
  "outputPath": "provider-defined://logs/this-execution",
  "cwd": "provider-defined://actual-initial-cwd",
  "startedAt": "2026-01-01T12:00:00Z",
  "pid": 1234
}
```

`ref`, `outputPath` and actual initial `cwd` are required. `startedAt` and `pid` are optional and must represent actual facts. Ref identifies this execution across adapter exits and Core restarts; a reusable PID alone is insufficient. Ref is persisted privately and is not a model-visible exec ID. New Core execution records store the qualified Node ID. Recovery of older provider records accepts their local Node ID only beside the already-persisted exact Provider ID; it does not add an ordinary routing alias, rewrite history, or restart the command. Existing provider selections and exact policy rules are not automatically migrated.

The command must survive the adapter request's process exit. Do not retain inherited stdin/stdout/stderr that would prevent the one-shot launcher from closing. Logs contain raw merged command output, append without rewriting published prefixes and are readable through the Node's own filesystem primitives. Do not return a Main-host cache path as a remote log path.

### Poll

`exec-poll` receives `{ "nodeId": "example-node", "ref": "..." }`. Return one of:

```json
{ "state": "running", "cwd": "provider-defined://known-live-cwd" }
```

```json
{ "state": "finished", "exitCode": 7, "finishedAt": "2026-01-01T12:00:01Z", "durationMs": 1000, "cwd": "provider-defined://final-cwd" }
```

```json
{ "state": "lost", "reason": "The original environment or execution records no longer exist." }
```

Running cwd is optional. Finished `exitCode` is required and is a real integer or `null` when unknown; finish timestamp, duration, cwd and safe `error` are optional. Missing records must not mean exit code zero. A transient query failure is an error response, not finished or lost.

### Core-owned behavior

Core uses the existing `PersistentExecManager`, same registry and existing 24-hour background-notification tracking lifetime. Native records without a provider reference remain native; authenticated CLI protocols and persisted native jobs are unchanged. Core allocates public exec IDs, waits within the requested foreground budget, reads bounded log samples, retains at most 1 MiB of programmatic raw content, delivers completion to the original exact owner and removes tracking only after acknowledged delivery or expiration.

Stop releases foreground waiting without killing the command. Stop during start waits for the bounded start receipt or hard deadline; it does not abort the launcher as a substitute for cancelling a remote command. An uncertain start is reported as unknown and must never be automatically repeated. There is no process-kill primitive.

Foreground output observation is also bounded and read-only. Completed commands use the remaining requested foreground budget; after normal background timeout, one shared 500 ms snapshot window preserves fast partial capture. Stop or hard cancellation ends these reads promptly, and display/programmatic formatting does not restart them after cancellation. Unavailable output is reported explicitly; the foreground signal is never retained in job state or restart resolution.

Poll requests use at most `min(configured timeout, 5 seconds)`. Foreground and reconciliation share one in-flight status query per execution. Slow queries cannot extend the foreground deadline or delay other completion delivery; transient failures retain tracking. Restart queries the same configured provider and persisted ref without invoking start again. Missing provider configuration does not transfer the execution to another provider. Lost state reports an unknown exit. A real finished status remains real even when reading output fails; output loss is reported separately.

Adapters keep status and output available for normal tracking and describe their retention policy. Core does not promise indefinite remote storage. Start submission and registry persistence retain the existing crash uncertainty window; no transaction, rollback or exactly-once promise is added.

Known cwd updates apply only to the exact Session owner while it still selects the execution Node, including deferred parallel-exec replay. Unknown cwd is not guessed. Native PIDs/process trees are retained; providers without these facts do not get invented host PIDs or process trees.

## Optional lifecycle

Lifecycle requests retain the authorized Main control-plane envelope:

```json
{
  "sourceSessionId": "exact-source-session",
  "nodeId": "optional-for-create-or-ensure",
  "parameters": { "providerDefined": "plain JSON" },
  "context": { "agent": "exact-source-agent" }
}
```

Create/ensure route by configured provider ID; inspect/destroy resolve the exact existing Node. Create/ensure/inspect return `node` using the list descriptor shape; destroy returns exact `nodeId`. Optional fields are `effect`, `dataRetention` and bounded plain-JSON `details`. Declare supported actions in `describe.lifecycle`; unsupported actions fail explicitly.

Provider configuration may declare `nodeProviders.<id>.parentNode`, an existing Main-owned authorization parent. It is startup-only administrator configuration, not a provider descriptor or lifecycle parameter. `parentNode` is not added to the external request/response protocol. Core records the trusted relationship and preserves referenced offline identities in its existing Node registry.

CreatedBy-bearing internal callers must give an explicit `ensure.nodeId`; Core then authorizes the existing identity or configured parent for a fresh one before effects. Top-level callers retain optional IDs. Omitted-ID ensure cannot establish a Node-subtree target before the provider runs; non-subtree policy still applies. Core does not infer identity from opaque options. Existing returned identities keep their stored parent, and create cannot return an existing identity as fresh. Provider destroy is refused while a Node has descendants; native credential cascade does not destroy provider resources.

Core checks global identity, retains Main-owned mutation ordering, requires exact destroy confirmation, and does not infer deletion, erasure, isolation or lease guarantees. Create/ensure do not select the Node, create an Agent or assign work. Destroy does not acquire a new busy-exec restriction or implicitly kill commands: subsequent polls report the provider's actual finished/lost behavior.

## Optional service channel

Code (file browser, editor, source control) and Terminal use three fixed administrator services: `vscode-fs` (version 1), `vscode-git` (version 1; immutable commit details need 2) and `vscode-pty` (version 1). They are not model tools: they do not pass model-tool approval and are available only to the administrator web interface for Nodes admitted to the authorization tree. A Node that declares `services` in `list` can serve them over one long-lived pipe to the same `command`/`args`. A one-shot request per file or Git call is not used: Code issues many small concurrent requests, the one-shot admission limit of eight would reject them, and every call would re-enter the target environment.

### Connecting

Core starts the channel the first time a service is used, not at discovery. It launches the executable like any request, then writes one standard envelope line to stdin and **keeps stdin and stdout open**:

```json
{"protocol":"foxwarm-node-provider","providerId":"provider-id","requestId":"generated-request-id","operation":"connect","request":{"nodeId":"example-node"}}
```

`nodeId` is the local ID, as in every other request. The provider connects to that environment and writes one confirmation line using the usual response envelope. It must echo `protocol`, `providerId`, `requestId` and `operation` exactly:

```json
{"protocol":"foxwarm-node-provider","providerId":"provider-id","requestId":"generated-request-id","operation":"connect","ok":true,"result":{"nodeId":"example-node","services":{"vscode-fs":1,"vscode-git":2,"vscode-pty":1}}}
```

`result.nodeId` must repeat the requested local ID, and `result.services` lists the services and versions this process actually serves; those versions are authoritative for the channel. A failure uses the normal `ok:false` error envelope, whose safe message is shown to the administrator. An identity mismatch, a different `nodeId`, a malformed confirmation, an early exit, or no confirmation within `timeoutSeconds` fails the start, terminates the process and is not retried. Unsolicited frames before the confirmation are invalid.

### Frames

After confirmation both directions exchange newline-delimited JSON objects (one UTF-8 JSON text per line, LF terminated, no embedded newlines) using the same `node_service_*` frames as resident Nodes:

| Direction | Frame | Fields |
|---|---|---|
| Core → provider | `node_service_request` | `requestId`, `service`, `operation`, `args` |
| Core → provider | `node_service_command` | `service`, `operation`, `args` (one-way; no reply) |
| Provider → Core | `node_service_response` | `requestId`, `result` (object) |
| Provider → Core | `node_service_error` | `requestId`, `error`: `{ "code", "message", "statusCode" }` (HTTP 400–599) |
| Provider → Core | `node_service_event` | `service`, `event` (object) |

The operations, arguments, results and event shapes of the three services are exactly those of resident Nodes, so a provider implementation maps one-to-one onto them: `vscode-fs` `stat`, `read-directory`, `read-file`, `write-file`, `create-directory`, `delete`, `rename`; `vscode-git` `status`, `commit` (2), `content`. Requests can be outstanding concurrently and replies can arrive in any order; correlate by `requestId`. A reply for an unknown or finished request is ignored. Any other frame type, malformed JSON, or an event for a service the channel did not confirm ends the channel. Service request deadlines are 30 seconds; Core does not retry or replay a request whose outcome is uncertain, and has no request cancellation frame.

`vscode-fs` requires absolute paths in the target's POSIX-style namespace and rejects relative ones with `InvalidPath`. Code can open a Provider workspace only with a usable absolute root, so a Node that declares services should also give an absolute `defaultCwd`. Content crosses as canonical base64; a file of up to 50 MiB is read or written in a single frame.

### Limits

Each frame in either direction is limited to 72 MiB (a 50 MiB file is about 67 MiB as base64 plus its envelope). An oversize or unterminated frame ends the channel. Core drains the provider's stderr continuously and discards it; the one-shot stderr limit does not apply to a channel, and diagnostics are never returned to callers. The eight active one-shot requests per provider do not count channel requests.

### Lifecycle

There is one channel per Node, started lazily and shared by all callers. The channel is a **transport generation**. The generation ends when the provider process exits, stdout closes, a frame is invalid, a write fails, discovery no longer reports the Node ready with services, or Main shuts down or restarts. Core detects disconnection by pipe EOF and process exit only; there is no heartbeat. To end a channel Core closes stdin and gives the process a short time to exit before terminating it, so a provider must exit when stdin reaches EOF and release its environment connection (for example the `ssh` or `docker exec` child). When a generation ends, outstanding requests fail with `NodeUnavailable` and their effects are not retried, and attached terminals receive a transport error rather than a process exit. The next use starts a new generation with a new `connect`; earlier requests are never replayed, and a stale endpoint is never moved to the new generation.

Because the channel is a child of the Main server, it always closes when Main restarts. Whether state behind it survives (for example, running terminals) is the provider's choice. A provider that keeps terminals across channels should list them again after reconnect and describe that retention in `describe.description` or `dataRetention`, as exec retention is described.

## Bounds and failure handling

- Request JSON: 4 MiB; list and process metadata stdout: 256 KiB.
- Filesystem stdout: 8 MiB; description/lifecycle stdout: 512 KiB; lifecycle details: 64 KiB.
- Parameter schemas: 16 KiB each; stderr: 64 KiB; Nodes per provider: 100.
- Active requests per provider: 8; configured deadline: 1–300 seconds, default 90; poll deadline capped at 5 seconds.
- Service channel: one per Node; `connect` confirmation line 64 KiB within the configured deadline; 72 MiB per frame; service requests 30 seconds.

Malformed, multiple or oversized responses, identity mismatches, abnormal exits, cancellation and deadline failures terminate that RPC without fallback or automatic replay. The transport bounds graceful-first termination and direct-child exit confirmation; raw stderr and launcher paths are not returned. An `exec-start` transport failure may still have caused a remote effect.

Executable providers remain unavailable to external MCP principals. The existing authenticated CLI external-owner path, credentials, protocol negotiation and completion acknowledgements are separate and unchanged.
