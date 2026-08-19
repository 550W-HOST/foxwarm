# Unit: src-permissions

Files: src/permissions.ts

## Purpose

Defines the persisted exact agent tool-rule shape, validates and canonicalizes stored rules, matches rules against canonical resolved capability identities, and preserves the built-in default isolated allow behavior when no exact rule exists.

## Key exports

- `ToolRuleEffect` — `allow | deny`.
- `ToolCapabilitySource` — canonical capability source: `builtin | node | mcp`.
- `AgentToolRule` — exact persisted rule union. Builtins use source+tool; Node rules add exact node; MCP rules add exact server.
- `ResolvedToolPermissionIdentity` — canonical runtime identity consumed by authorization and visibility.
- `normalizeAgentToolRules(value)` — validates, trims, canonicalizes, and rejects wildcard, extra-field, duplicate, conflicting, or permission-neutral dispatcher/container identities, more than 256 rules, and node/server/tool strings over 128 UTF-8 bytes.
- `isPermissionNeutralBuiltinDispatcher(tool)` — identifies the exact non-capability builtin dispatcher `call_tool` without generalizing the rule to other placement labels.
- `toolRuleIdentity(rule)` — stable exact identity key.
- `findExactAgentToolRule(rules, identity)` — exact source-aware lookup.
- `isDefaultIsolatedCapabilityAllowed(...)` — compatibility fallback for the pre-rule isolated allow behavior.

## Behavior

- Persisted rules contain only `effect`, `source`, exact non-empty `tool`, and the source-required exact `node` or `server`. Builtin rules accept neither target field.
- Wildcards and unsupported fields are rejected. Two entries with the same exact identity are rejected even when their effects agree; conflicting allow/deny duplicates are likewise invalid.
- Runtime matching never considers session ID, agent inheritance, arguments, paths, regexes, or ordering. A caller resolves capability source before matching.
- Exact rule lookup is separate from structural guards. An exact allow cannot make master `exec`, another remote Node, an unadvertised Node capability, an out-of-agent master path, or an invalid cross-session operation structurally valid.
- Missing rules retain the existing isolated defaults: agent-scoped master file/memory operations, safe builtin/session/timer operations, static Node capabilities on the bound/current Node, and custom advertised capabilities delegated to the authenticated Node service boundary. MCP remains unavailable unless an exact MCP allow exists.
- Non-isolated callers do not consult these rules.
- `call_tool` is not a concrete capability identity: persisted builtin rules targeting it are rejected, and only its resolved target participates in authorization.

## Dependencies

- `config` supplies agent and memory roots for compatibility path checks.
- `tools/placement` supplies the canonical static Node-environment capability names so dynamic advertised tools can retain their separate Node-service boundary.

## Integration

- `session/agentMetadata.ts` owns persistence and calls `normalizeAgentToolRules` on load and mutation.
- `isolatedCheck.ts` combines exact rule evaluation with structural and domain-specific checks.
- Unified discovery, Node topology, and MCP discovery use the same resolved identities for visibility filtering.

## Design decisions

Persisted exact agent-level rules are canonical in [D-dispatch-exact-agent-tool-rules](../threads/tool-dispatch.md#d-dispatch-exact-agent-tool-rules).
