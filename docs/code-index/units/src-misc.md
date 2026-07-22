# Unit: src-misc

Files: src/common.ts, src/startupUtils.ts, src/jsonObjectArgs.ts, src/asrClient.ts, src/logRotation.ts, src/nodeFileTransfer.ts, src/guestAgent.test.ts, src/session/sessionSystemPromptFiles.test.ts

## Purpose

This unit provides miscellaneous infrastructure utilities: logging setup, startup retry logic, JSON argument parsing/validation, ASR (speech recognition) service client, log rotation/archival, file transfer helpers for node-based agents, and integration tests for guest agent and session system prompt behavior.

## Key Exports

- `logger` — configured pino logger instance (file + optional console)
- `startWithRetry` — retries an async startup function with configurable attempts/delay
- `isJsonObject`, `parseJsonObjectString`, `resolveObjectArgWithJsonFallback`, `requireStringMapObject` — JSON object argument parsing and validation utilities
- `getAsrServiceBaseUrl`, `getAsrServiceHeaders`, `getAsrServiceStatus`, `transcribeWithAsrService`, `createAsrServiceWebSocket` — ASR service client functions
- `formatDate`, `formatTime`, `getDatedLogPath`, `getRecentLogPath`, `moveLogsToDateErrorDir`, `cleanupLegacyTopLevelLogDirs`, `rotateDatedLogs`, `rotateExecLogsForAgents`, `runLogRotation`, `scheduleLogRotation` — log rotation and management
- `resolveNodeTransferPath`, `detectTransferMimeType`, `readNodeTransferFile`, `writeNodeTransferFile` — file transfer for node agents
- `NodeTransferFilePayload`, `NodeTransferWriteResult`, `AsrStatusResult` — key types

## Function Index

| Function | Lines (approx) | Description (one phrase) |
|----------|------|-------------|
| `logger` (config) | ~1–50 | Configures pino logger with transport-based normal mode or synchronous file-only short-lived mode |
| `sleep` | ~3 | Promise-based delay helper |
| `startWithRetry` | ~5–32 | Retries an async startup function with exponential backoff |
| `hasOwn` | ~3–5 | Checks if object has own property safely |
| `isJsonObject` | ~7–9 | Type guard for plain JSON objects |
| `parseJsonObjectString` | ~11–25 | Parses a string into a validated JSON object |
| `resolveObjectArgWithJsonFallback` | ~27–52 | Resolves an object arg with JSON string fallback |
| `requireStringMapObject` | ~54–65 | Validates all values in an object are strings |
| `normalizeServiceUrl` | ~18–22 | Trims and removes trailing slashes from URL |
| `getAsrServiceBaseUrl` | ~24–29 | Returns configured ASR service URL or null |
| `getAsrServiceHeaders` | ~31–37 | Builds auth headers for ASR service |
| `getAsrServiceStatus` | ~39–63 | Checks ASR service health endpoint |
| `transcribeWithAsrService` | ~65–100 | Sends audio to ASR service for transcription |
| `getAsrServiceWebSocketUrl` | ~102–107 | Converts HTTP URL to WebSocket URL for streaming |
| `createAsrServiceWebSocket` | ~109–114 | Creates a WebSocket connection to ASR streaming endpoint |
| `formatDate` | ~10–14 | Formats date as YYYY-MM-DD string |
| `formatTime` | ~16–22 | Formats time as HHMMSSmmm string |
| `getDatedLogPath` | ~24–28 | Returns path inside a date-named subdirectory |
| `pruneDirectoryToMaxFiles` | ~30–58 | Removes oldest files when directory exceeds max count |
| `getRecentLogPath` | ~60–64 | Returns path in a pruned "recent" subdirectory |
| `moveLogsToDateErrorDir` | ~66–80 | Moves log files into a date-error directory |
| `cleanupLegacyTopLevelLogDirs` | ~82–96 | Removes legacy date/archive directories |
| `listDateDirs` | ~98–106 | Lists date-formatted subdirectories sorted descending |
| `listArchives` | ~108–114 | Lists .tar.gz archives sorted descending |
| `rotateDatedLogs` | ~116–148 | Archives old date dirs and prunes old archives |
| `rotateExecLogsForAgents` | ~150–162 | Rotates exec logs for all agents |
| `runLogRotation` | ~164–167 | Runs full log rotation (main + agents) |
| `scheduleLogRotation` | ~169–176 | Schedules periodic log rotation on a timer |
| `expandHomePath` | ~55–61 | Expands ~ to home directory in file paths |
| `resolveNodeTransferPath` | ~63–78 | Resolves and validates file path within agent directory |
| `detectTransferMimeType` | ~80–86 | Detects MIME type and image flag from file extension |
| `readNodeTransferFile` | ~88–105 | Reads a file and returns base64-encoded payload with metadata |
| `writeNodeTransferFile` | ~107–127 | Writes base64 data to a file with overwrite control |
| `makeId` | ~test | Generates unique test IDs |
| `appendStubUserMessage` | ~test | Appends a stub user message to session in tests |
| `appendStubModelMessage` | ~test | Appends a stub model message to session in tests |
| `makeCtx` | ~test | Creates a mock message context for tests |
| `cleanupAgent` | ~test | Removes agent directory during test cleanup |
| `ensureParentSession` | ~test | Sets up a minimal parent session for test scenarios |

