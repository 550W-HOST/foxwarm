# Managed tests and source oracles

The [maintained test runner](../../docs/testing.md) owns the ordinary managed, reference, browser and full-application lanes. Run commands below from the repository root with a .NET 10 SDK selected. Build the retained TypeScript reference before source-backed tests:

```sh
npm run build:reference
npm run test:managed
```

For a focused managed check, use `FOXWARM_TS_ROOT="$PWD" dotnet test dotnet/Foxwarm.Tests/Foxwarm.Tests.csproj --filter FullyQualifiedName~TestClass`. Tests use owned temporary data; `FOXWARM_TS_ROOT` identifies the built reference checkout, not an installation data root. See the [test contract map](../../docs/code-index/units/dotnet-tests.md) for subsystem navigation.

## Source assets and consumers

- Feature directories contain xUnit tests and feature-local fixtures such as MCP peers, Python exec peers and ToolScript JSON. Their project copy rules remain local to those consumers.
- `Fixtures/` contains the cross-runtime TypeScript producers, controlled SDK/channel/browser peers, SQL seeds and parity corpora. Session/Archive, catalog, image, tool, timer and Vector tests invoke these files directly; original-App drivers also use the catalog/history/Archive seeds. Some oracles execute frozen `git show` source. Their recorded revision/path pairs continue to identify historical source, not the current directory layout.
- `scripts/` contains differential runners/comparators, the standalone HTTP/restart driver, and `qualify-*.mjs` controlled-host checks. These are focused entry points, separate from the normal suite's discovery.
- `../Foxwarm.DevTools/` implements managed probe commands. Its build copies `Fixtures/parity-corpus.json` and `Fixtures/responses-stream-corpus.json` under their existing output names so the commands also work without an explicit corpus argument.
- `../scripts/` contains build/publish/source-generation helpers. Optional HEIC preparation is documented in [native image prerequisites](../../docs/native-image-prerequisites.md).

## Differential checks

Build the solution and reference first:

```sh
dotnet build dotnet/Foxwarm.sln
npm run build:reference
export FOXWARM_TS_ROOT="$PWD"
python3 dotnet/Foxwarm.Tests/scripts/run-parity.py
python3 dotnet/Foxwarm.Tests/scripts/responses-request-parity-compare.py
python3 dotnet/Foxwarm.Tests/scripts/responses-stream-parity-compare.py --self-test-negative
python3 dotnet/Foxwarm.Tests/scripts/parity_compare_checks.py
```

The conditional-memory/argument differential uses `Fixtures/parity-corpus.json` and the actual TypeScript owners. Its comparator distinguishes semantic JSON, generated JSON, exact raw text and compatible native parse diagnostics. The Responses request differential invokes the actual reference converter and compares request input, including exact field presence and tool-output formatting. The streaming differential uses real string/Buffer chunks, including split UTF-8/CRLF framing, and compares completion, cumulative progress, safety, raw text, SSE blocks and normalized errors. Provider terminal messages are checked against the source-derived message, while native malformed-parser/read diagnostics retain their compatibility categories. Negative comparator checks reject missing fields, wrong counts, bool/number substitutions, missing completion and late errors.

The managed stream probe omits null defaults only from its typed progress parts, retaining zero indices and empty strings. Provider-owned final/unknown JSON keeps exact field presence, including explicit null. The comparator also checks part lifecycle: a part created before its text exists remains observable rather than being discarded as a serialization difference.

The TypeScript runners for conditional memory and streaming use `FOXWARM_TSX` when supplied; otherwise they invoke the pinned `tsx@4.19.2` through npx. The Responses request oracle uses the built reference directly. Responses wrappers establish owned temporary data, suppress console logging, require successful whole-stdout JSON and bound the subprocess lifetime. These checks do not contact a model provider.

## Controlled-host checks

```sh
python3 dotnet/Foxwarm.Tests/scripts/host-e2e.py
node dotnet/Foxwarm.Tests/scripts/qualify-onboarding-address.mjs
```

The HTTP driver uses the Debug host output, disposable data, a synthetic local provider and clean process restarts. Its missing/corrupt idle-authority checks keep the host and catalog list available, then require semantic admission to fail without provider work, authority recreation or Archive reconstruction. Mandatory recovery startup failures are covered separately by the managed admission and original-App recovery tests. Qualification scripts use their existing owned-host/peer setup; feature-specific requirements and evidence live in the corresponding Code Index unit. The optional `Fixtures/qqbot-browser.mjs` peer is launched by `QQBotHostTests` with `FOXWARM_QQBOT_BROWSER=1` after the original WebUI is built and Chromium is available.

Fault/hold tests use internal construction callbacks or owned SQL triggers; the normal host has no marker-file control protocol. Fixed identity-copy/finishing crash checkpoints use the existing DevTools `session-restart` harness. Normal launcher/App tests remain separate from exact held-write owner tests; their split does not qualify the former combined launcher-loss/deadline fault timing.
