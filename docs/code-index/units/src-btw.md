# Unit: src-btw

Files: src/btw.ts, src/btw.test.ts

## Purpose

Provides a "BTW" (by-the-way) side-request feature that lets users ask a quick background question against a cloned session without mutating the main conversation history or executing tools. The result is appended as a display-only message visible to the user but hidden from the model.

## Key Exports

- `BTW_USAGE` — usage string constant for the `/btw` command
- `runBtwRequest(sessionId, message)` — executes a background LLM request and appends the result to the session

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `cloneMessageArray(messages)` | ~21 | Deep-clones a message array via structuredClone |
| `cloneSessionForBtw(session)` | ~24–56 | Creates an isolated shallow+deep clone of a session for safe BTW use |
| `buildBtwRequestParts(message)` | ~58–63 | Constructs the system+user message parts for the BTW LLM call |
| `extractText(result)` | ~65–76 | Extracts text from a ChatResult, falling back to allParts |
| `formatToolNames(toolCalls)` | ~78–81 | Deduplicates and formats tool call names for display |
| `formatBtwPayload(text)` | ~83–85 | Wraps BTW answer text in a labeled payload string |
| `formatBtwToolDenied(toolCalls)` | ~87–93 | Formats a warning message when tool calls are blocked |
| `formatBtwError(error)` | ~95–98 | Formats an error into a user-facing warning string |
| `appendBtwResult(sessionId, payloadText)` | ~100–112 | Persists the BTW result as a display-only message and broadcasts it |
| `runBtwRequest(sessionId, message)` | ~114–148 | Orchestrates the full BTW flow: clone, call LLM, handle tools/errors, persist |

## Dependencies

- `./common` — `logger`
- `./llm` — `chat`
- `./sessionManager` — `getSession`, `appendSessionMessage`
- `./session/messageVisibility` — `createDisplayOnlyModelMessage`
- `./types` — `ChatResult`, `FunctionCall`, `Message`, `MessagePart`, `Session`

## Behavior

- Clones the session (history, metadata, and promptCacheKey) so the BTW LLM call cannot mutate live state while following [D-lifecycle-prefix-lineage](../threads/session-lifecycle.md#d-lifecycle-prefix-lineage).
- Injects a system prompt instructing the model not to use tools.
- If the model returns tool calls anyway, the request is denied and a warning is appended instead of executing tools.
- On success or failure, a display-only (`modelVisible: false`) message is appended to the real session history and broadcast to connected clients (excluding webui).
- Errors during the LLM call are caught and surfaced as formatted error messages rather than thrown.

## Integration

- Invoked by the `/btw` command handler registered in `./commands`.
- Uses `llm.chat` for inference with a custom `appendMessage` callback that writes only to the temporary clone. Before cloning, legacy sessions are ensured to have a persisted promptCacheKey so the clone does not generate a one-off key.
- Persists results via `sessionManager.appendSessionMessage` using the display-only message pattern, ensuring BTW output is excluded from model context, compaction, and tool-based session previews. A successful BTW result copies its concrete `modelId` and optional resolved `virtualModelKey` to the persisted display-only model message under the canonical [model-attribution contract](../threads/model-routing.md#d-model-routing-concrete-attribution).
- Tests verify integration with `toolsSessionAgent` (session message previews hide BTW content), `session/history` (compaction skips display-only messages), and `session/layeredContext` (display-only messages ignored in compact candidates).