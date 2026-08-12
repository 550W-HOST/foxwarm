# Unit: src-index

Files: src/index.ts

## Purpose

Main application entry point that bootstraps the Foxwarm bot system: initializes storage, starts communication channels (Telegram, Matrix, WebUI, TUI, WeWork/Weixin), sets up HTTP server with WebSocket support, and orchestrates session management, vector DB, timers, and message routing.

## Key Exports

None — this file is the application entry point and does not export any symbols.

## Function Index

| Function | Lines (approximate) | Description (one phrase) |
|----------|---------------------|--------------------------|
| `ensureToken()` | ~80–95 | Reads or generates the main authentication token file |
| `ensureNodeToken()` | ~97–112 | Reads or generates the node pairing token file |
| `start()` | ~114–430 | Main bootstrap function: migrates data, initializes channels, HTTP server, router, and all subsystems |
| `handleOnboot(telegramChannelPromise)` | ~430–465 | Processes ONBOOT.md file to trigger auto-run messages on startup |

## Dependencies

- `./common` — logger
- `./channels/telegramChannel` — TelegramChannel class
- `./channels/matrixChannel` — MatrixChannel class
- `./channels/webuiChannel` — WebUIChannel class
- `./channels/tuiChannel` — TUIChannel class
- `./channels/weworkChannel` — WeWorkWebhookChannel class
- `./channelRuntime` — `initializeChannelRuntime`, `startManagedChannel`
- `./messageRouter` — MessageRouter class
- `./commandHandler` — CommandHandler class
- `./sessionManager` — session loading, resumption, event queuing
- `./sessionRuntime` — local high-level session DTO service, update-event bridge, and graceful drain
- `./mainManagementTools` — closed local Main Management tool service initialization and graceful drain
- `./nodeExecution` — closed local remote-node execution forwarding service and terminal drain
- `./vector` — configured vector owner startup and graceful shutdown
- `./channel` — `registerChannel`
- `./config` — all configuration constants and helpers
- `./httpServer` — HttpServer class, `setHttpServer`
- `./nodes/websocket` — `registerNodeWebSocket`
- `./nodes/httpRoutes` — `registerNodeHttpRoutes`
- `./nodes/registry` — `initializeNodeRegistry`
- `./logRotation` — `cleanupLegacyTopLevelLogDirs`, `scheduleLogRotation`
- `./startupUtils` — `startWithRetry`
- `./timers` — `initializeTimers`
- `./execManager` — `initializeExecManager`

## Behavior

- Registers global `unhandledRejection` and `uncaughtException` handlers (exits on uncaught exception).
- Initializes the framework-level `agents/00_SYSTEM.md` from `templates/agents/00_SYSTEM.md` for fresh installs, but if legacy `agents/main/memory/00_SYSTEM.md` already exists it leaves the root file absent so runtime fallback preserves the user's existing framework prompt.
- Initializes main agent memory from `templates/main/memory/` if the memory directory is absent or empty; that template no longer carries the framework `00_SYSTEM.md`, avoiding duplicate prompt injection on fresh installs.
- Optionally starts TUI mode and redirects logger output to the TUI screen.
- Loads sessions and completes startup migrations before entering explicit disabled Vector mode or starting the configured local/child vector owner. Disabled mode does not load the manager/runtime/native LanceDB, start maintenance/backfill, or spawn the `dbWorkers` child. With `sessionWorkers:true`, it opens the durable Worker store, reconciles ownership, creates the supervisor/ingress coordinator with the Main destructive-admission wrapper, initializes Worker-aware SessionRuntime, installs enqueue/delete/fork/fence hooks, and resumes pending mailbox work; Session-semantic reads ensure/load an owner before detached authority reads. The fork-source hook uses the lifecycle-only ensure variant because fork/child creation already holds SessionManager's non-reentrant identity lock. With workers disabled, SessionRuntime remains local. Main Management and Node execution initialize after SessionRuntime, then startup ensures a `main` session exists.
- Builds an authorized-users list from all channel configs for the MessageRouter.
- Starts an HTTP server (Express) with WebSocket upgrade, registers node routes and WebSocket handlers.
- Starts each configured channel (Telegram, Matrix, WebUI, WeWork, Weixin) with retry logic via `startWithRetry`.
- Resumes busy sessions after all channels are up.
- Schedules periodic log rotation.
- Processes `ONBOOT.md` to send a startup message/event after a 3-second delay.
- On `SIGINT`/`SIGTERM`, shuts down Session workers with bounded handback, closes the Main process's lazy ToolScript/Monty pool before its host-call services, terminally drains Node execution, MCP, Main Management, and SessionRuntime calls/publication, then gracefully drains the vector owner and exits.

## Integration

- Channels register themselves via `registerChannel` and receive messages through the `MessageRouter`, which delegates to `CommandHandler` and `sessionManager`.
- The HTTP server hosts the WebUI channel and node communication (WebSocket + HTTP routes).
- `channelRuntime` manages dynamic channel lifecycle (start/stop) for managed channels like Weixin.
- `sessionManager` is the central state coordinator; sessions are resumed and events queued from this entry point.
- `initializeTimers` and `initializeExecManager` set up background task infrastructure used by sessions.