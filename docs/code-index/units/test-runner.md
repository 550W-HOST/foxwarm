# Unit: local-test-runner

Files: scripts/test/run-tests.mjs, scripts/test/test-inventory.mjs, scripts/test/test-process-env.mjs, docs/testing.md
Secondary files: package.json, README.md

## Purpose

Owns deterministic local test discovery, classification, data isolation, process orchestration, and artifacts for the application repository. It keeps deferred or separately owned tests visible without running them in the wrong environment.

## Commands

- `npm run test:inventory` prints every tracked test classification and fails on unclassified eligible files.
- `npm test` / `npm run test:unit` run backend, shared, CLI Node, sandbox Node (compiled and bundle tests), browser Node, script, skill, VS Code Web, WebUI unit, Python, and standalone self-test groups.
- `npm run test:webui:e2e` runs local disposable WebUI browser fixtures with one explicit Chromium configuration.
- `npm run test:local` runs the unit and local-browser groups together.

## Behavior

- Inventory rules classify tracked source tests and explicitly identify generated duplicates, full-application runtime E2E, asset-dependent VS Code E2E, website-owned tests, standalone smoke/regression scripts, and interactive skill trials.
- The runner launches backend files in small bounded shards. Node's test runner still gives each file a child process, while a preload assigns that process a separate disposable data root and short temporary path before application imports; subprocesses inherit that root unless a fixture explicitly replaces it.
- Groups, backend shards, and browser files run in sorted order with bounded concurrency and finite progress/process timeouts. Output is streamed and saved with inventory, result summaries, screenshots, and disposable data in a fresh child beneath the selected artifact parent.
- Provider credentials are cleared and proxy defaults point to closed loopback endpoints. Timeouts and interrupts terminate the active process group and produce a failing exit status.
- A caller-supplied artifact path is treated as a parent: the runner does not remove or replace it or unrelated prior artifacts.
- VS Code Web generated extension files are restored to their exact pre-test contents after the group, preserving pre-existing local bytes and removing only files created by the test command.

## Integration

The runner consumes compiled backend/package tests, source WebUI and browser fixtures, Python tests, and standalone self-test executables. Build/install prerequisites remain separate so a single build can feed repeated focused runs. The synthetic full-application harness is a separate test owner and will consume the six runtime-dependent WebUI E2E files.
