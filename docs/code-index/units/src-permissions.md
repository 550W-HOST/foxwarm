# Unit: src-permissions

Files: src/permissions.ts

## Purpose

Defines a rule-based permissions system that evaluates whether an agent's tool invocation should be accepted or rejected. It matches permission requests against ordered rule lists using scalar fields and argument matchers (including path-containment checks), and provides a builder for generating isolated sandbox permission rule sets.

## Key Exports

- `PermissionAction` — type: `'accept' | 'reject'`
- `PermissionArgMatcher` — type for matching tool argument values (scalar, equals, oneOf, path constraints)
- `PermissionRule` — interface defining a single permission rule
- `PermissionRequest` — interface describing an incoming tool invocation to evaluate
- `findMatchingPermissionRule(rules, request)` — finds the first matching rule for a request
- `evaluatePermission(rules, request, defaultAction)` — returns the action (accept/reject) for a request
- `buildIsolatedToolRules(agentName, sessionId, boundNode, extraRuntimeNodes)` — generates a complete rule set for an isolated agent session

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `matchesScalar(expected, actual)` | ~35 | Checks if a rule field matches a request field (supports wildcard) |
| `resolveRequestedPath(value, agentName, mode)` | ~39–51 | Resolves a string value to an absolute normalized path relative to agent/memory dir |
| `isWithinAgentDir(resolvedPath, agentName)` | ~53–56 | Checks if a resolved path is within the agent's directory |
| `matchesArgMatcher(matcher, actual, agentName)` | ~58–83 | Evaluates a single argument matcher against an actual value |
| `buildScopedPathToolRule(agentName, sessionId, toolName, targetNode, argName, matcher)` | ~85–95 | Constructs a permission rule scoped to a path-based argument |
| `buildNodeToolRule(agentName, sessionId, toolName, targetNode)` | ~97–105 | Constructs a permission rule for a tool on a specific node (no arg constraints) |
| `matchesToolArgs(rule, request)` | ~107–117 | Checks all tool_args matchers in a rule against request args |
| `findMatchingPermissionRule(rules, request)` | ~119–126 | Finds first rule matching all fields of a request |
| `evaluatePermission(rules, request, defaultAction)` | ~128–135 | Evaluates permission, returning action and matched rule |
| `buildIsolatedToolRules(agentName, sessionId, boundNode, extraRuntimeNodes)` | ~137–220 | Builds full isolated permission rule set for an agent session |

## Dependencies

- `./config` — `getAgentDir`, `getAgentMemoryDir` (resolve agent filesystem directories)

## Behavior

- Rules are evaluated in order; the first matching rule wins (first-match semantics).
- Scalar fields (`agent`, `session`, `target_node`, `tool_name`) match via exact equality, wildcard `*`, or undefined (any).
- Argument matchers support exact scalar comparison, `equals`, `oneOf` set membership, `pathWithinAgent` (resolved path must be inside agent dir), and `pathWithinAgentMemory` (resolved path must be inside agent memory dir).
- `buildIsolatedToolRules` produces a comprehensive allow-list for an isolated agent: scoped file operations on `master`, unrestricted tool access on bound/runtime nodes, memory operations, skill catalog/loading for the current agent, cross-node copy restricted to allowed nodes, and a final catch-all reject rule.
- Isolated session status access is allowed through `session` on `master` only when `action` is omitted/empty or exactly `"status"`; `session({ action: "list" })` remains rejected by the isolated allow-list and by the tool implementation guard.
- Default action in `evaluatePermission` is `'reject'` if no rule matches.

## Integration

- Consumed by the agent execution layer to gate tool calls before dispatch.
- Relies on `config` module for agent directory resolution, tying permissions to the filesystem layout.
- The `buildIsolatedToolRules` output is designed to be passed into `evaluatePermission` at runtime, enforcing sandboxing for agent sessions across master and runtime nodes.