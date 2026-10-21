# Unit: native CLI distribution

Files: `scripts/native-aot/cli-linux-musl-x64.Dockerfile`, `scripts/native-aot/cli-linux-smoke.Dockerfile`, `scripts/native-aot/pty-native-probe.c`, `scripts/native-aot/collect-notices.sh`, `scripts/native-aot/package-cli.py`, `scripts/native-aot/downloads.wrangler.json`, `scripts/native-aot/tests/test_package.py`, `scripts/native-aot/README.md`, `scripts/native-aot/PACKAGE-README.md`, `scripts/native-aot/NOTICE.md`, `.github/workflows/native-cli-node.yml`, `packages/webui/test/dotnetCliNodeAotLinux.e2e.mjs`
Secondary/integration references: `dotnet/Foxwarm.CliNode/Foxwarm.CliNode.csproj`, `dotnet/Foxwarm.NodePrimitives/Foxwarm.NodePrimitives.csproj`, `dotnet/Foxwarm.BrowserSupport/Foxwarm.BrowserSupport.csproj`, `scripts/test/test-inventory.mjs`

## Delivery contract

This lane publishes one full-featured **Linux x64 static-musl** package. The
initial asset name `native-cli-node-latest-v3.tar.gz` denotes the current core
Node protocol v3 channel; it is not a product version or a multi-platform
installer. The client offers 1–3 but this lane creates no historical aliases.
There is no bootstrap/default selection change or public Main promotion.

The build retains SDK 10.0.401-alpine3.23, runtime/ILCompiler 10.0.12, static
ICU/full data, OpenSSL and production PTY. It does not introduce feature cuts,
invariant globalization, size-optimization flags or warning suppression. Raw
`artifact` output is separate from the `distribution` target, which collects the
executable, actual builder inventory and dependency notices. Alpine repositories
remain mutable; rebuilding still needs actual-input and execution qualification.

`package-cli.py` selects named files rather than archiving raw publish output.
It includes the executable, root license, complete required notice inputs,
concise prerequisites and source/build provenance; it excludes debug files,
state, SDK/Main, Node, Chromium and Git. The **complete tar.gz**, including all
notices, must fit Workers' 26,214,400-byte per-file limit before asset staging.
Synthetic packaging tests and executable-only compression are not fit evidence.
The package source commit must match the current checkout's HEAD. Callers use a
clean committed source tree and meaningful build identity.

## Independent publication ownership

The separate `foxwarm-native-downloads` assets-only Worker owns only the
configured `/downloads/*` path and receives the complete native asset manifest.
Its assets directory is outside website output. Ordinary docs deployments cannot
replace this manifest; native publication cannot replace docs. Missing channels
return 404 without HTML fallback. No Worker script, R2, backend compiler,
update/signing/checksum service or public-download self-retention is introduced.

The intended narrow route works with Cloudflare proxying on the existing
hostname CNAME and GitHub Pages retained as documentation origin. DNS/account
setup and activation are external administrative prerequisites, not effects of
committing configuration. The existing website config and Pages workflow remain
unchanged. Account identifiers/tokens are supplied externally.

A feature-branch push trigger can run before the workflow is on the default
branch. The build job needs no publishing credentials and uploads its newly
qualified artifact; it does not rely on default-branch `workflow_dispatch`
registration. The production job is off unless the repository publication gate
is explicitly enabled for that branch, uses a protected environment, requires
account/token configuration and an exact externally reviewed Wrangler version,
and deploys only the separate downloads config. The environment name alone does
not create an approval policy; repository owners configure its protections
before enabling publication. The workflow does not create a GitHub Release.

Future native deployments still replace their whole manifest. If additional
protocol channels are later retained, approved packages must be explicit release
inputs or retired deliberately; no previous live alias is downloaded to build
the next manifest. The 30-day CI artifact is not permanent release retention.

## Qualification and notice boundaries

The workflow packages once, extracts that final archive, then runs the retained
no-CLR TLS/files/culture/exec/recovery/ACK/trigger/Git/PTY/Code-helper fixture on
its extracted executable. A separately installed Debian Chromium exercises
representative ARIA/evaluate paths. Docker supplies owned nonroot temporary
state, no network, a read-only root, dropped capabilities and explicit resource
limits. Node/`ws` implement only the loopback test peer; optional programs and
their own libraries are not release inputs.

The earlier qualified static implementation covered Alpine 3.23 without shared
ICU/OpenSSL, UBI 8 with Git and Debian 13 with Git/Chromium on one modern shared
kernel. This bounds the implementation evidence; it is not a new package's
execution proof, a minimum kernel/CPU guarantee or Windows/ARM/Main AOT support.

`collect-notices.sh` copies actual .NET/ASP.NET Core runtime-pack notices and
acquires MIT dependency notices from NuGet's pinned repository commits and
native notices from installed Alpine versions. `NOTICE.md` traces musl,
ICU/data, OpenSSL, zlib and GCC runtime exception/source obligations. Missing
notice inputs fail packaging, but collecting files does not itself establish
complete release licensing clearance. Actual link/resolved inputs and full
notice contents still need review for each real redistribution build.

## Validation entry points

- `python3 scripts/native-aot/tests/test_package.py`: owned synthetic archive,
  paths/modes/provenance, omitted debug/state inputs, only-v3 stage, whole-archive
  size rejection, missing notice failure and narrow Worker ownership.
- `dotnet build dotnet/Foxwarm.CliNode/Foxwarm.CliNode.csproj -c Release`:
  standalone managed graph, not Native AOT execution.
- Docker targets and final-package smoke commands: maintained in the native
  README/workflow. The native fixture is classified as manual smoke, not the
  ordinary WebUI/browser runner.
