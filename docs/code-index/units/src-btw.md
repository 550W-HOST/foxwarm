# Unit: src-btw

Files: src/btw.ts, src/btw.test.ts
Secondary files: src/sessionWorkerHost.ts, src/sessionWorkerHost.test.ts, src/sessionWorkerDestructive.test.ts

## Purpose

Provides a "BTW" (by-the-way) side-request feature that lets users ask a quick background question against a cloned session without mutating the main conversation history or executing tools. The result is appended as a display-only message visible to the user but hidden from the model.

## Key Exports

- `BTW_USAGE` — usage string constant for the `/btw` command
- `cloneSessionForBtw(session)` — creates a detached exact model-facing snapshot.
- `ensureBtwPromptCacheKey(session)` — establishes cache lineage and reports whether the owner changed.
- `executeBtwRequest(snapshot, message)` — runs provider-only BTW work against a detached snapshot and returns a display payload/result metadata.
- `buildBtwDisplayResult(result)` — creates the one display-only persisted notice.
- `runBtwRequest(sessionId, message)` — executes a background LLM request and appends the result to the session

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `cloneMessageArray(messages)` | ~21 | Deep-clones a message array via structuredClone |
| `cloneSessionForBtw(session)` | Creates an isolated shallow+deep clone of a session for safe BTW use |
| `buildBtwRequestParts(message)` | ~58–63 | Constructs the system+user message parts for the BTW LLM call |
| `extractText(result)` | ~65–76 | Extracts text from a ChatResult, falling back to allParts |
| `formatToolNames(toolCalls)` | ~78–81 | Deduplicates and formats tool call names for display |
| `formatBtwPayload(text)` | ~83–85 | Wraps BTW answer text in a labeled payload string |
| `formatBtwToolDenied(toolCalls)` | ~87–93 | Formats a warning message when tool calls are blocked |
| `formatBtwError(error)` | ~95–98 | Formats an error into a user-facing warning string |
| `ensureBtwPromptCacheKey(session)` | Establishes stable prompt-cache lineage before snapshotting |
| `executeBtwRequest(snapshot, message)` | Runs the nonstreaming provider request, denies tool calls, and folds provider errors into a display payload |
| `buildBtwDisplayResult(result)` | Builds the display-only message plus external text |
| `appendBtwResult(sessionId, result)` | Local adapter persistence and attachment broadcast |
| `runBtwRequest(sessionId, message)` | Local adapter: ensure cache key, snapshot, execute, and append |

## Dependencies

- `./common` — `logger`
- `./llm` — `chat`
- `./sessionManager` — `getSession`, `appendSessionMessage`
- `./session/messageVisibility` — `createDisplayOnlyModelMessage`
- `./types` — `ChatResult`, `FunctionCall`, `Message`, `MessagePart`, `Session`

## Behavior

- Clones the session (history, frontier, snapshot, metadata, and promptCacheKey) so the BTW LLM call cannot mutate live state while following [D-lifecycle-prefix-lineage](../threads/session-lifecycle.md#d-lifecycle-prefix-lineage).
- Injects a system prompt instructing the model not to use tools.
- If the model returns tool calls anyway, the request is denied and a warning is appended instead of executing tools.
- On success or failure, a display-only (`modelVisible: false`) message is appended to the real session history and broadcast to connected clients (excluding webui).
- Errors during the LLM call are caught and surfaced as formatted error messages rather than thrown.

## Integration

BTW provider calls use request-journal purpose `btw`, so the copied canonical prefix, side prompt, and model result remain reconstructable even though only the display-only BTW notice is appended to the real session.

- Invoked by the `/btw` command through SessionRuntime for local or exact Worker placement.
- Uses `llm.chat` for inference with a custom `appendMessage` callback that writes only to the temporary clone. Before cloning, legacy sessions are ensured to have a persisted promptCacheKey so the clone does not generate a one-off key.
- Local placement persists through `sessionManager.appendSessionMessage`. Worker placement runs snapshot provider work concurrently with a busy owner, then serializes only the final display append/persist/full projection and uses the existing Main attachment-broadcast facade. The canonical Worker contract is [D-process-topology-btw-side-request](../threads/process-topology-and-rpc.md#d-process-topology-btw-side-request).
- Display-only persistence excludes BTW output from model context, compaction, and tool-based session previews. A successful BTW result copies its concrete `modelId` and optional resolved `virtualModelKey` under the canonical [model-attribution contract](../threads/model-routing.md#d-model-routing-concrete-attribution).
- Local and real-child tests cover snapshot isolation, cache lineage, nonstreaming options, tool denial, provider errors, busy/idle ordering, one display row/broadcast, projection, and idle-release accounting.