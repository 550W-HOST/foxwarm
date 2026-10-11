# Unit: WebUI deletion and terminal routes

Files: `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Deletion.cs`, `dotnet/Foxwarm/Channels/WebUi/WebUIChannel.Terminal.cs`

## Purpose

Exposes authenticated Session deletion/cleanup controls and terminal lifecycle/stream/resize/close operations.

## Stable methods and callers

Deletion routes delegate identity/deletion claims to `SessionManager`; terminal routes delegate PTY/session lookup, input, resize, stop, and event subscription to `TerminalRouter`, with `TerminalRegistry`/`TerminalClient` preserving local behavior and advertised `vscode-pty` serving remote clients. Neither route writes Session JSON or Archive directly.

## Contract and side effects

Deletion returns committed/partial/error state and cannot remove immutable Archive audit rows merely because active JSON/catalog cleanup failed. Terminal state is live process/PTY state, not Session history; terminal events carry explicit revision/close/error fields and do not report model-turn completion. Both route groups require normal host auth and owner/target validation.

## Tests

`SessionDeletionTests.cs`; `WebUiRealtimeRevisionTests.cs`; `SessionDeletionTests.cs`; `NodeServiceTransportTests.cs`; `packages/webui/test/experimentHostNodeCode.e2e.mjs`.
