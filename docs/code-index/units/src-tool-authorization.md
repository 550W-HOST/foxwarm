# Unit: src-tool-authorization

Files: src/toolAuthorization.ts, src/toolAuthorization.test.ts, src/tools/toolAuthorizationTools.ts
Secondary files: src/isolatedCheck.ts, src/tools/resolvedTools.ts, src/tools/unifiedSearch.ts, src/nodeExecutionService.ts, src/mcpExternalService.ts, src/mainManagementToolService.ts, src/llm.ts, src/sessionTurnRunner.ts, src/toolscript.ts

## Purpose

Owns the instance-level ordered tool authorization policy, strict YAML parser, bounded per-process loader cache, canonical request/path facts, first-match evaluation, and the master-only atomic replacement tool. Generic rules apply independently of Agent isolation; current exact isolated-Agent rules and structural isolation guards remain a later compatibility layer.

## Key exports

- `TOOL_AUTH_CONFIG_PATH` — fixed `state/tool-authorization.yaml` authority.
- `parseToolAuthorizationPolicyBytes()` — strict shared parser/validator for runtime loads and replacement candidates.
- `loadToolAuthorizationPolicy()` / `loadToolAuthorizationPolicySync()` — async/sync execution-time loaders with a ten-second successful-parse cache and one fresh retry.
- `buildToolAuthorizationRequest()` — derives Agent, Session, canonical source/name/server, resolved target Node, args, and master-resolvable path facts.
- `evaluateToolAuthorization()` / `evaluateToolAuthorizationSync()` — ordered first-match evaluation plus explicit default action.
- `ToolAuthorizationPolicyUnavailableError` / `isToolAuthorizationPolicyUnavailable()` — trusted RPC-preserved fatal-current-turn classification used only after both policy load attempts fail.
- `installToolAuthorizationPolicyBytes()` — validates and atomically replaces the fixed policy with the exact captured bytes, then invalidates the installing process cache.
- `tool_set_tool_rules({ filePath })` — Main-owned master-only candidate installation after the current policy authorizes both the setter and `node:master/read` of the candidate path.

## Policy contract

The policy is a strict version-1 YAML object with `defaultAction: allow | deny` and at most 256 ordered rules. Every rule has a unique bounded `id`, optional `enabled`, strict `match`, `action`, and optional bounded `reason`. Unknown fields, unsupported versions/operators/path variables, unsafe dotted argument paths, duplicate IDs, excessive sizes, and malformed YAML are rejected.

The confirmed matcher vocabulary is `agent`, `session`, `tool`, `targetNode`, `args`, and `path`. Scalar matching accepts an exact scalar, bounded exact list, or strict `{ equals?, oneOf?, exists? }`. Tool selectors may match exact `source`, MCP `server`, and `name`; string/list shorthand matches only the exact tool name. Path containment supports selected path arguments plus `${agent.dir}`, `${agent.memoryDir}`, and `${workspace}`. Host containment is evaluated only for master-resolved paths; remote Node path namespaces stay opaque and cannot satisfy `allWithin` host rules.

The first enabled matching rule wins, including an earlier allow before a later deny. If no rule matches, `defaultAction` applies. `call_tool` remains permission-neutral: direct, unified, and ToolScript calls authorize only the same resolved concrete builtin, Node, or MCP identity.

## Loading and failure behavior

A process reuses a successfully parsed policy for less than ten seconds. After expiry, async callers perform one fresh read/parse and, on failure, wait 100 ms before one fresh retry; synchronous callers retry immediately without converting their call chain to async. Only exact `ENOENT` means the compatibility empty/default-allow policy. Permission errors, other I/O failures, and parse/validation failures fail closed after the second attempt and are never replaced by an older cache entry.

Policy-unavailable execution still returns ordered paired function responses for every call in the model batch. Already-started parallel direct-exec siblings settle and later calls receive skipped responses. The tool message carries a trusted fatal-current-turn marker; the canonical turn runner appends the paired tool message, then uses its existing terminal error/finalization path without persistent `stopping`, queue deletion, process failure, or impact on another Session. Ordinary rule denial and invalid replacement candidates remain normal nonfatal tool errors. Foreground ToolScript persists the failed run and propagates policy unavailability to the current turn; background mode fails only its run.

## Replacement boundary

`set_tool_rules` accepts exactly one master-side `filePath`; it has no Node selector. The current policy must first allow the setter, then separately allow `node:master/read` for the exact candidate path. Existing isolated path guards still apply. The handler opens a regular file, bounds it to the policy byte limit, captures its bytes once, validates those exact bytes, writes a same-directory mode-0600 temporary file, syncs it, atomically renames it over the fixed authority, and invalidates Main's cache. Any read, validation, temporary-write, sync, or rename failure leaves the active file unchanged.

Each process owns its cache. Main observes a successful setter immediately; other Session workers observe the replacement after their own cache expires, no later than their first authorization after ten seconds. No cross-process generation protocol is introduced.

## Integration

- `isolatedCheck.ts` evaluates generic policy first for every Session, including non-isolated Sessions, then retains exact isolated-Agent and structural checks.
- Unified discovery uses the synchronous evaluator and rethrows policy unavailability instead of degrading it into a warning.
- Node execution and MCP external services repeat concrete target authorization at their Main-owned effect boundary.
- Main Management repeats builtin authorization for its closed operations; `set_tool_rules` additionally performs its candidate-read check inside the authoritative handler.
- `llm.ts`, `sessionTurnRunner.ts`, and `toolscript.ts` implement the narrow fatal-current-turn behavior while preserving function-call/result pairing.

## Tests

Focused tests cover strict schema/bounds, first-match/default behavior, source/server/Node/arg/path matching, direct/unified identity parity, non-isolated denial, ten-second cache, async/sync retry, ENOENT versus malformed failure, trusted fatal pairing, foreground/background ToolScript behavior, current-policy setter authorization, candidate read authorization, exact-byte atomic replacement, invalid-candidate preservation, and isolated compatibility.

## Design decisions

Canonical generic policy semantics are owned by [D-dispatch-generic-tool-authorization](../threads/tool-dispatch.md#d-dispatch-generic-tool-authorization).
