# Unit: TypeScript compatibility and migration tests

Files: `test`

## Purpose

Preserves external/persisted compatibility fixtures for the older TypeScript Main, shared Node protocol, migrations, provider requests, WebUI payloads, and archive/catalog readers while the .NET Main replaces that runtime.

## Stable navigation

Use test names to locate the corresponding boundary: session/archive/catalog/migration fixtures for persisted data; model/request fixtures for provider wire; WebUI/channel fixtures for browser DTOs; Node/remote fixtures for transport/auth. Then follow the active .NET or package unit rather than treating the TypeScript test as current owner.

## Contract boundary

A passing compatibility test establishes a shape or migration expectation, not that the .NET runtime or root launcher has integrated the path. Keep tests that protect real persisted/external boundaries; remove historical tests that only describe retired TypeScript Main internals when the boundary is gone.
