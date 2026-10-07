# Unit: Shared Node protocol and capability shapes

Files: `packages/shared/src/index.ts`, `packages/shared/src/nodeCapabilities.ts`, `packages/shared/src/nodeFileTransfer.ts`, `packages/shared/src/nodeProtocol.ts`, `packages/shared/src/nodeProtocol.test.ts`, `packages/shared/src/nodeTools.ts`, `packages/shared/src/nodeTools.test.ts`

## Purpose

Defines the stable TypeScript transport/capability contract used by authenticated CLI, browser, Android, and sandbox Nodes, including node descriptors, tool invocation/result shapes, file transfer, and capability discovery.

## Stable symbols and callers

`nodeProtocol`; `nodeCapabilities`; `nodeTools`; `nodeFileTransfer`; package exports from `index.ts`. CLI and browser transports serialize these shapes; the .NET Main index treats them as compatibility boundaries, not as evidence of a migrated remote topology.

## Behavior and side effects

Protocol compatibility tests preserve exact optional-field and capability behavior. File transfer and tool results remain bounded and explicit; a remote capability is not interchangeable with a Main-local authorization grant.

## Tests

`packages/shared/src/nodeProtocol.test.ts`; `nodeTools.test.ts`; CLI `nodeProtocolCompatibility.test.ts`; browser-node protocol tests.
