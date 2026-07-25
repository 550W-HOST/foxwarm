# Unit: src-message-router

Files: src/messageRouter.ts, src/messageRouter.test.ts, src/utils/messageFormat.test.ts

## Purpose

Routes incoming channel messages to the appropriate session, handles authorization, manages session queues, orchestrates LLM turn execution (including tool calls and child/guest sessions), and delivers replies back through channels.

## Key Exports

- `MessageRouter` — Main class that receives channel messages, resolves sessions, processes queues, and drives LLM interactions
- `shouldBroadcastChannelText(text)` — Utility predicate for filtering empty/whitespace broadcast text

## Function Index

| Function | Lines (approx) | Description (one phrase) |
|----------|------|-------------|
| `formatCurrentTimeForPrompt(date)` | ~20 | Formats a Date for inclusion in prompt system parts |
| `normalizeGuestAgentConfig(raw)` | ~30 | Validates and normalizes raw guest agent configuration objects |
| `generateGuestAgentName(baseAgentId)` | ~55 | Allocates a unique directory-safe guest agent name with random suffix |
| `shouldBroadcastChannelText(text)` | ~68 | Returns true if text is non-empty after trimming |
| `MessageRouter.constructor(authorizedUsers)` | ~73 | Initializes authorized user map |
| `MessageRouter.addSourceSystemParts(parts, source)` | ~85 | Wraps direct channel input with `<foxwarm-message type="channel" ...>` metadata tag parts; WebUI messages keep only `channelType="webui"` |
| `MessageRouter.snapshotSource(ctx)` | ~113 | Creates a QueueSource snapshot from a ChannelContext, including channel-specific stream binding such as WeWork stream id |
| `MessageRouter.sendSessionReply(session, sourceCtx, text, options)` | ~120 | Delivers a reply via direct reply, broadcast, or fallback; final responses pass through `turnFinal` in options |
| `MessageRouter.getTurnChannelOptions(sourceCtx, source)` | ~mid | Builds generic broadcast options for platform stream/card state (currently WeWork stream id + target) |
| `MessageRouter.emitTurnProgress(broadcast, turnOptions, progress)` | ~mid | Emits empty targeted channel broadcasts carrying structured LLM/tool progress for stream-card channels |
| `sessionManager.setActiveSessionRuntimeState(...)` calls | `runSessionTurn` | Marks `requesting-model` before LLM requests and `running-tool` during tool execution for WebUI/status runtime state. |
| `MessageRouter.getToolResultProgress(toolResultMsg)` | ~mid | Converts batched tool responses into success/error progress records |
| `MessageRouter.buildToolBroadcast(broadcast, turnOptions)` | ~mid | Suppresses legacy verbose tool-text broadcasts to the current WeWork stream channel while preserving other broadcasts |
| `MessageRouter.createLlmRetryNotifier(session, broadcast)` | ~mid | Builds an `llm.chat` retry callback that creates/updates one display-only retry notice and broadcasts concise retry snippets |
| `MessageRouter.prepareUserParts(parts, source)` | ~132 | Clones parts and adds source system parts before channel user input enters the queue |
| `MessageRouter.buildChannelUserQueueItem(ctx, message)` | ~mid | Builds the canonical queued channel-user item with source metadata and one pre-injected source prefix |
| `MessageRouter.prepareTurnParts(session, sessionId, parts)` | ~137 | Adds compact time/session-id `<foxwarm-system ... />` metadata parts for a new turn; does not inject channel source prefixes |
| `MessageRouter.drainLeadingQueuedTurnInputs(session)` | ~152 | Pops compatible queued input/event items as one provider batch while preserving their individual history boundaries |
| `MessageRouter.consumeLeadingQueuedTurnInputs(session, pendingParts, turnStreamKey?)` | ~170 | Appends non-control queued inputs separately before the next in-turn LLM call until a different stream/card boundary is reached |
| `MessageRouter.tryClaimSession(session)` | ~205 | Atomically marks session busy; returns false if already claimed |
| `MessageRouter.continueWithQueuedWork(session)` | ~215 | Main loop: drains queue, runs LLM turns, handles retry controls, compaction, and tool calls |
| `MessageRouter.executeLlmTurn(session, sessionId, parts)` | ~280 | Sends prepared parts to LLM, processes response and tool calls |
| `MessageRouter.handleToolCalls(session, sessionId, toolCalls)` | ~330 | Dispatches tool calls, collects results, appends tool response messages |
| `MessageRouter.handleChildSessionResult(session, result)` | ~380 | Processes child session completion, builds reminder, updates managed state |
| `MessageRouter.maybeAppendGoalIntervalReminder(session)` | ~mid | Appends a due interval reminder before a real provider request |
| `MessageRouter.maybeCreateGuestSessionForUnauthorizedMessage(ctx)` | ~420 | Provisions a guest session if channel config allows |
| `MessageRouter.resolveSessionForIncomingMessage(ctx)` | ~460 | Finds or creates the session mapped to a channel context |
| `MessageRouter.isAuthorized(channelId, channelType, conversationId, senderId)` | ~490 | Checks authorization via map and channel auth inspection |
| `MessageRouter.buildUnauthorizedMessage(ctx)` | ~505 | Formats a rejection message for unauthorized users |
| `MessageRouter.handleCommandIfNeeded(ctx, text)` | ~515 | Delegates slash-command handling with both tokenized args and the raw multiline argument tail |
| `MessageRouter.stripConfiguredSelfMention(ctx, text)` | ~mid | Removes a configured leading `@selfName` mention plus whitespace before command parsing |
| `MessageRouter.appendUserMessage(session, parts)` | ~525 | Wraps parts into a user Message and appends to session history |
| `MessageRouter.handleIncomingMessage(ctx, message)` | ~535 | Top-level entry point: authorizes, resolves session, enqueues, triggers processing |
| `MessageRouter.processSessionQueue(sessionId)` | ~590 | Public entry to process a session's queue by ID with re-entrancy guard |

