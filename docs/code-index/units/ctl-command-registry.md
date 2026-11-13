# Unit: `ctl` command registry and model front end

Files: `dotnet/Foxwarm/Tools/Ctl/CtlCommands.json`, `dotnet/Foxwarm/Tools/Ctl/CtlRegistry.cs`, `dotnet/Foxwarm/Tools/Ctl/CtlLexer.cs`, `dotnet/Foxwarm/Tools/Ctl/CtlParser.cs`, `dotnet/Foxwarm/Tools/Ctl/CtlHelp.cs`, `dotnet/Foxwarm/Tools/SessionToolExecutor.Ctl.cs`, `packages/webui/src/ctlCall.ts`

## Purpose

`ctl` is one CLI-like model tool backed by one declarative command registry. Each command (noun and verb, typed parameters, help) resolves to an existing canonical capability (`builtin:*`, `node:*`, `mcp:*`) and runs through the ordinary resolved-tool path. It replaces the former `search_tools`/`call_tool` pair and the default declarations of rarely used builtins. `ctl` is a front end, not a capability: authorization, ask approvals, Node selectors, activity records and tool-local validation are those of the target.

### D-ctl-command-registry

**Directly requested interface (2026-11-14).** User decisions:

- The tool is named `ctl`. Arguments are `command` (one command line), `values` and `valuesJson` (the same object-or-string fallback as `args`/`argsJson`).
- Long text and JSON are passed as a whole-token `@name` bound to `values.name`; `@@` writes a literal leading `@`.
- `task` keeps its native declaration; the registry has no `task` noun.
- The command table was drafted once from the builtin schemas by a one-off generator; the checked-in registry, not the old schemas, is the source afterwards. There is no runtime derivation.
- `search_tools` and `call_tool` are removed without an alias period. ToolScript's `call_tool` host function is unrelated and stays.
- Later phases reuse the same registry and grammar for user `/commands`, inbound MCP and a ToolScript host function; only authority and presentation differ. Commands carry an ingress list (`model` now) for that purpose.

Coordinator decision: persisted policy rules naming `search_tools` (or the never-valid `call_tool`, or `ctl`) still load, match nothing and are reported once as a load warning; they never make a policy unavailable. Discovery is filtered by target policy instead.

## Registry

`CtlCommands.json` is an embedded resource loaded and validated once by `CtlRegistry`. Each command records its noun/verb path, aliases, summary and help, ingress availability, parameters and target. A parameter has a schema-property name, optional flag spelling, type (`string`, `integer`, `number`, `boolean`, `enum` with `values`, `array` with `items`, `object`, `json`, `null`, or a `|` union), kind (`flag`, `positional` or `rest`), `required`, `variadic` and help. A target is either a fixed capability (`source`, `name`, optional fixed arguments such as `action`) or a local front-end operation (`tool-search`, `tool-call`). Loading rejects duplicate nouns, commands and parameters, invalid types, kinds and ingress, enums without values, arrays without items, more than one rest parameter, a variadic parameter that is not the last positional, and targets that are neither local nor a source and name. Tests check that every fixed target is a registered tool whose schema has each mapped property and whose required properties stay required.

Every registered builtin is reachable through a specific command or through `tool call`. Nouns: `session`, `history`, `agent`, `node`, `memory`, `skill`, `file`, `image`, `artifact`, `channel`, `timer`, `script`, `config`, `secret`, `mcp`, `tool`.

## Grammar

`CtlLexer` tokenizes POSIX-style: single quotes, double quotes with `\"` and `\\`, backslash escapes outside quotes, no expansion. Unquoted `|`, `;`, `&`, `<`, `>`, `$(` and backticks are rejected with an error stating that `ctl` is not a shell and pointing to `run_script`. An optional leading `ctl` word is ignored.

