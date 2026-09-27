# Unit: src-commands

Files: src/commands.ts (facade), src/commands/types.ts, src/commands/autocomplete.ts, src/commands/helpers.ts, src/commands/sessionCmd.ts, src/commands/sessionCmd.test.ts, src/commands/modelEffortCommand.test.ts, src/commands/continueCommand.test.ts, src/commands/agentCmd.ts, src/commands/timerCmd.ts, src/commands/channelCmd.ts, src/commandHandler.ts
Secondary files: src/session/sessionIdAllocation.test.ts

## Purpose

Defines all slash commands available in the bot (e.g. `/session`, `/fork`, `/agent`, `/timer`, `/channel`, `/model`, `/tools`, `/compact`, `/btw`, `/node`) and provides a `CommandHandler` class that dispatches incoming commands after authorization and session resolution. The `/node` command is the operator-facing surface for node pairing approval, approved-node removal/rename, pairing help, node listing, and session node switching.

## Key Exports

- `COMMANDS` — Record of `CommandDef` objects keyed by command name (the full command registry)
- `CommandDef` — Type describing a command's metadata, handler, and autocomplete tree
- `CommandAutocompleteNode` / `CommandAutocomplete` — Types for IDE/client autocomplete hints
- `CommandHandler` — Class that checks authorization, resolves sessions, and dispatches to the appropriate command handler

## Function Index

### commands/types.ts — Types and autocomplete helpers
| Function | Description |
|----------|-------------|
| `literalNode(value, description, extras)` | Helper to build a literal autocomplete node |
| `placeholderNode(value, description, extras)` | Helper to build a placeholder autocomplete node |

### commands/autocomplete.ts — Autocomplete tree constants
All `*_AUTOCOMPLETE` constants: TIMER, BTW, SESSION, AGENT, SKILL, NODE, MESSAGES, MODEL, DELETE_MESSAGES, VERBOSE, CHANNEL, SEARCH.

### commands/helpers.ts — Shared utility functions
| Function | Description |
|----------|-------------|
| `formatTimerDate(timestamp)` | Formats a timer timestamp as ISO string or 'n/a' |
| `parseTimerFlags(tokens)` | Parses --new-session/--prefix/--agent flags from token array |
| `parseTimerMessage(tokens)` | Extracts message text after `--` separator |
| `parseSessionMoveTarget(rawTarget)` | Parses `<id>` or `<agent>/<id>` move target |
| `parseCompactThresholdInput(raw)` | Parses compact threshold value (supports `Nk` suffix) |
| `parseEffortFlag(tokens)` | Removes and validates one canonical `--effort` flag while preserving whether unset/default was explicitly requested |
| `getDisplayModelKeys(currentModel)` | Returns model keys for display |
| `resolveCommandModelSelection(input, currentModel)` | Resolves partial model name to full key |
| `formatChannelInfo(ctx)` | Formats current channel identifiers and state |
| `formatChannelRuntimeStatus(channelId, typeFilter)` | Formats runtime status of managed channels |
| `getManagedPlatformHelp()` | Returns comma-separated managed channel IDs |
| `buildNodePairHelp(token)` | Builds node pairing/bootstrap help text |
| `buildNodeListReply(currentNode, boundNode)` | Builds the operator-facing master/approved-remote Node list, pending approvals, and `/node` command help, including remove/move |
| `handleCompactCommand(ctx, args, sessionId, session)` | Handles /compact command logic |

### commands/sessionCmd.ts — /session handler
| Function | Description |
|----------|-------------|
| `formatSessionListChannels(channelKeys)` | Formats the optional `/session list` channel line after excluding attachment keys whose exact prefix is `webui:`. |
| `parseSessionCreateFlags(tokens)` | Strictly parses one optional model, one optional canonical effort, and repeatable system-prompt-file flags without consuming another flag as a value. |
| `handleSessionCommand(ctx, args, sessionId, session)` | Dispatches /session subcommands (list, new, create, fork, delete, clear, rename, move, parent, archive, etc.) |

### commands/agentCmd.ts — /agent handler
| Function | Description |
|----------|-------------|
| `handleAgentCommand(ctx, args)` | Dispatches /agent subcommands (list, create, isolated, inherit, delete); list output includes each exact agent's persisted tool-rule count |

### commands/timerCmd.ts — /timer handler
| Function | Description |
|----------|-------------|
| `handleTimerCommand(ctx, args, sessionId, session)` | Dispatches /timer subcommands (list, delete, after, at, cron) |

### commands/channelCmd.ts — /channel handler
| Function | Description |
|----------|-------------|
| `handleChannelCommand(ctx, args)` | Dispatches /channel subcommands (info, auth, status, start, stop, restart, mode, dangerously-allow-all-users) |

