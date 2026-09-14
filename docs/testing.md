# Local tests

Foxwarm's maintained local test baseline uses Node.js 24, npm, Python 3, and one Chromium executable. Install and build both the backend packages and WebUI before running the suites:

```bash
npm ci
npm --prefix packages/webui ci
npm run build
npm --prefix packages/webui run build
```

## Commands

```bash
# Show every discovered test group and its owner.
npm run test:inventory

# Backend, package, WebUI unit, Python, and standalone self-tests.
npm test
# Equivalent after the build prerequisite:
npm run test:unit

# Local disposable WebUI browser fixtures, Chromium only.
FOXWARM_E2E_CHROMIUM=/path/to/chromium npm run test:webui:e2e

# Real disposable Foxwarm application, scripted loopback LLM, and Chromium.
FOXWARM_E2E_CHROMIUM=/path/to/chromium npm run test:app:e2e

# Unit, local component-browser, and full-application groups in one run.
FOXWARM_E2E_CHROMIUM=/path/to/chromium npm run test:local
```

The runner discovers tracked test files, sorts them, and fails when an eligible test is unclassified. Independent unit-test files receive separate disposable `FOXWARM_DATA_DIR` roots before application imports and short per-run operating-system temporary paths for Unix-domain socket compatibility. Existing tests that explicitly create their own roots keep control of those roots. Chromium fixtures retain the operating system's browser-compatible temporary directory while their logs, screenshots, and Foxwarm data remain in the run artifacts. The runner clears provider credentials, restricts proxy defaults to closed loopback endpoints, applies finite process timeouts, terminates process groups on interruption or timeout, and propagates failures.

The full-application harness starts the real compiled server and built WebUI against a generated data root, synthetic token, seeded authority files, and loopback ephemeral ports. A local scripted server implements OpenAI Responses SSE, Chat Completions SSE, and Responses WebSocket exchanges; only the provider network boundary is mocked. Session routing, tools, persistence, authentication, realtime delivery, and browser rendering remain production paths. Expected provider steps have exact order and counts, invalid or extra requests fail, and missing steps fail final harness verification. Explicit controls release one held incremental response and close one idle WebSocket so timing and reconnect behavior do not depend on sleeps. Failures retain application/provider/test logs plus a diagnostic screenshot and browser console.

Complete output, the resolved inventory, step results, browser screenshots, and disposable process data are written under a uniquely named child of `test/.temp/test-runs/`. Set `FOXWARM_TEST_ARTIFACT_DIR` to choose a different artifact parent; the runner creates a new child beneath it and does not remove or replace the supplied directory. VS Code Web extension output is restored to its exact pre-test bytes after its tests, including pre-existing local edits.

## Separately owned tests

`npm run test:inventory` keeps tests outside the routine local groups visible:

- The VS Code YAML browser test requires separately prepared VS Code and YAML-extension assets.
- Website tests remain owned by the website package and workflow.
- The Android `test.py` driver requires explicitly assigned live hardware and remains a manual hardware smoke check.
- Stateful `test/*Smoke.js` scripts remain manual checks for an explicitly assigned disposable runtime.
- The historical LLM serialization script remains a manual regression check; canonical shared response-formatting assertions live in the shared package suite.
- The ToolScript skill Agent trial remains interactive and requires an explicitly assigned Agent and runtime.
- Firefox-specific browser checks are manual; the routine browser baseline is Chromium-only.

Theme tests validate manifest schema, token/runtime projection, registry behavior, and rendered contrast/treatment fixtures. They intentionally do not scan source text for literal class names: that brittle policy assertion did not establish rendered theme correctness and masked exceptions by rewriting source before inspection.

The backend suite has one expected non-Windows skip for the PowerShell launcher. The image-tools suite also retains one explicitly marked future-phase todo; neither is converted into a passing assertion by the runner.
