# Unit: src-isolated-check

Files: src/isolatedCheck.ts
Secondary files: src/isolatedCheck.test.ts

## Purpose

Enforces the current isolation boundary for tool execution, master-side paths, cross-node copies, archive reads, channel sends, file sends, timers, and operations that are unavailable to isolated sessions.

## Key exports

- `checkToolPermission(identity, sessionId, executionNode?, toolArgs?)` — evaluate an isolated session's canonical resolved capability identity.
- `checkToolPermissionForSession(session, identity, executionNode?, toolArgs?, refreshMetadata?)` — evaluate the same identity from an authoritative current Session; Worker calls may refresh exact agent metadata from disk first.
- `isToolVisibleForSession(session, identity, executionNode?)` — apply the same exact-rule/default evaluation to discovery visibility.
- `checkPathAccess(fullPath, agentName)` — restrict master-side filesystem access to the isolated agent's own directory.
- `requireNotIsolated(sessionIdOrCtx, operation)` — reject operations that are unavailable to isolated sessions.
- `requireNotIsolatedForSession(session, operation)` — apply the identical denial to an already-authoritative passed Session without an ID lookup.
- `checkArchivedReadPermission(...)` — restrict archive inspection to sessions under the same agent.
- `checkArchivedReadPermissionForSession(...)` — apply the same archive-read policy to an exact passed current Session or persisted alias without loading the source-session map.
- `checkChannelPermission(...)` — restrict direct channel sends to attached channel targets.
- `checkSendFilePermission(...)` — restrict file delivery to the current isolated session or its attached channel.
- `checkTimerPermission(...)` — restrict timer targets and new-session creation.
- `checkTimerPermissionForSession(session, options)` — passed-Session owner for the timer special case; the ID form loads then delegates.

## Function index

| Stable symbol | Responsibility |
|---|---|
| `checkToolPermission` / `checkToolPermissionForSession` | Resolve source/node/server identity, apply hard structural denials, exact agent rules, copy/timer guards, and the default isolated fallback |
| `isToolVisibleForSession` | Filter builtin, Node, and MCP discovery with the same exact identity evaluation |
| `resolvePermissionPath` | Expands and normalizes a path against the agent directory |
| `isPathWithinAgentDir` | Tests master-side containment |
| `checkCopyBetweenNodesPermission` | Restricts source/target nodes and master paths |
| `checkPathAccess` | Enforces the master agent-directory boundary |
| `requireNotIsolated` | Shared hard guard for unsupported isolated operations |
| `requireNotIsolatedForSession` | Same hard guard for a passed current Session; the ID/context entry loads when needed and delegates |
| `checkArchivedReadPermission` | Same-agent archive-read guard |
| `checkArchivedReadPermissionForSession` | Passed-owner/archive-alias form of the same guard; other targets stay on the ID-based path |
| `checkChannelPermission` | Attached-channel guard |
| `checkSendFilePermission` | File target guard |
| `checkTimerPermission` | Timer and new-session guard |

## Dependencies

- `sessionManager` for ID-based session loading and channel attachment; passed-Session checks read isolation metadata directly from `session/agentMetadata`.
- `config` for agent directory resolution.
- `permissions` for persisted exact-rule lookup and default isolated fallback evaluation.
- `utils/pathResolve` for home-path expansion.

## Behavior

- Non-isolated sessions return early from isolation-only checks.
- `checkToolPermission` consumes the canonical resolved source. Exact denies override defaults; exact allows still pass hard master-exec, unavailable-builtin, copy, timer, path, relation, Node-service, and MCP-service boundaries.
- Rules belong only to `session.agent`; `agent.inherit` is not consulted. Rules are inert when that exact agent is non-isolated.
- Session workers install a normalized Main-provided exact-agent metadata snapshot at startup. Only an isolated installed snapshot refreshes from disk before tool execution/search; missing/read-failed refreshes preserve it and malformed refreshed rules reject the operation. Rule-only updates remain live without per-call reads for non-isolated workers or an isolation I/O bypass; isolation-node changes remain fenced.
- The ID-based tool/timer entry points retain existing missing-session behavior and delegate loaded Sessions to the same passed-Session implementation, keeping errors and allow/deny outcomes identical.
- An isolated session may use master filesystem paths only inside its own agent directory.
- Cross-node copy is limited to master and the session's bound/current node; any master-side source or target path must remain inside the agent directory.
- Archive reads are read-only and limited to sessions owned by the caller's agent.
- Timer-created sessions must stay within the caller's agent.
- Denials throw descriptive errors at the execution boundary.

## Integration

Tool handlers and the canonical resolved executor call these guards before restricted operations. Unified discovery and the typed Node/MCP services reuse `isToolVisibleForSession` so denied metadata is not disclosed.

## Design decisions

### D-isolation-master-path

An isolated agent's master-side filesystem boundary is its own agent directory. Remote-node access is governed separately by the bound/current-node tool rules.

Canonical module: [tools and permissions](../modules/tools-and-permissions.md#invariants).
