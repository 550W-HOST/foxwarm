# Unit: VS Code Web integration assets

Files: `packages/vscode-web`

## Purpose

Builds and packages the VS Code Web filesystem, terminal, SCM, and WebUI extension assets served through the separate Code integration boundary.

## Stable navigation

The package-level build scripts compose `foxwarm-fs`, `foxwarm-terminal`, `foxwarm-scm`, and `foxwarm-webui`; the .NET project embeds selected built assets and registers capability routes through `CodeWorkbench`.

## Behavior and side effects

These assets are adjacent product code, not the authority for Session history or Git mutations. Code launch, read-only SCM, terminal, and iframe/frame-host behavior cross the [Code integration](../threads/dotnet-webui-boundary.md) boundary and should be checked against both host routes and package build outputs.

## Tests

Package tests under `packages/vscode-web/test` and subpackage scripts.