`CtlParser` binds tokens to the command's parameters: kebab-case flags with the camelCase spelling also accepted, `--flag value` and `--flag=value`, `--flag`/`--no-flag`/`--flag=true|false` for booleans, repeated flags or one JSON token for arrays, `@name` or one JSON token for objects, registry positionals, `--` to end flags, and one optional trailing rest parameter taking the remaining raw text. `@name` matches `[A-Za-z_][A-Za-z0-9_-]*` as a whole token; a missing name and unused `values` keys are errors, and `values`/`valuesJson` are mutually exclusive. Literal tokens are converted to the parameter type; bound values are type-checked, never coerced. Errors are `CtlUsageException`s carrying the command's usage; unknown nouns and verbs list the closest visible candidates.

`help`, `<noun>`, `<noun> --help` and `<noun> <verb> --help` return help from `CtlHelp`, bounded to 16,000 characters and filtered by a visibility predicate.

## Resolution and dispatch

`ToolRegistry.Unwrap` turns a `ctl` call (and ToolScript `call_tool("ctl", …)`) into the target invocation, and `Resolve` records `InvocationName = "ctl"` on the resolved target. `tool call` takes a tool ID or `--source`/`--name`/`--server`/`--node-id` and `--args @args`, and resolves exactly as the former `call_tool` did, including Node placement selectors and `argsJson`-style input. `tool call builtin:ctl` is rejected as not concrete. Help, `tool search` and parse errors resolve to the `ctl` front end itself, which `SessionToolExecutor` handles without generic authorization: help filters each command by `SessionManager.ToolVisible` for its target, and `tool search` runs `UnifiedTools.SearchAsync` with the existing visibility, MCP server prefilter, budgets and structured descriptors for programmatic callers. A model parse error is an ordinary tool error of type `invalid_command`; a programmatic one throws to the script.

`CtlParser.Describe` and `DescribeCall` map stored `ctl` arguments to the target descriptor without executing them. Consumers use it wherever the former `call_tool` wrapper was unwrapped: activity targets, sequence projection, compaction skill-load recognition and pruning exemptions, archive tool effects, Node-selection batch prerequisites, compaction submission detection and approval presentation.

`call_tool` is no longer a model tool; a model call to it is `Unknown tool`. The ToolScript `call_tool` host function remains.

## Default declarations

`SessionToolExecutor.DefaultBuiltins` lists the natively declared builtins: `read`, `write`, `edit`, `exec`, `run_script`, `continue_script`, `wait`, `ask_user`, `send_to_session`, `create_child_session`, `task`, `submit_compact_plan` and `ctl`, plus the conditional `generate_image` and provider-native tools. `node`, `recall`, `copy_between_nodes`, `cancel_transfer`, `send_file`, `image_write_to_file`, the memory tools, `image_crop`, `list_agents`, `skill`, `session`, `view_session` and `send_to_channel` remain registered concrete identities reached through `ctl`. The `ctl` declaration is fixed and Node-independent ([D-tools-node-independent-default-declarations](./tools-registry.md#d-tools-node-independent-default-declarations)).

## WebUI

`ctlCall.ts` imports the same registry JSON and resolves stored `ctl` calls for display only: timeline labels, previews, communication and question cards, artifacts, reply files and approval labels show the target tool, with the original command as secondary context.

## Tests

`dotnet/Foxwarm.Tests/Tools/CtlCommandTests.cs` covers tokenization, shell-operator rejection, `@name` binding errors, flag/positional/rest/array forms, type checks, help forms and unknown-command suggestions, registry coverage of every builtin, the default declaration list, resolution parity and target records with direct calls, help and discovery filtering under policy, policy warnings for `search_tools` rules, and ToolScript use. `Sessions/CtlNodeSelectionBatchTests.cs` covers the Node-selection batch prerequisite through `ctl node select` and `tool call builtin:node`. `CompactContextTests` includes a `ctl skill load` in the compacted-skill hint. `packages/webui/test/ctlCall.test.mjs` covers display resolution.
