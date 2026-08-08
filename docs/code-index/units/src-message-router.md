# Unit: src-message-router

Files: src/messageRouter.ts
Secondary files: src/messageRouter.test.ts, src/utils/messageFormat.test.ts

## Purpose

Owns channel ingress around the canonical turn runner: authorization, slash-command dispatch, guest/session resolution, source metadata wrapping, canonical channel `QueueItem` construction, and enqueue/trigger delegation. It does not implement queue claiming or the LLM/tool loop; those rules are owned by [src-session-turn-runner](./src-session-turn-runner.md).

## Key exports

- `MessageRouter` — receives normalized channel messages, resolves authorization/session routing, builds prompt-ready queued input, and delegates local queue/retry execution to one `SessionTurnRunner`. An optional `SessionWorkerSubmitHandler` constructor parameter routes ordinary input to durable Session-worker ingress instead.
- `SessionWorkerSubmitHandler` — injected worker-placement submit entry `(sessionId, item, context)` returning a bounded committed ingress result.
- `shouldBroadcastChannelText(text)` — compatibility re-export of the turn runner's final-text predicate.

## Function index

| Function | Description |
|---|---|
| `normalizeGuestAgentConfig(raw)` | Validates configured guest-agent behavior. |
| `generateGuestAgentName(baseAgentId)` | Allocates a directory-safe inherited guest name. |
| `MessageRouter.addSourceSystemParts(parts, source)` | Adds current channel/time wrappers exactly once before enqueue. |
| `MessageRouter.prepareUserParts(parts, source)` | Clones user parts and applies source wrappers. |
| `MessageRouter.buildChannelUserQueueItem(ctx, message)` | Builds the canonical prompt-ready channel queue item and preserves `clientMessageId`, true direct-reply routing intent, and platform turn bindings such as QQ Bot `msg_id`. |
| `MessageRouter.maybeCreateGuestSessionForUnauthorizedMessage(ctx)` | Resolves configured guest access without bypassing authorization policy. |
| `MessageRouter.createGuestSession(config)` | Creates single/inherited guest sessions with current isolation semantics. |
| `MessageRouter.handleCommandIfNeeded(ctx, text)` | Parses and dispatches slash commands with raw multiline arguments. |
| `MessageRouter.resolveSessionForIncomingMessage(ctx)` | Uses the serialized channel get-or-create boundary. |
| `MessageRouter.handleMessage(ctx, message)` | Authorizes and handles commands, then materializes deferred channel media only for canonically authorized ingress before enqueueing and triggering the local runner. |
| `MessageRouter.processSessionQueue(sessionId, options)` | Delegates directly to `SessionTurnRunner.processSessionQueue`. |
| `MessageRouter.processSessionRetry(sessionId)` | Delegates directly to `SessionTurnRunner.processSessionRetry`. |

## Dependencies

- `./channel`, `./channelAuth`, and `./config` provide normalized channel identity, authorization inspection, and guest configuration.
- `./sessionRuntime` owns immutable external queue insertion.
- `./sessionManager` provides session/channel/guest lifecycle operations used before turn ownership.
- `./sessionTurnRunner` owns all local queue claim, turn, tool, compact, error, and finalization behavior; the router constructs it with `LocalSessionTurnHost`.

## Behavior and invariants

- Authorization and command dispatch complete before ordinary session queue insertion. Deferred channel media is materialized only after the original ingress is canonically authorized and its session is resolved; unauthorized and first-message guest fallback paths remain metadata-only and perform no media fetch/write.
- Source wrappers are created once at ingress. Queue processing receives prompt-ready parts and does not reconstruct channel metadata.
- QueueSource snapshots persist `preferDirectReply` only when true and retain current platform turn identities including WeWork stream ID and QQ Bot inbound `msg_id`; queue JSON round trips retain those IDs as restart/fallback delivery metadata, while the canonical runner uses channel instance plus scoped conversation rather than message/card ID as the passive-source merge boundary.
- WebUI `clientMessageId` remains queue/transport metadata and is copied to canonical history by the turn runner.
- Active managed sessions route input through the existing SessionRuntime enqueue path and receive the existing manager-facing acknowledgement.
- Busy input is enqueued silently. Idle input is enqueued and then invokes the same local turn runner.
- With an injected `SessionWorkerSubmitHandler` (Session-worker placement), ordinary busy and idle input both go through one durable mailbox submission; the local enqueue/runner path is not used, a failure never falls back locally, and a post-append ambiguous outcome remains durable retryable work. Managed-session input keeps the existing local enqueue/ack path. Local placement (no handler injected) is unchanged.
- Guest provisioning and concurrent first-message resolution retain the existing keyed session/channel creation contract.
- `MessageRouter` owns one `SessionTurnRunner(new LocalSessionTurnHost())`; public queue/retry methods are thin real-path delegates rather than a second state machine.

## Integration

The end-to-end request lifecycle is canonical in [message processing pipeline](../threads/message-processing-pipeline.md). Queue/source/goal/tool/compact/stop/retry/error behavior is documented by [src-session-turn-runner](./src-session-turn-runner.md) and that thread.

## Design decisions

- Guest-agent and ingress wrapper decisions remain unchanged.
- Queue-item history, retry, stop/dequeue, and final-delivery decisions are canonical in [message processing pipeline](../threads/message-processing-pipeline.md).