## Dependencies

- `./channel` — `ChannelContext`, `ChannelMessage`, `getChannelId`, `getChannelType`, `getConversationId`
- `./channelAuth` — `formatAuthorizationInspection`, `inspectChannelAuthorizationFromContext`
- `./config` — `getAgentDir`, `getChannelConfigById`, `readAppConfigFile`
- `./session/childSessionReminder` — `buildChildReminder`, `isModelNoActionSignal`
- `./session/managedState` — `getManagedSessionState`, `isManagedSessionActive`, `setManagedSessionState`
- `./session/snapshotRefresh` — `maybeRefreshStaleSessionSnapshot`
- `./session/goal` — `maybeBuildGoalReminderMessage`, `maybeBuildGoalEndTurnReminderMessage`
- `./sessionManager` — session CRUD, queue operations, message appending, channel config
- `./llm` — LLM inference calls
- `./types` — `ChannelTurnProgress`, `Message`, `MessagePart`, `QueueItem`, `QueueSource`, `Session`
- `./utils/localTime` — `formatLocalTimestamp`

## Behavior

- Maintains a `processingSessions` set to prevent re-entrant queue processing for the same session.
- Claims sessions atomically via `tryClaimSession` (sets `session.busy`).
- The main loop (`continueWithQueuedWork`) repeatedly drains queued items, runs LLM turns, handles internal retry controls, handles tool calls, manages child/guest session lifecycle, and processes compaction events until the queue is empty. A stopped turn skips auto-draining unless the session was marked by `/dequeue` to run queued work after the stop.
- Final response/error broadcasts include `turnFinal: true`; this is a generic channel option currently used by WeWork stream aggregation to finish the platform stream card, and ignored by channels that do not need it.
- During each LLM/tool loop, stream-bound WeWork turns emit structured `channelTurnProgress` options: `llm-start`, `tool-calls-start`, and batched `tool-calls-finish` after `executeTools` returns. These are transient channel display events and are not appended to session history. When an LLM response contains both text and tool calls, the router sends that text inside the WeWork `tool-calls-start` progress payload so the card can update atomically to `model text + ⌛️ tools`; the separate text broadcast excludes the current WeWork stream channel to avoid duplicate sections.
- Before each real provider request, the router may append a due interval goal reminder directly to canonical history after queued inputs or the prior tool result have been persisted. It never puts a goal reminder in the session queue; the canonical contract is [D-goal-direct-safe-boundary](src-session-goal.md#d-goal-direct-safe-boundary).
- Independently of channel progress, `runSessionTurn` sets canonical transient runtime state for session list/status: `requesting-model` immediately before `llm.chat`, batch-level `running-tool` before tool dispatch, and deterministic model-order per-tool `running-tool` details via the tool executor's `onToolStart` callback. Parallel direct-exec completion does not create a new runtime-state protocol. All active runtime state is cleared when session processing finishes or when queued compaction exits.
- LLM retry progress (automatic provider-request retries within one turn) is appended as a display-only model message (`modelVisible:false`, `noticeType:'llm-retry'`) so WebUI/history can show why the turn is waiting without feeding retry text back to the model. Subsequent retry attempts, including the final failed attempt, mutate and re-notify the same message (`__meta.updateExisting:true`) instead of creating many history messages. The visible text starts with `⚠️ [LLM retry]` and puts each `Attempt N/M failed: ...` on its own line; final events end with `No more retries.` Non-WebUI channel broadcasts receive concise multi-line retry snippets; WebUI relies on history SSE update/replacement.
- When `llm.chat()` throws `LlmRequestError`, the router does not append a model-visible `Error:` history message. If a retry notice exists, that display-only notice is the visible history record; otherwise the error is surfaced through the channel boundary only.
- Top-level queued turn start preserves WeWork stream/card boundaries: stream-bound queued messages with different stream ids, or stream-bound vs unbound messages, start as separate turns instead of being consumed by one LLM request/card. Compatible queued inputs and structured events may share one provider request, but each is appended as its own canonical history message first.
- A drained top-level batch stays unsent through a pending pre-LLM compact or compact-commit boundary. After that boundary completes, the router appends each queue item separately and then consumes any ordinary compatible follow-ups; the first logical queued item alone owns the turn reply source.
- Once a tool loop turn is already in progress, each pre-LLM safe point drains compatible non-compaction/non-retry queued inputs into the next LLM call. This preserves the queue-unification behavior where user follow-ups sent during tool execution can be seen by the next model iteration, while keeping queued WeWork messages with a different stream/card id in the queue for their own next turn/card update. The router flushes the unsent current input and appends every consumed queue item separately before that request; provider serialization owns any necessary adjacent-role normalization. Internal `/retry` queue controls stay as their own turn boundary and run with queued-input draining disabled for that turn, so later user items are processed only after the retry turn completes.
- After a successful `llm.chat(parts, ...)` return, the router clears its local `parts`: non-null input is already canonical history at that point. A pre-LLM compact boundary still keeps unsent input, but a compact commit between tool iterations cannot replay dispatched input or merge it with a later queued item. Canonical decision: [D-pipeline-dispatched-parts-ownership](../threads/message-processing-pipeline.md#d-pipeline-dispatched-parts-ownership).
- Channel user input gets its channel source wrapper exactly once when building the queued user item. The wrapper is an opening/closing `<foxwarm-message type="channel" ...>` pair around the raw message parts. WebUI-origin direct user messages intentionally use minimal metadata containing only `channelType="webui"`; external channels retain channel instance/conversation/target/sender metadata for reply routing and auditability. Later queue processing treats `item.parts` as already prompt-ready; `QueueSource` is retained only for routing/stream/broadcast options.
- Slash-command parsing strips a channel-provided `ChannelContext.selfName` mention prefix (`@selfName` followed by whitespace) before applying the command regex. It passes both legacy tokenized args and the untrimmed raw argument tail; Telegram preserves the same raw tail. This lets channels such as WeWork configure Chinese/non-ASCII bot display names without allowing arbitrary mention prefixes.
- `prepareTurnParts` injects only turn-level context such as current time and session id, not channel source metadata. The generated time tag keeps only `kind="time"` plus `localTime`; the generated session tag keeps `kind="session"` plus `currentSessionId`, without redundant `hint` copies of the same values.
- Supports managed sessions: when active, incoming messages are queued for the manager rather than processed directly.
- Guest agent provisioning creates sessions for unauthorized users when channel config permits. `guestAgent.isolated` defaults true and uses `guestAgent.node` as the isolation node; when `isolated:false`, `guestAgent.node` is instead used as the new session's initial `currentNode` without enabling legacy isolated restrictions.
- Concurrent first messages for one unbound channel/conversation use the session manager's keyed get-or-create boundary and converge on one attachment without orphan lifetimes. The guest factory explicitly reports its new-lifetime ownership so race cleanup cannot delete a pre-existing session. Random single-session guest names allocate inside the identity lock; inherited guest-agent generation retries directory, live-ID, and archived-main collisions. Canonical semantics: [D-lifecycle-archived-id-reservation](../threads/session-lifecycle.md#d-lifecycle-archived-id-reservation).
- Queues messages silently when a session is already busy; the older user-facing `Request queued, currently processing another message` notice is intentionally no longer sent.
- Final busy clearing still persists the full session after queue mutations so compact/queued-item removals are not resurrected from per-session history files on the next lazy load.
- A successful handoff `waitAfterHandoff` request is applied only after the complete tool message and batch-finish progress are published. The internal post-action shape remains private to the executor/router. The router reuses an already armed wait or creates one generic persisted wait, then ends the tool loop without another model request; already queued fast replies are drained by the normal queue path. Canonical contract: [D-pipeline-handoff-wait](../threads/message-processing-pipeline.md#d-pipeline-handoff-wait).

## Integration

- Sits between channel adapters (Discord, Slack, internal, etc.) and the session/LLM layer.
- Delegates session persistence and queue storage to `sessionManager`.
- Calls `llm` module for inference; feeds tool call results back into the session loop.
- Interacts with child session and managed state modules to support multi-agent orchestration.
- Channel authorization logic gates access before routing; guest agent config allows controlled access for unauthorized users.

## Design Decisions

- [2026-06-05] `guestAgent.node` is reused for non-isolated guest sessions as the initial `session.currentNode` when `guestAgent.isolated:false`. In isolated mode it keeps its existing meaning as the agent isolation bind node.
- [2026-06-25] LLM retry notices should use display-only history plus WebUI updateExisting replacement, not model-visible system/tool messages. Broadcast snippets are acceptable for ordinary channels because many adapters lack a message-edit API. Terminal `LlmRequestError` must not create a fake model-visible `Error:` message; the final failed attempt updates the same retry notice with `No more retries.`
- [2026-07-07] Manual `/retry` is not regenerate and should not append a `retrying last request` system/user marker. `retrySession()` enqueues an internal `QueueItem.type === 'retry'`; the router processes it by calling `runSessionTurn(..., { parts: null, deferQueuedInputs: true })`, so the existing model-visible history is retried without a new user message. Queue-drain helpers must stop before retry controls, and the retry turn itself must not consume following user queue items, so retry is not swallowed or merged with real queued user input.
- [2026-07-07] Stop/dequeue queue semantics are split at the router boundary: stopped turns set `stoppedByUser` and normally skip `continueWithQueuedWork`, leaving queued items idle for a later trigger; `/dequeue` sets `session.meta.runQueuedAfterStop`, which the router consumes/clears in `finally` and then immediately continues queued work.
- [2026-07-06] Source/time/session metadata generated by the router uses Foxwarm XML-ish prompt wrappers. Direct channel content is wrapped with `<foxwarm-message type="channel" ...>`; turn-level time/current-session markers use compact `<foxwarm-system kind="time" localTime="..." />` and `<foxwarm-system kind="session" currentSessionId="..." />` tags with no redundant `hint`. Attribute values are escaped; raw user content is not XML-escaped.
- [2026-07-07] Runtime-state instrumentation is separate from channel-specific turn progress: channel progress is for stream cards and active chat rendering, while `sessionRuntimeState` is the canonical session-list/status view (`requesting-model` / `running-tool` / `waiting` / `idle`).
- [2026-07-12] Command dispatch retains tokenized `args` for existing commands but additionally carries `rawArgs` without trimming/splitting so commands such as `/fork` can preserve spaces and multiline payloads without changing other command parsers.
- Queue-item history boundaries are canonical in [D-pipeline-canonical-queue-item-boundaries](../threads/message-processing-pipeline.md#d-pipeline-canonical-queue-item-boundaries); this router batches only provider requests, never persisted queue-item messages.
