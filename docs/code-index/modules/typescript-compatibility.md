# Module: TypeScript compatibility source

The older TypeScript Main and migration readers remain in the repository for compatibility and comparison. They are not the active .NET Main architecture. The detailed source maps below describe the retained TypeScript implementation, not feature parity with .NET.

## Source maps

- [Host, configuration, access identities, HTTP, and supporting services](./infrastructure.md)
- [Channels and external ingress](./channels.md)
- [Message routing](./message-routing.md)
- [Session ownership and lifecycle](./session-core.md)
- [Context, compaction, and Archive](./session-context.md)
- [Models and provider protocols](./llm.md)
- [Tools and authorization](./tools-and-permissions.md)
- [ToolScript and managed Sessions](./scripting.md)
- [Nodes and providers](./nodes.md)

## Tests

- [TypeScript application E2E and synthetic provider fixtures](../units/full-app-e2e.md)
- [Test inventory and runners](../units/test-runner.md)

Use these maps to recover persisted shapes, external protocols, or client-facing routes. Current .NET authority, save ordering, and runtime support are owned by the .NET modules in the [overview](../overview.md).
