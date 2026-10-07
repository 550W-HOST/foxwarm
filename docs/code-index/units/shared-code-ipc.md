# Unit: Shared Code helper IPC and VS Code service

Files: `packages/shared/src/codeHelperIpc.ts`, `packages/shared/src/codeHelperIpc.test.ts`, `packages/shared/src/vscodeNodeService.ts`

## Purpose

Defines the local Code-helper request/result wire and shared VS Code Node service adapter used by the Code workbench and CLI/Node integration.

## Stable symbols and callers

`codeHelperIpc`; `vscodeNodeService`. The .NET `CodeHelperServer`/`CodeWorkbench` own the host-side route and IPC endpoint; this package remains a compatibility/client boundary.

## Behavior and side effects

IPC messages are explicit request/result records with bounded payload handling. The shared service does not decide Session ownership or tool authorization.

## Tests

`packages/shared/src/codeHelperIpc.test.ts`; Code route and VS Code Web integration tests.
