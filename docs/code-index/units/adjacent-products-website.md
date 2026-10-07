# Unit: Website and adjacent static product surface

Files: `website/src`

## Purpose

Owns the public website/static documentation/download surface and its build-time links to Foxwarm packages. It is adjacent to the .NET host, not a runtime route or Session authority.

## Stable navigation

Start at the website app entry and page/component folders, then follow package links to `packages/webui`, `packages/vscode-web`, or the root installer/build scripts when a page describes an implementation boundary.

## Contract and side effects

Website copy must not claim that the root launcher has switched to .NET, remote Nodes are fully integrated, or Vector/7B behavior exists merely because related documentation/assets are present. Download/install links are external product boundaries and should remain deployment-relative/configured.

## Tests

Website package checks and static build scripts; runtime/index validation is separate.
