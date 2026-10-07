# Unit: TypeScript compatibility source

Files: `src`

## Purpose

Retains the older TypeScript Main implementation and migration readers only where they define a real persisted or external boundary during the .NET Main replacement. It is not a second active architecture for this index.

## Boundary entry points

- `src/index.ts`, `src/httpServer.ts`, and `src/messageRouter.ts` are the older Main composition/routing path; use the .NET host pages for current Main ownership.
- `src/session/` and `src/migrations/` contain legacy authority/catalog/archive readers and migration evidence that explain persisted compatibility inputs.
- `src/channels/webuiChannel.ts`, `src/channels/webuiRealtime.ts`, and route tests describe client-facing payloads that the React WebUI and .NET `WebUIChannel` must continue to match where still supported.
- `src/llm.ts`, `src/llmProviders/`, and `src/llmRequestJournal.ts` are historical provider/journal references; current .NET behavior is canonical in the Models units.
- `src/mcp*`, `src/nodes*`, `src/managedSessions.ts`, and inbound service files remain external protocol or migration references, not proof of .NET runtime integration.

## Compatibility contract

Read old source only to identify persisted shapes, URL/protocol compatibility, migration evidence, or an unresolved external boundary. Do not copy its active Session authority claims over the .NET split: current semantic history/queue belongs to per-Session JSON, Main identity/topology/presentation belongs to catalog authority, and immutable Archive cannot rebuild missing active history.

## Tests

Targeted compatibility tests under `src/**/*.test.ts` and `test/` remain useful for external shape comparison; they are not a substitute for the .NET tests linked from the active modules.
