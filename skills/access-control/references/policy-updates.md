# Safe policy updates and troubleshooting

`set_config` with `target: tool-rules` installs a **complete** policy candidate. It does not add one rule or merge for you. The current policy must authorize both `builtin:set_config` and `node:master/read` of the candidate; a candidate cannot grant permission to its own installation.

## Read, merge, review, install

1. Confirm authority and the requested callers, concrete capabilities, targets, and allow/deny outcome. Resolve the data directory before locating `state/tool-authorization.yaml`; use [foxwarm-maintenance](../../foxwarm-maintenance/SKILL.md) if necessary.
2. Read the entire current policy on `master`. If it is absent, distinguish that from a read failure: absence means internal default-allow compatibility, not an empty deny policy. Do not proceed from a truncated excerpt, expired copy, or unreadable file.
3. Preserve unrelated rules, IDs, `defaultAction`, and intended ordering. Merge only the requested change. Review earlier broad rules and all external exposure before inserting a new allow. If another operator changed the policy while you prepared the candidate, merge again from the current file rather than replacing their work.
4. Write the full candidate to a new permitted private path on `master`, for example `$fw_tmp/tool-authorization-candidate.yaml`. Native file tools on another selected Node do not write a master candidate; use an explicit master tool descriptor. Do not overwrite the active authority directly.
5. Inspect the complete candidate and validate version-1 syntax when a local parser is available. Verify expected allowed and denied cases, including unrelated callers and external-unmatched behavior. Keep an authorized recovery path when tightening rules; do not assume an in-Session rollback will remain allowed afterward.
6. Discover `set_config` and call it with `target: tool-rules` and the candidate path. Successful installation validates the captured bytes and atomically replaces the fixed authority; invalid candidates or installation failures leave the active file unchanged.
7. Check the installed policy and exercise a small permitted read/status call plus a relevant denied call without running a forbidden mutation. Do not equate discovery visibility with permission for every argument set.

Example descriptors for `call_tool` (substitute the resolved master policy path for the first call):

```json
{
  "source": "node",
  "nodeId": "master",
  "name": "read",
  "args": { "filePath": "<data-directory>/state/tool-authorization.yaml" }
}
```

Discover the setter's current schema before installation:

```json
{
  "query": "set_config",
  "sources": ["builtin"],
  "limit": 1,
  "includeSchema": true
}
```

Use that with `search_tools`, then invoke with `call_tool`:

```json
{
  "toolId": "builtin:set_config",
  "args": { "target": "tool-rules", "filePath": "$fw_tmp/tool-authorization-candidate.yaml" }
}
```

These examples require the existing permissions; they do not authorize changing live policy. `set_config` has no Node selector and always reads the candidate on `master`. Current isolated path restrictions still apply. Writing the candidate requires its own write permission, separate from the setter's candidate-read check.

## Migration from the former setter

Persisted generic policy and legacy Agent rules naming `set_tool_rules` fail validation with an explicit migration error; the old command is not an alias. Review both allow and deny rules before migrating. For the former policy-only capability, select builtin `set_config` and add `args: { target: tool-rules }` to the generic rule. A simple rename without that condition would also match app and models replacement. Legacy Agent exact rules cannot constrain arguments: use the generic policy for target restrictions and review any broader legacy allow deliberately.

## Effect timing

Main invalidates its policy cache immediately after a successful setter. Other processes, including Session workers, retain their own successful-parse cache for less than ten seconds. They observe the new file on their next authorization after that cache expires, not through an immediate cross-process broadcast. When checking a Worker, allow that cache window before a relevant authorization attempt; repeatedly querying status is not a cache-invalidation operation.

Identity edits use `set_config` with `target: config` or WebUI Setup Config and apply supported access changes immediately. Other app settings can require restart, as reported by the save result. Outbound MCP updates through `mcp_config` are different again: they publish live connection configuration without restarting. Do not use one lifecycle as a substitute for another.

## Diagnose a denial

1. Identify the real caller: internal Agent/Session or verified external identity. WebUI bindings do not change internal Session tool authority.
2. Resolve the concrete source/name/server and actual Node from the tool descriptor/call path. Inspect normalized arguments and source-specific path facts, not just the wrapper name.
3. Walk enabled rules from the beginning. Check all conditions in the first matching rule; later entries are irrelevant once it matches.
4. If no rule matches, apply the internal default or external deny fallback.
5. If policy allows the call, examine legacy Agent isolation, Node readiness/capabilities, own-attachment restrictions, and tool-local validation. Generic allow cannot override them.
6. For a recent replacement in a Worker, distinguish its bounded cache window from a policy error.

| Symptom | Checks |
| --- | --- |
| Setter denied | Current setter permission, current master read permission for the exact candidate, and isolated path restrictions |
| Candidate rejected | Strict field names, version, duplicate IDs, bounded sizes, scalar operators, supported path variables, registered Session-target family |
| Tool is visible but call denied | Discovery is conservative; argument/path/target conditions are checked strictly at invocation |
| External call unexpectedly allowed | Earlier identity-neutral/broad allow rules; `defaultAction: allow` alone is not the cause |
| External Session rule never matches | Use `args.sessionId` for the target; do not add a Node target to a Node-less operation |
| Policy unavailable | Read permissions/I/O or malformed active YAML; failures close the current turn rather than falling back to an expired policy |

Do not repeatedly retry a mutation with unknown outcome. Diagnose from safe evidence and report the exact blocked boundary when current authority does not permit repair.
