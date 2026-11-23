# Managed tests and source oracles

The [maintained test runner](../../docs/testing.md) owns the ordinary managed, browser and full-application lanes. Run commands below from the repository root with a .NET 10 SDK selected, after `npm run build`:

```sh
npm run build
npm run test:managed
```

For a focused managed check, use `FOXWARM_REPO_ROOT="$PWD" dotnet test dotnet/Foxwarm.Tests/Foxwarm.Tests.csproj --filter FullyQualifiedName~TestClass`. Tests use owned temporary data; `FOXWARM_REPO_ROOT` identifies the built repository checkout (Node packages, WebUI output, Skills and frozen-source Git history), not an installation data root. See the [test contract map](../../docs/code-index/units/dotnet-tests.md) for subsystem navigation.

The reference checkout also needs Git history: nine fixture producers read pinned ancestor revisions with `git show` (session creation, task policy, tool authorization, onboot, command administration, canonical entry, session command effects, inbound channel files and session presentation; the last two are pinned to the final TypeScript revision `80f740477c25d3b42165bb0d201e74ebc5fd4479`). Use a full-history clone, or run `git fetch --unshallow` in an existing shallow clone before these comparisons. The managed CI checkout uses `fetch-depth: 0`. The current build supplies shared packages and the `typescript` compiler the fixtures use to transpile frozen sources; it does not supply historical Git objects. Missing revisions fail the comparisons.

The full-Unicode lowercase oracle and `dotnet/scripts/generate-source-lowercase.mjs` require a Node runtime with Unicode 17.0 data; use Node 24.21.0, matching CI. Both entry points reject other Unicode versions before comparison or generation. With that runtime on PATH, `node dotnet/scripts/generate-source-lowercase.mjs` regenerates all three checked-in lowercase/property tables; then run the repository C# formatter with `(cd dotnet && dotnet csharpier format .)`. Ordinary builds use those tables without rewriting metadata or generating from the host runtime. The full-scalar/contextual comparison and normal Main HTTP metadata-search controls exercise the same lowerer.

## Source assets and consumers

- Feature directories contain xUnit tests and feature-local fixtures such as MCP peers, Python exec peers and ToolScript JSON. Their project copy rules remain local to those consumers.
- `Fixtures/` contains frozen-source and platform JavaScript oracles, controlled SDK/channel/browser peers, schema-level seeds, recorded state snapshots (`snapshots/`, restored by `state-snapshot.mjs`) and parity corpora. Session, catalog, image, tool, timer and Vector tests invoke these files directly; original-App drivers also use the Archive, Worker-store and snapshot seeds. Some oracles execute frozen `git show` source. Their recorded revision/path pairs continue to identify historical source, not the current directory layout.
- `scripts/` contains the standalone HTTP/restart driver and `qualify-*.mjs` controlled-host checks. These are focused entry points, separate from the normal suite's discovery.
- `../Foxwarm.DevTools/` implements managed probe commands. Its build copies `Fixtures/parity-corpus.json` and `Fixtures/responses-stream-corpus.json` under their existing output names so the commands also work without an explicit corpus argument.
- `../scripts/` contains build/publish/source-generation helpers. Optional HEIC preparation is documented in [native image prerequisites](../../docs/native-image-prerequisites.md).

TypeScript-era data comes from schema-level seeds and snapshots recorded at the final TypeScript revision; no test runs the TypeScript backend to write it. Results recorded from TypeScript owners (`Vector/Fixtures/`, `Channels/Fixtures/webui-logs-source.json`, `Fixtures/vision-input-fixture.mjs`) carry the inputs they apply to. Returning current installation data to retired TypeScript Main is outside the [compatibility boundary](../../docs/code-index/units/dotnet-tests.md#contract-boundary).

## Probe corpora

`Fixtures/parity-corpus.json` (conditional memory and model arguments) and `Fixtures/responses-stream-corpus.json` (Responses SSE framing) are the default inputs of the DevTools `conditional-memory` and `responses-stream` probes. Their TypeScript differential runners were removed with the TypeScript backend; the corpora remain inputs for managed probes and tests.

## Controlled-host checks

```sh
python3 dotnet/Foxwarm.Tests/scripts/host-e2e.py
node dotnet/Foxwarm.Tests/scripts/qualify-onboarding-address.mjs
```

The HTTP driver uses the Debug host output, disposable data, a synthetic local provider and clean process restarts. Its missing/corrupt idle-authority checks keep the host and catalog list available, then require semantic admission to fail without provider work, authority recreation or Archive reconstruction. Mandatory recovery startup failures are covered separately by the managed admission and original-App recovery tests. Qualification scripts use their existing owned-host/peer setup; feature-specific requirements and evidence live in the corresponding Code Index unit. The optional `Fixtures/qqbot-browser.mjs` peer is launched by `QQBotHostTests` with `FOXWARM_QQBOT_BROWSER=1` after the original WebUI is built and Chromium is available.

Fault/hold tests use internal construction callbacks or owned SQL triggers; the normal host has no marker-file control protocol. Fixed identity-copy/finishing crash checkpoints use the existing DevTools `session-restart` harness. Normal launcher/App tests remain separate from exact held-write owner tests; their split does not qualify the former combined launcher-loss/deadline fault timing.
