# Unit: src-index

Files: src/index.ts, scripts/start.sh, scripts/restart.sh, scripts/tmux-scripts.test.js
Secondary files: src/mainShutdown.integration.test.ts

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
- `./nodeExecution` / `./nodes/providers` — closed local Node execution service plus awaited provider initialization/shutdown
- `./vector` — configured vector owner startup and graceful shutdown
- `./channel` — `registerChannel`
- `./config` — all configuration constants and helpers, including the shared `access.identities` contract
- `./httpServer` — HttpServer class, `setHttpServer`
- `./mcpInboundHttp` — stateful inbound HTTP service with identity-bound contexts and graceful transport shutdown.
- `./mcpInboundCatalog` — Main-owned outbound MCP, compatible CLI Node and bounded Session wrapper adapter for verified external contexts. Worker ingress receives the optional process-local live-context assertion before durable mailbox admission.
- `./nodes/websocket` — `registerNodeWebSocket`
- `./nodes/httpRoutes` — `registerNodeHttpRoutes`
- `./nodes/registry` — `initializeNodeRegistry`
- `./logRotation` — `cleanupLegacyTopLevelLogDirs`, `scheduleLogRotation`
- `./startupUtils` — `startWithRetry`
- `./timers` — `initializeTimers`
- `./execManager` — `initializeExecManager`

## Behavior

- The executable sets the presentation-only process title `foxwarm:main` during bootstrap. The title is not used for runtime identity, lifecycle, or authorization.
- Registers global `unhandledRejection` and `uncaughtException` handlers (exits on uncaught exception).
- Initializes the framework-level `agents/00_SYSTEM.md` from `templates/agents/00_SYSTEM.md` for fresh installs, but if legacy `agents/main/memory/00_SYSTEM.md` already exists it leaves the root file absent so runtime fallback preserves the user's existing framework prompt. The starter template describes default snapshot layers and concise collaboration guidance; detailed tool syntax stays in tool descriptions and on-demand skills.
- Initializes main agent memory from `templates/main/memory/` if the memory directory is absent or empty; that template no longer carries the framework `00_SYSTEM.md`, avoiding duplicate prompt injection on fresh installs.
- Optionally starts TUI mode and redirects logger output to the TUI screen.
- Loads sessions and completes startup migrations before entering explicit disabled Vector mode or starting the configured local/child vector owner. Disabled mode does not load the manager/runtime/native LanceDB, start maintenance/backfill, or spawn the `dbWorkers` child. With `sessionWorkers:true`, it opens the durable Worker store, reconciles ownership, creates the supervisor/ingress coordinator with the Main destructive-admission wrapper, initializes Worker-aware SessionRuntime, installs enqueue/delete/fork/fence hooks, and resumes pending mailbox work. With workers disabled, SessionRuntime remains local. After SessionRuntime/Main Management establish catalog and ingress authority, Core awaits every Node provider's initialization before exposing Node execution. Startup failure is observable. Shutdown fences Node execution, then closes providers while Session ingress is still available, before shutting down workers and remaining services.
- Builds an authorized-users list from all channel configs for the MessageRouter.
- Starts an HTTP server (Express) with WebSocket upgrade and Node bootstrap/WS when WebUI, Trigger, or MCP inbound is enabled. The MCP service registers `/mcp` with the production outbound MCP discovery/call catalog before HTTP start; WebUIChannel and its SessionRuntime presentation bridge start only if WebUI or Trigger is enabled. An MCP-only deployment retains normal Main and Session initialization without granting external callers an internal Session or Node adapter.
- Starts each configured channel (Telegram, Matrix, WebUI, WeWork, Weixin) with retry logic via `startWithRetry`.
- Resumes busy sessions after all channels are up.
- Schedules periodic log rotation.
- The tmux start and restart scripts match `FOXWARM_TMUX_SESSION` (default `foxwarm`) exactly. Start refuses an existing exact session; restart uses its exact `foxwarm` window or creates that window when absent. Prefix-only sessions or windows such as `foxwarm-cli-node` are not startup targets. Both scripts retain the stable pane ID returned during creation or exact lookup and send the startup command literally, with Enter separately; window auto-renaming does not retarget input. Restart sends Ctrl+C to that pane and waits one second before entering the command. The delay allows terminal input processing; it does not confirm that the old process has exited. Build, creation, and input delivery failures exit unsuccessfully. Tests use a private tmux server with stubbed build and application startup.
- Does not create or hydrate a `main` Session during process startup; existing live Sessions and pending work recover through their established owners.
- Configured Telegram/Matrix default-main attachments retain the exact `main` target identity and log an actionable warning when that target is unavailable; startup still completes without recreating or retargeting it.
- On `SIGINT`/`SIGTERM`, synchronously closes Main-local turn admission and starts owner drain while stopping inbound MCP and outbound notification receivers. Only successful local owner drain reaches ToolScript/Monty, Node execution/providers, Session-worker handback, outbound MCP, Main Management, SessionRuntime and Vector teardown. A local drain failure logs the error and sends SIGKILL only to Main itself. Contract: [local shutdown](../threads/session-lifecycle.md#d-lifecycle-main-local-shutdown). A router created during interrupted startup is also closed before it can run recovery work.

`mainShutdown.integration.test.ts` uses real HTTP ingress, synthetic provider/embedding endpoints, SIGTERM and a fresh process against the same authority. It covers the original dependency-drain window, final/Stop settling after the signal, provider cancellation, an over-limit asynchronous compact-planning wait with queued follow-up, and a Linux native FIFO write that ignores cancellation and requires actual forced exit.

## Integration

- Channels register themselves via `registerChannel` and receive messages through the `MessageRouter`, which delegates to `CommandHandler` and `sessionManager`.
- The HTTP server hosts the WebUI channel and node communication (WebSocket + HTTP routes).
- `channelRuntime` manages dynamic channel lifecycle (start/stop) for managed channels like Weixin.
- `sessionManager` is the central state coordinator; sessions are resumed and events queued from this entry point.
- `initializeTimers` and `initializeExecManager` set up background task infrastructure used by sessions.