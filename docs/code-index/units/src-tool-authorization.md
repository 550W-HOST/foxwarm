# Unit: src-tool-authorization

Files: src/toolAuthorization.ts, src/toolAuthorization.test.ts, src/tools/toolAuthorizationTools.ts
Secondary files: src/isolatedCheck.ts, src/tools/resolvedTools.ts, src/tools/unifiedSearch.ts, src/nodeExecutionService.ts, src/mcpExternalService.ts, src/mainManagementToolService.ts, src/fileDeliveryService.ts, src/llm.ts, src/sessionTurnRunner.ts, src/toolscript.ts

## Purpose

Owns the instance-level ordered tool authorization policy, strict YAML parser, bounded per-process loader cache, canonical request/path facts, first-match evaluation, and the master-only atomic replacement tool. Generic rules apply independently of Agent isolation; current exact isolated-Agent rules and structural isolation guards remain a later compatibility layer.

## Key exports

- `TOOL_AUTH_CONFIG_PATH` — fixed `state/tool-authorization.yaml` authority.
- `parseToolAuthorizationPolicyBytes()` — strict shared parser/validator for runtime loads and replacement candidates.
- `loadToolAuthorizationPolicy()` / `loadToolAuthorizationPolicySync()` — async/sync execution-time loaders with a ten-second successful-parse cache and one fresh retry.
- `buildToolAuthorizationRequest()` — derives Agent, Session, canonical source/name/server, resolved target Node, args, and source-specific master-resolvable path facts. Master paths canonicalize existing symlinks and the nearest existing ancestor for prospective creation paths.
- `toolAuthorizationSessionTargets.ts` — resolves registered builtin `sessionId` targets with each handler's canonical default/alias semantics and returns only target ID, Agent, and direct-parent facts.
- `evaluateToolAuthorization()` / `evaluateToolAuthorizationSync()` — ordered first-match evaluation plus explicit default action.
- `isToolAuthorizationPotentiallyVisibleSync()` — bounded order-preserving discovery projection: definite identity-only decisions stop, conditional allow keeps a capability visible, and conditional deny alone does not claim universal denial.
- `ToolAuthorizationPolicyUnavailableError` / `isToolAuthorizationPolicyUnavailable()` — trusted RPC-preserved fatal-current-turn classification used only after both policy load attempts fail.
- `installToolAuthorizationPolicyBytes()` — validates and atomically replaces the fixed policy with the exact captured bytes, then invalidates the installing process cache.
- `tool_set_tool_rules({ filePath })` — Main-owned master-only candidate installation after the current policy authorizes both the setter and `node:master/read` of the candidate path.

## Policy contract

The policy is a strict version-1 YAML object with `defaultAction: allow | deny` and at most 256 ordered rules. Every rule has a unique bounded `id`, optional `enabled`, strict `match`, `action`, and optional bounded `reason`. Unknown fields, unsupported versions/operators/path variables, unsafe dotted argument paths, duplicate IDs, excessive sizes, and malformed YAML are rejected.

The confirmed matcher vocabulary is `agent`, `session`, `tool`, `targetNode`, `args`, and `path`. Scalar matching accepts an exact scalar, bounded exact list, or strict `{ equals?, oneOf?, exists? }`. A registered builtin `args.sessionId` may instead use `{ session: { self?: true, sameAgent?: true, relation?: parent | child | [parent, child] } }`. Present fields are conjunctive, the relation list is same-field OR, and separate ordered rules express alternative conditions. Self compares canonical IDs; same-Agent compares authoritative Agent fields; parent/child are direct canonical links only and may cross Agents. Tool selectors may match exact `source`, MCP `server`, and `name`; string/list shorthand matches only the exact tool name. Path containment supports selected path arguments plus `${agent.dir}`, `${agent.memoryDir}`, and `${workspace}`. Path facts are derived only for the actual source-specific file capabilities, so an unrelated MCP tool named `read` does not inherit master-file semantics. Master path candidates and policy bases use realpath/nearest-existing-ancestor canonicalization; remote Node path namespaces stay opaque and cannot satisfy `allWithin` host rules. This closes static symlink-prefix escapes, including not-yet-existing children, but does not claim protection from a concurrent symlink replacement between authorization and filesystem effect.

