# Unit: src-mcp-inbound-session-service

Files: `src/mcpInboundSessionService.ts`, `src/mcpInboundSessionService.test.ts`

Secondary files: `src/mcpInboundCatalog.ts`, `src/mcpInboundHttp.ts`, `src/sessionRuntime.ts`, `src/sessionManager.ts`, `src/sessionWorkerIngress.ts`, `src/contextPreviewRenderer.ts`, `src/toolAuthorization.ts`

## Purpose

Main-owned bounded Session list/read/send facade for a verified inbound MCP identity and generated live transport context. This facade has no Agent or internal source Session and does not treat the MCP wrapper as a new permission identity. The complete cross-module access and ingress contract is [D-dispatch-mcp-inbound-bridge](../threads/tool-dispatch.md#d-dispatch-mcp-inbound-bridge).

## Operations

- `listExternalSessions` authorizes concrete `builtin:session` list with effective start/count and no Node fact. It pages the Main-owned indexed catalog through `sessionRuntime.listSessionsPage`, rechecks the policy after the await and returns only ID, optional display name, busy/queue/message counts, last-message time and current Node. An explicitly allowed list is a global catalog capability; it does not imply permission to read each Session.
- `readExternalSession` resolves a current exact ID (or an alias already supported by the existing catalog lookup), authorizes `builtin:get_session_messages` for the canonical target and effective bounded arguments, then reads `sessionRuntime.getHistory` from the exact local/Worker owner. It checks the context, target and policy again after the owner await, selects at most 50 messages by the existing positive/negative offset semantics, and applies the shared context preview renderer with a 1,000–20,000-character budget. Prompt snapshots and raw pending queues are never exported.
- `sendExternalSession` authorizes `builtin:send_to_session` for the canonical target and unmodified message. It bounds the complete serialized ordinary input to the existing 1 MiB Worker ingress limit. The `user` queue item has no QueueSource or internal source Session/relation; its first server-owned metadata part uses the shared escaped `foxwarm-system kind="external-input"` formatter with verified `externalId`, generated `contextId`, local time and the approved plain-input hint. Its second part holds the original user text, never interpolated into metadata. [WebUI's shared metadata classifier](./webui-chat-shared.md) treats the external-input tag as lightweight provenance so the ordinary user message stays in a user bubble rather than a system-delivered card. The message wakes an ordinary wait rather than satisfying a listed child reply. Awaited `sessionManager.enqueueSessionItem` uses the strict existing authority writer for this external producer instead of the compatibility save that swallows failures, or awaits durable exact Worker mailbox admission, and only then returns `{accepted:true,sessionId}`; no reply or exactly-once promise follows.
- Every action checks the live context; send also supplies a process-local assertion to the final local or Worker admission boundary after async preparation/owner resolution, rechecking exact target and policy synchronously. A context disposed before mutation/intent insertion cannot enqueue afterward. Once admission begins, later disposal does not retract input. Pre-admission denial and target loss fail without effect; uncertain persistence failures are reported as unknown, with no automatic retry.

## Tests

Real inbound SDK clients exercise two external identities and exact policy, global catalog output, isolated-target allow without a second guard, owner-aware bounded history and pending prompt/queue omission, relation matchers without fabricated Session source, ordinary wait wake and external provenance, and Worker-authority read plus durable send with a deterministic disposal barrier. Existing internal Session ingress and registered wrapper tests continue to cover their original paths.