### src/commands.ts (facade) — COMMANDS object + inline handlers
Inline handlers: /help, /status, /btw, /fork, /stop, /dequeue, /continue, /node, /search, /messages, /model, /delete-messages, /verbose, /weixin, /attach, /skill. bare `/stop` stops only the active main run and reports that queued inputs will be committed to history without execution; `/stop compact` has dedicated autocomplete and cancels only compaction with cancelled, no-active, and completed/too-late results; other `/stop <arg>` values are rejected; `/dequeue` explicitly runs queued items, stopping the current run first if needed. `/continue` invokes the internal SessionRuntime retry control without a queue item or model-facing marker; the exact Session owner revalidates interrupted history before running. There is no `/retry` alias. `/compact` starts async-capable planning immediately; a busy model with `asyncCompact:false` receives a clear unavailable response. `/node remove <node-id>` removes an approved node and closes online runtime state; `/node move <old-id> <new-id>` renames an approved node id, closes the old runtime connection, and tells the operator to update node-side credentials/restart.

### src/commandHandler.ts — Command dispatch
| Function | Description |
|----------|-------------|
| `CommandHandler.isAuthorized(ctx)` | Delegates auth check to the message router |
| `CommandHandler.handleCommand(ctx, command, args, rawArgs?)` | Resolves session if needed and dispatches tokenized args plus optional unmodified raw arguments to the command def handler |

## Dependencies

- `./channel` — `ChannelContext`, `getChannelId`, `getChannelType`, `getConversationId`
- `./channelAuth` — `inspectChannelAuthorizationFromContext`, `formatAuthorizationInspection`
- `./channelRuntime` — `getManagedChannelIds`, `getChannelRuntimeStatus`, `listChannelRuntimeStatuses`, `restartManagedChannel`, `startManagedChannel`, `stopManagedChannel`
- `./sessionRuntime` — placement-neutral status/history, stop/dequeue/retry, settings, history delete/clear/index, snapshot, and fork-notification operations
- `./sessionManager` — live Session CRUD, channel-session binding, lifecycle, and channel config
- `./config` — App config paths, model resolution, defaults, read/write config
- `./sessionStatus` — Shared `/status` and `session({ action: "status" })` status builder/formatter
- `./skills` / `./tools` — Skill and tool listing/toggling
- `./timers` — Timer CRUD (create, list, delete)
- `./tokenCount` — `estimateSessionSummary` (used by `sessionStatus` for status token/image estimates)
- `./nodes/providerRegistry` / `./nodes/manager` / `./nodes/registry` — generic Node selection plus authenticated remote runtime, pairing approval, and approved-node remove/move operations
- `./btw` — Side-question execution
- `./weixin/api` — WeChat QR login flow
- `./messageRouter` — `MessageRouter` (used by `CommandHandler` for auth)
- `./isolatedCheck` — `checkTimerPermission`
- `./utils/messagePreview` — `formatSessionMessagesPreview`

## Behavior

