# Local tests

The retained local test baseline uses Node.js 24, npm, Python 3, and one Chromium executable. Managed tests require a net10.0-capable .NET SDK and ASP.NET Core 10 runtime, Python 3 for fresh pinned Monty acquisition and Linux native-build prerequisites. The full managed suite also exercises the optional pinned HEIC decoder: build it into an owned directory using `dotnet/build-image-decoder.sh` and supply `prefix/lib` through `LD_LIBRARY_PATH`. CI does this in runner-temporary storage; the ordinary production image does not require or include that optional codec. Install and build both the backend packages and WebUI before running the suites:

```bash
npm ci
npm --prefix packages/webui ci
npm run build
npm run build:reference
```

Default unit tests run the managed solution plus retained Source/package tests. The application under test in full-application E2E is managed Main through the package entry; the explicit Source build remains necessary for Archive seeding and differential/reference fixtures. Default `npm run build` prepares managed Main and assets, not `lib/`. Managed entry checks run directly with `node --test scripts/main.test.js scripts/tmux-scripts.test.js scripts/windowsService.test.js scripts/source-installer.test.js`; they allocate owned data before imports, and runtime cases require the built managed output. Windows source-start/control/installer execution requires separate Windows qualification; Linux cross-publish is not that proof.

Managed WebUI Logs (fixed-file history/time lookup and its realtime topic) is not implemented at this checkpoint. The required original Logs application scenario stays enabled and currently fails against managed Main. Passing managed solution, reference, publish or image proofs does not make the complete default App/CI lane green.

## Commands

```bash
# Show every discovered test group and its owner.
npm run test:inventory

# Managed solution, Source reference, packages, WebUI unit, Python and self-tests.
npm test
# Equivalent after the build prerequisite:
npm run test:unit

# Retained Source/package unit groups only.
npm run test:reference

# Managed solution only (includes optional HEIC coverage with its prerequisite).
npm run test:managed

# Publish complete managed Main into owned artifacts and prove original App delivery.
FOXWARM_E2E_CHROMIUM=/path/to/chromium npm run test:published

# Local disposable WebUI browser fixtures, Chromium only.
FOXWARM_E2E_CHROMIUM=/path/to/chromium npm run test:webui:e2e

# Real disposable Foxwarm application, scripted loopback LLM, and Chromium.
FOXWARM_E2E_CHROMIUM=/path/to/chromium npm run test:app:e2e

# Unit, managed publish, local component-browser and full-application groups.
FOXWARM_E2E_CHROMIUM=/path/to/chromium npm run test:local
```

The runner discovers tracked test files, sorts them, and fails when an eligible test is unclassified. Backend test files and standalone self-tests import `src/testEnvironment.ts` first; script/skill tests, shared/CLI Node filesystem tests, and browser fixtures that import the backend call the same shared initializer. The web-search skill test imports a copy under owned data so its eager module-relative `.env` read cannot consume installation configuration. They receive separate disposable `FOXWARM_DATA_DIR` and operating-system temporary roots before application imports even under direct `node --test lib/<file>.test.js` or `node lib/<file>.test.js` invocation. Inherited application configuration, MCP, Agent and model-search paths cannot select installation state; models remain under the owned data root. Direct-run data and temporary roots are removed at process exit. The initializer reuses a supplied short temporary parent, including for direct subprocess tests; otherwise it creates a private temporary child under the process root. Runner-owned roots remain in artifacts and use short per-run operating-system temporary paths for Unix-domain socket compatibility. Existing tests that explicitly create their own roots keep control of those roots. Chromium fixtures retain the operating system's browser-compatible temporary directory while their logs, screenshots, and Foxwarm data remain in the run artifacts. The runner clears provider credentials, restricts proxy defaults to closed loopback endpoints, applies finite process timeouts, terminates process groups on interruption or timeout, and propagates failures.

Launcher fixtures resolve required local utilities from the invocation `PATH` before constructing their isolated executable directory, preserving missing-tool failures. When `systemd-analyze` is available, the generated user unit is verified in user scope with fixture-owned configuration and a mode-0700 `XDG_RUNTIME_DIR`; tests do not start a real service or require writable system runtime state.

Backend test shards default to `FOXWARM_SYNC_FILE_LOG=1` so short-lived test processes do not wait on an asynchronous logging transport during teardown. Their subprocesses inherit this setting unless a fixture clears it; the dedicated async logger fixture does so and still tests asynchronous writes and natural exit. An explicitly supplied `FOXWARM_SYNC_FILE_LOG` value overrides the backend default. The application logger's production default is unchanged.

The full-application harness starts managed Main through `node .` and verifies its authenticated managed health result. It uses the real compiled server and built WebUI against a generated data root, synthetic token, seeded authority files, and ephemeral ports. Clients use loopback URLs and the mock provider binds loopback. The application retains its production `0.0.0.0` listener, so run this synthetic-token fixture in a private development or CI environment rather than exposing its port to an untrusted network. A local scripted server implements OpenAI Responses SSE, Chat Completions SSE, and Responses WebSocket exchanges; only the provider network boundary is mocked. Session routing, tools, persistence, authentication, realtime delivery, and browser rendering remain production paths. Expected provider steps have exact order and counts, invalid or extra requests fail, and missing steps fail final harness verification. Explicit controls release one held incremental response and close one idle WebSocket so timing and reconnect behavior do not depend on sleeps. Failures retain application/provider/test logs plus a diagnostic screenshot and browser console.

