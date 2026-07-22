# Unit: src-commands

Files: src/commands.ts (facade), src/commands/types.ts, src/commands/autocomplete.ts, src/commands/helpers.ts, src/commands/sessionCmd.ts, src/commands/sessionCmd.test.ts, src/commands/agentCmd.ts, src/commands/timerCmd.ts, src/commands/channelCmd.ts, src/commandHandler.ts

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
| `getDisplayModelKeys(currentModel)` | Returns model keys for display |
| `resolveCommandModelSelection(input, currentModel)` | Resolves partial model name to full key |
| `formatChannelInfo(ctx)` | Formats current channel identifiers and state |
| `formatChannelRuntimeStatus(channelId, typeFilter)` | Formats runtime status of managed channels |
| `getManagedPlatformHelp()` | Returns comma-separated managed channel IDs |
| `buildNodePairHelp(token)` | Builds node pairing/bootstrap help text |
| `buildNodeListReply(currentNode, boundNode)` | Builds node list with approved/pending sections and `/node` command help, including remove/move |
| `handleCompactCommand(ctx, args, sessionId, session)` | Handles /compact command logic |

### commands/sessionCmd.ts — /session handler
| Function | Description |
|----------|-------------|
| `formatSessionListChannels(channelKeys)` | Formats the optional `/session list` channel line after excluding attachment keys whose exact prefix is `webui:`. |
| `handleSessionCommand(ctx, args, sessionId, session)` | Dispatches /session subcommands (list, new, create, fork, delete, clear, rename, move, parent, archive, etc.) |

### commands/agentCmd.ts — /agent handler
| Function | Description |
|----------|-------------|
| `handleAgentCommand(ctx, args)` | Dispatches /agent subcommands (list, create, isolated, inherit, delete) |

### commands/timerCmd.ts — /timer handler
| Function | Description |
|----------|-------------|
| `handleTimerCommand(ctx, args, sessionId, session)` | Dispatches /timer subcommands (list, delete, after, at, cron) |

### commands/channelCmd.ts — /channel handler
| Function | Description |
|----------|-------------|
| `handleChannelCommand(ctx, args)` | Dispatches /channel subcommands (info, auth, status, start, stop, restart, mode, dangerously-allow-all-users) |

### src/commands.ts (facade) — COMMANDS object + inline handlers
Inline handlers: /help, /status, /btw, /fork, /stop, /dequeue, /retry, /node, /search, /messages, /model, /delete-messages, /verbose, /weixin, /attach, /skill. `/stop` stops the active run without draining queued items; `/dequeue` explicitly runs queued items, stopping the current run first if needed. `/retry` delegates to `sessionManager.retrySession()` and triggers an internal retry queue control instead of appending a user/system retry message. `/node remove <node-id>` removes an approved node and closes online runtime state; `/node move <old-id> <new-id>` renames an approved node id, closes the old runtime connection, and tells the operator to update node-side credentials/restart.

### src/commandHandler.ts — Command dispatch
| Function | Description |
|----------|-------------|
| `CommandHandler.isAuthorized(ctx)` | Delegates auth check to the message router |
| `CommandHandler.handleCommand(ctx, command, args, rawArgs?)` | Resolves session if needed and dispatches tokenized args plus optional unmodified raw arguments to the command def handler |

## Dependencies

- `./channel` — `ChannelContext`, `getChannelId`, `getChannelType`, `getConversationId`
- `./channelAuth` — `inspectChannelAuthorizationFromContext`, `formatAuthorizationInspection`
- `./channelRuntime` — `getManagedChannelIds`, `getChannelRuntimeStatus`, `listChannelRuntimeStatuses`, `restartManagedChannel`, `startManagedChannel`, `stopManagedChannel`
- `./sessionManager` — Session CRUD, channel-session binding, channel config
- `./config` — App config paths, model resolution, defaults, read/write config
- `./sessionStatus` — Shared `/status` and `session({ action: "status" })` status builder/formatter
- `./skills` / `./tools` — Skill and tool listing/toggling
- `./timers` — Timer CRUD (create, list, delete)
- `./tokenCount` — `estimateSessionSummary` (used by `sessionStatus` for status token/image estimates)
- `./nodes/manager` / `./nodes/registry` — Node management, pairing approval, and approved-node remove/move operations
- `./btw` — Side-question execution
- `./weixin/api` — WeChat QR login flow
- `./messageRouter` — `MessageRouter` (used by `CommandHandler` for auth)
- `./isolatedCheck` — `checkTimerPermission`
- `./utils/messagePreview` — `formatSessionMessagesPreview`

## Behavior

- Each command handler validates arguments, performs the action (often via `sessionManager` or other managers), and replies to the user via `ctx.reply`. `/retry` only sends an immediate channel acknowledgement; it does not create a model-visible retry prompt. `/dequeue` replies with the queued-item count and whether an active LLM request was aborted or a running tool must finish first.
- Session-requiring commands automatically resolve the active session from the channel/conversation binding; if none exists, they short-circuit with an error message.
- Timer commands enforce permission checks for isolated agents before creating timers.
- `/config` can modify persistent app config (model settings, WeChat credentials) and triggers channel restarts when relevant config changes.
- `/session create` supports `--model` and `--system-prompt-file` flags for customizing new sessions.
- `/channel` subcommands can start/stop/restart managed channel processes and toggle security settings like `dangerouslyAllowAllUsers`.
- `/status` delegates to `src/sessionStatus`, sharing status fields/formatting with `session({ action: "status" })`: session/agent identity, agent dir, parent id, model, message count, token/image estimate, last usage, last message time, auto-compact threshold, current node, current cwd/default cwd, busy/queue state, and recent child sessions.
- `/search` delegates to `recall({ vector_query })` rather than the removed `search_vector` tool, so command output uses the same archive back-resolution and preview renderer as agent recall.
- `/skill list` shows visible skills and entry-document counts; `/skill show <skill>` loads the skill entry document and lists resource paths without eagerly reading those resources.
- `/node remove <node-id>` refuses reserved ids such as `master`, removes only approved-node credentials (not pending pair approval/rejection flow), and closes/unregisters the online runtime node if present.
- `/node move <old-id> <new-id>` validates the new id through the registry's sanitized/reserved rules, rejects approved-node and online-runtime conflicts, preserves the server-side auth hash and metadata, closes the old runtime connection if present, and warns that node-side `node_credentials.json` still contains the old id and must be edited/re-paired/restarted.
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

- [2026-07-12] The user-facing fork command syntax is `/fork [suffix] [message]`: suffix is an optional ASCII-safe child-session suffix, and message is all remaining raw text after the suffix delimiter, including internal spaces and newlines. Omitted suffix uses the existing generated-session suffix behavior; there is no ambiguous legacy `/fork [message]` interpretation.
