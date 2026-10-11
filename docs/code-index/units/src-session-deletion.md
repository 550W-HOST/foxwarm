# Unit: src-session-deletion

Files: src/sessionDeletion.ts, src/sessionDeletion.test.ts
Secondary files: src/channels/webuiChannel.ts, src/commands/sessionCmd.ts, src/toolsSessionAgent/sessionCrud.ts, src/mainManagementToolService.ts, src/sessionWorkerDestructive.test.ts

## Purpose

Owns the one Main-side, operation-specific session-deletion orchestration shared by nonrecursive WebUI delete, `/session delete`, and model `delete_session`, while retaining explicit recursive WebUI deletion. It composes existing SessionManager graph, destructive-claim, channel, Worker-teardown, detach, and final-delete primitives without becoming a generic lifecycle executor.

## Key exports

- `deleteSessionLifecycle(options)` — resolves the canonical target/aliases, rejects deletion of the canonical source, acquires the narrow cross-session source/target admission when a model source exists, selects and claims the root or recursive subtree, checks blockers, prepares exact owners, revalidates graph/runtime/channel state, detaches survivors for nonrecursive deletion, and deletes in stable postorder.
- `SessionDeletionResult` — explicit not-found, busy, and deleted outcomes used by the three callers.
- `SessionDeletionError` — stable error code/status/details/retryability envelope for blockers, cross-delete conflicts, stale selection, and partial lifecycle failures.

## Behavior and boundaries

- Deletion defaults to one target. Surviving direct children are stabilized under the claim and detached before the root is removed. Only WebUI's explicit `includeDescendants:true` selects recursive deepest-first deletion.
- A source session ID is canonicalized through the loaded catalog. The exact source or any declared alias resolving to it fails before target preparation; there is no in-turn self-destruct protocol.
- Cross-session model deletion holds one process-local, non-persisted operation admission over the canonical source plus selected targets before target claim/teardown. Any overlapping cross-delete (including reciprocal A→B / B→A) fails with retryable `SESSION_DELETE_CONFLICT` before it can claim or drain its target. This check is used only by cross-delete admission: it does not claim the source, block the source Worker's own turn persistence/final delivery, or become a generic lifecycle lease.
- Non-WebUI attachments block before teardown. Busy local targets return the established stop/queue-clear retry outcome. Worker targets reuse SessionManager's exact interrupt, stop/handback, fence/mailbox removal, authority reload, and ordinary cleanup hook.
- The selected relation graph, channel blockers, busy state, and queue state are revalidated after preparation and before detach/delete. The process-local destructive claim rejects supported late relation/channel/work mutations.
- A Worker reverse caller may supply only an operation-specific source-generation assertion. It is checked at ingress by the fixed Main service, before every target preparation, before final mutation, and before each detach/delete. No mutable source Session, callback from the child, generic claim, or lifecycle protocol crosses IPC.
- Unexpected detach or delete failure reports actual partial progress; no rollback is invented.

## Integration

- `src/channels/webuiChannel.ts` maps HTTP outcomes/errors and keeps recursive delete explicit.
- `src/commands/sessionCmd.ts` renders command-specific busy/deleted/not-found replies.
- `src/toolsSessionAgent/sessionCrud.ts` preserves isolation checks and model-result strings; a Worker caller uses the fixed Main Management operation.
- `src/mainManagementToolService.ts` admits exactly bounded `{ sessionId }` args for the reverse operation and supplies the exact source-generation fence.
- `src/sessionManager.ts` remains owner of the concrete claim, relation, channel, Worker teardown, and local deletion primitives.

## Tests

Focused tests cover canonical aliases and self-rejection, isolation, attachments, busy retry, stale source/graph fences, surviving-child detachment, command/tool parity, and real Worker deletion of local, idle-Worker, and busy-Worker targets without source teardown; a surviving Worker child remains detached after later publication. A deterministic two-Worker production-reverse regression synchronizes reciprocal delete calls before admission, proves one target deletion commits while the overlapping call records retryable `SESSION_DELETE_CONFLICT`, observes no drain/closed RPC failure, and verifies the surviving source reaches a normal idle exact-owner state. Claim-window regressions prove that Worker sink/runtime ingress, fork-source capture, and catalog-only parent mutation fail retryably before spawn/mailbox/provider/catalog effects, including an ingress begun before claim acquisition but paused before concrete admission, while the owning deletion claim may still detach survivors. The same production-shaped fork regression proves the lifecycle-only Worker ensure does not recursively acquire Main's non-reentrant identity lock. Existing WebUI route tests retain recursive preflight, deepest-first order, claim, and late-mutation coverage.

## Canonical ownership

The complete product contract is canonical in [D-lifecycle-descendant-actions](../threads/session-lifecycle.md#d-lifecycle-descendant-actions).
