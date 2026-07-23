# Unit: src-isolated-check

Files: src/isolatedCheck.ts

## Purpose

Enforces the current isolation boundary for tool execution, master-side paths, cross-node copies, archive reads, channel sends, file sends, timers, and operations that are unavailable to isolated sessions.

## Key exports

- `checkToolPermission(toolName, sessionId, executionNode?, toolArgs?)` — evaluate an isolated session's tool call against the current isolated rule set.
- `checkPathAccess(fullPath, agentName)` — restrict master-side filesystem access to the isolated agent's own directory.
- `requireNotIsolated(sessionIdOrCtx, operation)` — reject operations that are unavailable to isolated sessions.
- `checkArchivedReadPermission(...)` — restrict archive inspection to sessions under the same agent.
- `checkChannelPermission(...)` — restrict direct channel sends to attached channel targets.
- `checkSendFilePermission(...)` — restrict file delivery to the current isolated session or its attached channel.
- `checkTimerPermission(...)` — restrict timer targets and new-session creation.

## Function index

| Stable symbol | Responsibility |
|---|---|
| `checkToolPermission` | Resolves effective isolation node context, handles copy/timer special cases, and evaluates `buildIsolatedToolRules` |
| `resolvePermissionPath` | Expands and normalizes a path against the agent directory |
| `isPathWithinAgentDir` | Tests master-side containment |
| `checkCopyBetweenNodesPermission` | Restricts source/target nodes and master paths |
| `checkPathAccess` | Enforces the master agent-directory boundary |
| `requireNotIsolated` | Shared hard guard for unsupported isolated operations |
| `checkArchivedReadPermission` | Same-agent archive-read guard |
| `checkChannelPermission` | Attached-channel guard |
| `checkSendFilePermission` | File target guard |
| `checkTimerPermission` | Timer and new-session guard |

## Dependencies

- `sessionManager` for session state, effective isolation, channel attachment, and agent isolation node lookup.
- `config` for agent directory resolution.
- `permissions` for `buildIsolatedToolRules` and first-match rule evaluation.
- `utils/pathResolve` for home-path expansion.

## Behavior

- Non-isolated sessions return early from isolation-only checks.
- `checkToolPermission` uses the resolved execution node. `copy_between_nodes` and timer tools have additional domain-specific validation before generic rule evaluation.
- An isolated session may use master filesystem paths only inside its own agent directory.
- Cross-node copy is limited to master and the session's bound/current node; any master-side source or target path must remain inside the agent directory.
- Archive reads are read-only and limited to sessions owned by the caller's agent.
- Timer-created sessions must stay within the caller's agent.
- Denials throw descriptive errors at the execution boundary.

## Integration

Tool handlers call these guards before restricted operations. The dispatcher resolves node context; this unit enforces the current source-tree isolation model and does not document unmerged policy layers.

## Design decisions

### D-isolation-master-path

An isolated agent's master-side filesystem boundary is its own agent directory. Remote-node access is governed separately by the bound/current-node tool rules.

Canonical module: [tools and permissions](../modules/tools-and-permissions.md#invariants).