Scenario files run in order, and the harness can stop and restart the application between them against the same data root, which the hosted image generation coverage uses to prove persisted images and canonical replay survive a real process restart. `FOXWARM_APP_E2E_FILES` or positional repository-relative scenario paths select files for focused work; a targeted run relaxes only the global request-order check and still fails on any unexpected request.

The six application-dependent WebUI scenarios (`lazyTimelineRestore`, `scrollState`, `sessionHeader`, `sessionListDrag`, `sessionListLiveRefresh`, and `systemTabs`) never use an already running installation. Their package scripts start this owned ordinary backend process directly, without Docker or a service on port 3002. For example:

```bash
FOXWARM_E2E_CHROMIUM=/path/to/chromium npm --prefix packages/webui run test:session-header-e2e
FOXWARM_E2E_CHROMIUM=/path/to/chromium node test/app-e2e/run-app-e2e.mjs packages/webui/test/systemTabs.e2e.mjs
```

Running a scenario file with raw `node --test` instead fails before reading a token or making a request unless it receives the harness's owned-runtime context. `FOXWARM_E2E_URL` and `FOXWARM_E2E_TOKEN_FILE` alone no longer select a runtime. The harness sanitizes configuration paths, managed installation/experiment settings, ports and lifetime pipes for Archive seeding as well as application/scenario children. Source `lib/session/archiveStore` is the explicit migration/seed oracle, never the application under test. Mock tool continuations require the exact paired call IDs and observed file effects rather than a particular implementation's success wording.

`node --test scripts/test/test-isolation.test.mjs` verifies the formerly unsafe configuration writers in a copied synthetic installation, with pre-existing config/models canaries at the checkout, `data_dir` pointer, and inherited environment paths. It exercises direct and preloaded entries, including `node --test lib/channels/webuiAccess.test.js lib/configHotApply.test.js`, checks that no installation state files were added, and confirms that raw browser invocations do not contact a supplied listener. It requires the normal backend build. Rebuild before invoking `lib` tests after updating source isolation imports: previously compiled JavaScript does not change with the TypeScript source.

The browser group also runs `packages/webui/test/backendIsolation.e2e.mjs`. It invokes the ordered Responses and OAuth browser tests directly with valid and malformed synthetic installation configuration, checking both unchanged config/models bytes and no added installation files. The OAuth backend child inherits its parent's owned environment before importing application modules.

Complete output, the resolved inventory, step results, browser screenshots, and disposable process data are written under a uniquely named child of `test/.temp/test-runs/`. Set `FOXWARM_TEST_ARTIFACT_DIR` to choose a different artifact parent; the runner creates a new child beneath it and does not remove or replace the supplied directory. VS Code Web extension output is restored to its exact pre-test bytes after its tests, including pre-existing local edits.

## Separately owned tests

`npm run test:inventory` keeps tests outside the routine local groups visible:

- The VS Code YAML browser test requires separately prepared VS Code and YAML-extension assets.
- Website tests remain owned by the website package and workflow.
- The Android `test.py` driver requires explicitly assigned live hardware and remains a manual hardware smoke check.
- Stateful `test/*Smoke.js` scripts remain manual checks; their entry points now allocate owned disposable data before loading the backend.
- The historical LLM serialization script remains a manual regression check; canonical shared response-formatting assertions live in the shared package suite.
- The historical ToolScript skill Agent trial remains outside the maintained baseline. Its entry point now isolates state and clears inherited provider credentials; it has no maintained synthetic provider setup and must not be used to exercise a live installation.
- Firefox-specific browser checks are manual; the routine browser baseline is Chromium-only.

Theme tests validate manifest schema, token/runtime projection, registry behavior, and rendered contrast/treatment fixtures. They intentionally do not scan source text for literal class names: that brittle policy assertion did not establish rendered theme correctness and masked exceptions by rewriting source before inspection.

The backend suite has one expected non-Windows skip for the PowerShell launcher. The image-tools suite also retains one explicitly marked future-phase todo; neither is converted into a passing assertion by the runner.

## GitHub Actions

`.github/workflows/tests.yml` runs the maintained commands in three independent Ubuntu 24.04 jobs:

- **Core, packages, and quality** sets up .NET 10, builds managed delivery plus the explicit Source reference, prepares the optional pinned HEIF test prerequisite, runs `npm run test:unit` (managed solution and retained reference/package tests), then runs Code Index and unused-code checks.
- **Chromium fixtures** sets up .NET 10 and the pinned Chrome for Testing build, builds managed delivery and Source reference, runs `npm run test:published` against an owned complete publish, then `npm run test:webui:e2e`. The publish proof covers original login/Setup, packaged Node archive/resources, real native ToolScript and Main browser screenshot/image references, plus ordinary stop/restart with preserved data.
- **Real app with mock LLM** sets up .NET 10 and the same browser/build preparation and runs `npm run test:app:e2e`.

All jobs use Node.js 24.21.0 and the official SHA-pinned setup-dotnet action for the .NET 10 SDK channel. CI Chrome is a test fixture pin, not the production Docker browser update policy. The workflow runs for pull requests and pushes to `testing` or `main`. Superseded runs for the same workflow and pull request or ref are cancelled. It also declares manual and daily 03:17 UTC triggers; GitHub registers and executes those triggers from the default branch, so pushing the workflow only to `testing` exercises the push event immediately but does not make the scheduled/manual definition available until a later authorized promotion to the default branch.

On failure or cancellation, each job retains seven-day diagnostics from its visible runner-temporary artifact parent: the runner inventory/summary, runner logs, explicit screenshots, and, for full-application E2E, its nested application/provider/test logs and screenshots. The upload patterns do not include disposable data roots, Session state, model/token configuration, request journals, browser profiles, dependencies, or the workspace.
