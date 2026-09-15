# Unit: local-test-runner

Files: scripts/test/run-tests.mjs, scripts/test/test-inventory.mjs, scripts/test/test-process-env.mjs, .github/workflows/tests.yml, docs/testing.md
Secondary files: package.json, README.md

## Purpose

Owns deterministic local test discovery, classification, data isolation, process orchestration, and artifacts for the application repository. It keeps deferred or separately owned tests visible without running them in the wrong environment.

## Commands

- `npm run test:inventory` prints every tracked test classification and fails on unclassified eligible files.
- `npm test` / `npm run test:unit` run backend, shared, CLI Node, sandbox Node (compiled and bundle tests), browser Node, script, skill, VS Code Web, WebUI unit, Python, and standalone self-test groups.
- `npm run test:webui:e2e` runs local disposable WebUI browser fixtures with one explicit Chromium configuration.
- `npm run test:app:e2e` runs the real disposable application with a scripted loopback provider and Chromium.
- `npm run test:local` runs the unit, local-browser, and full-application groups together.

GitHub Actions uses those same public commands in separate core/unit-quality, Chromium-fixture, and real-application jobs. It does not introduce a workflow-only test selector.

## Behavior

- Inventory rules classify tracked source tests and explicitly identify the full-application browser owner, generated duplicates, asset-dependent VS Code E2E, website-owned tests, standalone smoke/regression scripts, live-hardware smoke drivers, and interactive skill trials.
- The runner launches backend files in small bounded shards. Node's test runner still gives each file a child process, while a preload assigns that process a separate disposable data root and short temporary path before application imports; subprocesses inherit that root unless a fixture explicitly replaces it.
- Groups, backend shards, and browser files run in sorted order with bounded concurrency and finite progress/process timeouts. Output is streamed and saved with inventory, result summaries, screenshots, and disposable data in a fresh child beneath the selected artifact parent.
- Provider credentials are cleared and proxy defaults point to closed loopback endpoints. Timeouts and interrupts terminate the active process group and produce a failing exit status.
- A caller-supplied artifact path is treated as a parent: the runner does not remove or replace it or unrelated prior artifacts.
- VS Code Web generated extension files are restored to their exact pre-test contents after the group, preserving pre-existing local bytes and removing only files created by the test command.
- The test workflow uses one Ubuntu image, exact Node and Chrome for Testing versions, read-only repository contents, ref/PR-scoped cancellation, and finite job limits. Pull requests and pushes to `testing`/`main` run directly; scheduled and manual registration follows GitHub's default-branch workflow behavior.
- Failure/cancellation uploads select only top-level runner inventory, summary, logs and screenshots plus the full-application harness's nested logs/screenshots. Disposable process data, persisted Session state, request journals, tokens/models, browser profiles, dependencies and unrelated workspace files are excluded.

## Integration

The runner consumes compiled backend/package tests, source WebUI and browser fixtures, Python tests, standalone self-test executables, and the synthetic full-application harness. Build/install prerequisites remain separate so a single build can feed repeated focused runs. Full-application ownership, including its exact scripted provider expectations, is documented in [full-application E2E](./full-app-e2e.md).