## Dependencies

- `./config` — `BOT_NAME`, `ENABLE_TUI`, `LOGS_DIR`, `AGENTS_DIR`, `ASR_SERVICE_CONFIG`, `getAgentDir`, `getAgentMemoryDir`, `SESSIONS_FILE`, `readAppConfigFile`, `writeAppConfigFile`
- `./common` — `logger` (used by startupUtils, logRotation)
- `./messageRouter` — `MessageRouter` (tests)
- `./llm` — `chat`, `getPersistentMemory` (tests, mocked)
- `./vector` — `scheduleSessionArchiveIndex` (tests, mocked)
- `./sessionManager` — session CRUD, channel attachment, agent isolation (tests)
- `./session/channels` — `importLegacyChannelAttachments` (tests)
- `./channelAuth` — `inspectChannelAuthorization` (tests)
- `./toolsSessionAgent` — `tool_create_session` (tests)
- `./types` — `MessagePart`, `Session`

## Behavior

- **Logger** writes to a file always; console output is suppressed when TUI mode or `FOXWARM_NO_CONSOLE_LOG` is set. `FOXWARM_SYNC_FILE_LOG=1` selects a synchronous file destination for short-lived compiled-module consumers such as `foxwarm model`, avoiding transport-worker shutdown hangs while leaving normal server logging unchanged.
- **startWithRetry** attempts a startup function up to N+1 times with a configurable delay, returning null on exhaustion.
- **JSON args** utilities handle the dual-path pattern where a tool argument can be either a native object or a JSON string, with clear error messages.
- **ASR client** communicates with an external speech recognition service via HTTP (transcription, health) and WebSocket (streaming), using bearer token auth.
- **Log rotation** archives date-named directories into tar.gz files, prunes old archives, and cleans up legacy directory structures. Runs on a 10-hour interval.
- **Node file transfer** enforces path traversal protection (restricts to agent directory by default), computes SHA-256 checksums, and handles base64 encoding/decoding.
- **Tests** verify guest agent session creation (single and inherited modes, isolated and non-isolated initial-node variants), channel authorization semantics, and systemPromptFiles behavior including isolation enforcement.

## Integration

- `logger` is the shared logging instance used across the entire application.
- `startWithRetry` wraps component initialization (e.g., services that may be temporarily unavailable at boot).
- `resolveObjectArgWithJsonFallback` is used by tool implementations to normalize arguments from LLM tool calls.
- ASR client is consumed by voice/audio processing features to transcribe user audio.
- Log rotation is scheduled at application startup and manages logs for the main process and per-agent execution logs.
- Node file transfer supports the file read/write tools exposed to agents running on remote nodes.
- The test files validate cross-cutting behavior involving `messageRouter`, `sessionManager`, `channelAuth`, and `toolsSessionAgent`.