- Each command handler validates arguments, performs the action (often via SessionRuntime, `sessionManager`, or other managers), and replies to the user via `ctx.reply`. `CommandHandler` resolves the current session through a catalog/projection DTO rather than hydrating Worker authority. `/stop`, `/dequeue`, `/continue`, and `/btw` use SessionRuntime; `/continue` retains the internal `retry` operation name while both local and Worker exact owners enforce current-history availability. `/session delete` uses the shared Main-owned deletion orchestrator, defaults nonrecursive, detaches surviving direct children, and rejects canonical source/alias self-delete before target preparation. `/messages`, `/delete-messages`, `/session clear`, `/index`, model/node/verbose/compact-threshold settings, snapshot refresh, and manual-fork notification use typed placement-neutral operations. Timer commands use SessionRuntime projections for current owner defaults and never save Worker authority in Main. Session identity move/rename and agent-wide inherit/isolation/delete admin remain unavailable while Worker placement is enabled until their exact ownership/lifecycle paths are closed. `/btw` preserves its immediate acknowledgement while the selected owner posts one later display-only result; its Worker behavior is canonical in [D-process-topology-btw-side-request](../threads/process-topology-and-rpc.md#d-process-topology-btw-side-request). `/continue` sends an immediate channel acknowledgement, adds no model-visible prompt, and describes a lost Worker response as an unknown outcome that requires history inspection rather than a definite failure or automatic repeat.
- Session-requiring commands automatically resolve the active session from the channel/conversation binding; if none exists, they short-circuit with an error message.
- Timer commands enforce permission checks for isolated agents before creating timers.
- `/config` can modify persistent app config (model settings, WeChat credentials) and triggers channel restarts when relevant config changes.
- `/model` inspects or atomically updates the current model/effort pair; `/session child-model` does the same for future-child defaults. `--effort default|unset` clears only the relevant raw effort while `none` remains explicit. `/session create` uses one complete serial parse for optional single `--model`, optional single canonical `--effort`, and repeatable `--system-prompt-file`; unknown/positional extras, duplicate single flags, missing values, and flag tokens used as values fail before model resolution or creation. Canonical effort semantics: [D-model-routing-effort](../threads/model-routing.md#d-model-routing-effort).
- `/session new`, `/session create`, `/session fork`, `/fork`, and `/attach` await durable channel attachment after creating/resolving the target; they do not report success after an attachment write failure. Canonical semantics: [D-lifecycle-archived-id-reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).
- `/session move <target> [--parent <parent-session-id>]` preserves the incoming parent when the flag is omitted and intentionally reparents after the identity move when supplied. `/session unparent` remains the explicit detach surface. Canonical semantics: [D-lifecycle-identity-move-relations](../threads/session-lifecycle.md#d-lifecycle-identity-move-relations).
- `/channel` subcommands can start/stop/restart managed channel processes and toggle security settings like `dangerouslyAllowAllUsers`.
- `/status` delegates to `src/sessionStatus`, sharing status fields/formatting with `session({ action: "status" })`: session/agent identity, agent dir, parent id, model plus raw/effective current and child effort, message count, token/image estimate, last usage (including optional provider-reported reasoning tokens within output), last message time, auto-compact threshold, current node, current cwd/default cwd, busy/queue state, and recent child sessions.
- `/search` delegates to `recall({ vector_query })` rather than the removed `search_vector` tool, so command output uses the same archive back-resolution and preview renderer as agent recall.
- `/skill list` shows visible skills and entry-document counts; `/skill show <skill>` loads the skill entry document and lists resource paths without eagerly reading those resources.
- `/node remove <node-id>` refuses reserved ids such as `master`, removes only approved-node credentials (not pending pair approval/rejection flow), and closes/unregisters the online runtime node if present.
- `/node move <old-id> <new-id>` validates the new id through the registry's sanitized/reserved rules, rejects approved-node and online-runtime conflicts, preserves the server-side auth hash and metadata, closes the old runtime connection if present, and warns that node-side `node_credentials.json` still contains the old id and must be edited/re-paired/restarted.
- Bare `/node` presents one `Nodes` section with concise local `master` status first, followed by authenticated approved remote Nodes. Remote rows retain online/offline/upgrade-required state, Node type, distinct requested name, and remote `lastSeen`; `✅` appears only as part of `✅ online`, never as a current-Node marker. The current Node and any isolation binding remain separate lines above the list, while pending approvals and command actions remain below it. This command presentation does not query or display generic provider topology. `/node <node-id>` still validates selection through the same Main-owned provider facade used by model tools and Session workers.
- `/fork [suffix] [message]` creates a forked child, keeps the original channel attached to the parent, optionally sends the complete raw multiline initial message to the child, then records the canonical parent event defined by [D-lifecycle-manual-fork-event](../threads/session-lifecycle.md#d-lifecycle-manual-fork-event).
- `/session list` reads raw attachment keys from `sessionManager.getAllAttachments()` for display only, filters keys starting with the exact `webui:` prefix, and leaves all attachment persistence/routing plus non-WebUI channel output unchanged. Sessions with no remaining visible channel attachments omit the channel line.

## Integration

- `CommandHandler` is instantiated by the `MessageRouter` and called when an incoming message starts with `/`.
- Commands mutate state managed by `sessionManager`, `timers`, `nodesManager`, and `channelRuntime`, which are shared across the rest of the application.
- Autocomplete trees are consumed by client-side UIs (e.g. the web channel) to offer command suggestions.
- The `/compact` command triggers the same compaction logic used automatically when context limits are reached.

## Design Decisions

- [2026-07-02] `/status` and the model-facing `session({ action: "status" })` tool share `src/sessionStatus` as their common status information source/formatter so command and tool output stay field-equivalent.
- [2026-07-10] `/session list` should hide `webui:` attachment entries from its user-facing channel line while preserving Telegram, WeWork, Discord, and other channel entries. This is display-only filtering and must not mutate channel attachment state or affect WebUI routing.

- [2026-08-11] `/session create` owns one strict serial flag grammar after `<agent> <session>`: one optional `--model`, one optional canonical `--effort`, and repeatable `--system-prompt-file`. Reject malformed or extra tokens before any resolution or creation side effect rather than combining independent scans.

- [2026-09-05] Bare `/node` is an operator-oriented authenticated Node summary, not a second view of generic provider discovery. Show `master` first in one `Nodes` section, then approved remote Nodes; reserve `✅` for online status and keep generic provider topology on the model-facing `node({ action: "list" })` surface.

- [2026-07-12] The user-facing fork command syntax is `/fork [suffix] [message]`: suffix is an optional ASCII-safe child-session suffix, and message is all remaining raw text after the suffix delimiter, including internal spaces and newlines. Omitted suffix uses the existing generated-session suffix behavior; there is no ambiguous legacy `/fork [message]` interpretation.