Session-target matchers are strictly registered for compatible exact builtin families: messaging/file delivery, timer CRUD, recall/archive reads, and required session-message reads. Resolution reuses tool-specific missing-argument and alias behavior; absent `sessionId` is not universally self, channel-target `send_file` has no Session target, and missing/malformed/nonexistent targets never match. Main uses its authoritative catalog directly. Session Workers use a narrow source-fenced Main Management v10 read returning only bounded relation facts before tool-start publication; Main effect services repeat authorization against fresh catalog facts. Synchronous discovery treats the matcher as conditional/potential visibility without topology reads.

`copy_between_nodes` master legs reuse the canonical transfer resolver, whose relative paths are Agent-directory-relative rather than Session-cwd-relative. Patch path facts reuse the canonical parser and cover every currently supported Add, Update, and Delete operation; the patch grammar has no move/rename operation.

The first enabled matching rule wins, including an earlier allow before a later deny. If no rule matches, `defaultAction` applies. `call_tool` remains permission-neutral: direct, unified, and ToolScript calls authorize only the same resolved concrete builtin, Node, or MCP identity.

## Loading and failure behavior

A process reuses a successfully parsed policy for less than ten seconds. After expiry, async callers perform one fresh read/parse and, on failure, wait 100 ms before one fresh retry; synchronous callers retry immediately without converting their call chain to async. Only exact `ENOENT` means the compatibility empty/default-allow policy. Permission errors, other I/O failures, and parse/validation failures fail closed after the second attempt and are never replaced by an older cache entry.

Policy-unavailable execution still returns ordered paired function responses for every call in the model batch. Already-started parallel direct-exec siblings settle and later calls receive skipped responses. The tool message carries a trusted fatal-current-turn marker; the canonical turn runner appends the paired tool message, then uses its existing terminal error/finalization path without persistent `stopping`, queue deletion, process failure, or impact on another Session. Ordinary rule denial and invalid replacement candidates remain normal nonfatal tool errors. Foreground ToolScript persists the failed run and propagates policy unavailability to the current turn; background mode fails only its run.

## Replacement boundary

`set_tool_rules` accepts exactly one master-side `filePath`; it has no Node selector. The current policy must first allow the setter, then separately allow `node:master/read` for the exact candidate path. Existing isolated path guards still apply. The handler opens a regular file, bounds it to the policy byte limit, captures its bytes once, validates those exact bytes, writes a same-directory mode-0600 temporary file, syncs it, atomically renames it over the fixed authority, and invalidates Main's cache. Any read, validation, temporary-write, sync, or rename failure leaves the active file unchanged.

Each process owns its cache. Main observes a successful setter immediately; other Session workers observe the replacement after their own cache expires, no later than their first authorization after ten seconds. No cross-process generation protocol is introduced.

## Integration

- `isolatedCheck.ts` evaluates generic policy first for every Session, including non-isolated Sessions, then retains exact isolated-Agent and structural checks.
- Unified discovery uses the synchronous possible-match projection and rethrows policy unavailability instead of degrading it into a warning. It preserves ordered unconditional decisions without pretending to solve arbitrary argument/path conditions.
- Node execution and MCP external services repeat concrete target authorization at their Main-owned effect boundary.
- Main Management repeats builtin authorization for its closed operations; `set_tool_rules` additionally performs its candidate-read check inside the authoritative handler.
- Main-owned file delivery repeats `send_file` authorization with canonical Session/channel target semantics before reading or delivering the file.
- `llm.ts`, `sessionTurnRunner.ts`, and `toolscript.ts` implement the narrow fatal-current-turn behavior while preserving function-call/result pairing.

## Tests

Focused tests cover strict schema/bounds/registration, first-match/default behavior, ordered conditional discovery, scalar and Session relationship argument matching, self/same-Agent/direct cross-Agent parent-child semantics, canonical aliases/defaults/invalid targets, Worker direct/unified/ToolScript parity, source/server/Node/arg/path matching, direct/unified identity parity, source-specific path facts, static symlink escape and prospective-child canonicalization, canonical policy bases, copy-leg resolution, all supported patch operation paths, non-isolated denial, ten-second cache, async/sync retry, ENOENT versus malformed failure, trusted fatal pairing, foreground/background ToolScript behavior, current-policy setter authorization, symlinked candidate read authorization, exact-byte atomic replacement, invalid-candidate preservation, and isolated compatibility.

## Design decisions

Canonical generic policy semantics are owned by [D-dispatch-generic-tool-authorization](../threads/tool-dispatch.md#d-dispatch-generic-tool-authorization).
