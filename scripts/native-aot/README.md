# Standalone native CLI Node — Linux x64

This directory builds and packages the full standalone CLI Node, including native
exec/recovery, files and transfers, interactive approvals, local triggers, Code
services, PTY and installed-browser tools. Its application graph is only
`Foxwarm.CliNode` → `Foxwarm.NodePrimitives` + `Foxwarm.BrowserSupport`.
It does not build or replace Main, the TypeScript client or the website.

**The initial distribution is Linux x64 only.** It is an explicit opt-in client;
existing command generators, installers and onboarding still select TypeScript.
There is no generated .NET bootstrap or request-time AOT compiler. Retained
Shell/TypeScript, Android, browser-extension and Windows paths are unchanged.

## Build the static target

Use Docker BuildKit from the repository root:

```sh
mkdir -p .temp

docker build --platform=linux/amd64 --progress=plain \
  -f scripts/native-aot/cli-linux-musl-x64.Dockerfile \
  --target distribution --output type=local,dest=.temp/native-publish .
```

The recipe uses the full SDK `10.0.401-alpine3.23`, runtime/ILCompiler `10.0.12`,
static ICU/full data, OpenSSL and PTY. It preserves ordinary globalization and
upstream analyzer warnings; it does not introduce feature cuts, size-optimization
flags or dependency forks. No adjacent PTY library is needed. The production C
boundary probe runs with ordinary descriptor closure, seccomp-forced procfs
fallback and explicit close-all failure/reaping controls. The builder's container
policy must allow that process-local seccomp test.

`SDK_IMAGE` can select an approved official image digest; `ICU_DATA_PATH` can
select a qualified full-data path (default `/usr/share/icu/76.1/icudt76l.dat`).
SDK/runtime versions are pinned, but Alpine repositories are mutable. A rebuild
must record and qualify its actual inputs rather than claiming byte-identical
output from a tag. The original `artifact` target still exports raw publish
output, including debug files; it is not the redistribution package.

The `distribution` target exports just the executable, collected notices and
`BUILD-INPUTS.txt` (actual image input, SDK, installed Alpine packages, compiler
versions, resolved managed packages and ELF inspection). Its collector acquires
notices from exact NuGet source commits and matching native-library releases;
see [notice obligations](./NOTICE.md). It deliberately fails on missing inputs.
The runtime-pack notice files are copied from the actual restored packages.
Acquisition success is not a substitute for reviewing those inputs against the
actual resolved/link graph before the first distribution of a rebuild.

## Assemble and measure the real archive

```sh
python3 scripts/native-aot/package-cli.py \
  --publish .temp/native-publish --output .temp/native-cli-downloads \
  --source-commit "$(git rev-parse HEAD)" \
  --source-epoch "$(git show -s --format=%ct HEAD)" \
  --build-id 'local-qualified-build'
```

Use a clean, committed checkout of the public source revision. The command
checks that the supplied commit is this checkout's HEAD; use a meaningful build
identifier (CI records its run URL). Each invocation needs a fresh output stage.
No previous public download is fetched to construct a later manifest.

The only initial static asset is:

```text
.temp/native-cli-downloads/assets/downloads/native-cli-node-latest-v3.tar.gz
```

It contains one `native-cli-node-linux-x64/` directory with the executable,
Foxwarm license, dependency licenses/notices, prerequisites and build provenance.
No debug files, SDK, Main, Node, Git, Chromium, runtime state or test certificates
are archived. `package-result.json` records the measured **complete tar.gz**
size. The script rejects a result larger than Workers' 25 MiB (26,214,400-byte)
per-file limit before staging an asset. The previously measured executable-only
gzip size is not evidence that a complete package fits; only this real final
measurement establishes that.

The v3 suffix means core Node protocol v3, not product version or platform. The
client currently offers 1–3, but this publication creates **no v1/v2 aliases**.
A future incompatible artifact must not silently replace an old supported
channel. Retention of any future additional channel needs an explicit approved
package input or an explicit retirement decision; there is no self-download,
checksum/signing service, compatibility service or automatic updater.

## Qualify the extracted package

The maintained fixture `packages/webui/test/dotnetCliNodeAotLinux.e2e.mjs` needs
an explicit executable and an owned TLS certificate. It uses no standing Main or
model provider, and never falls back to a running installation. It exercises
trusted TLS plus untrusted/hostname rejection, real culture-sensitive file
ordering, files, foreground exec/cwd/status/Unicode, detached survival/recovery
and ACKs, triggers, Git, PTY and same-executable Code helpers. With an installed
browser selected, it additionally checks representative ARIA selectors/evaluate.

The publication workflow extracts the **final tar**, mounts that directory
read-only into a no-CLR Debian smoke image, and runs this fixture nonroot with
network disabled, a read-only root, owned writable temporary storage, dropped
capabilities, no new privileges and bounded resources. Node and `ws` drive only
the loopback protocol peer. They do not implement any CLI feature. Chromium/Git
are in the test image, never the release package. The image's `INSTALL_CHROMIUM=1`
option is for this Debian test lane; its default remains no browser.

For a local equivalent, follow the workflow's certificate, extraction and
`docker run` commands. Set `FOXWARM_TEST_EXPECT_STATIC=1` so the fixture requires
no mapped CLR/shared libraries in the CLI. Do not replace the real fixture with
`--help` or infer a minimum kernel from the container's userspace/ELF ABI note.
The prior same-artifact static qualification covered Alpine 3.23 (without
ICU/OpenSSL shared libraries), UBI 8 with Git, and Debian 13 with Git/Chromium on
one modern shared kernel. It does not qualify arbitrary kernels, CPU floors,
Windows, ARM, Main AOT or every browser action. A newly rebuilt release still
needs focused execution evidence against its own extracted executable.

## Independent static downloads Worker

`downloads.wrangler.json` is an **assets-only, separate Worker** named
`foxwarm-native-downloads`. Its manifest contains only the native assets stage;
website builds cannot replace it, and native builds cannot replace site assets.
There is no Worker script, R2 bucket, proxy service, cache service or backend
compiler. Missing files return 404, not an HTML fallback. Mutable latest URLs
are not marked immutable.

The intended route is `foxwarm.550w.host/downloads/*` in zone `550w.host`. The
account owner must enable Cloudflare proxying on the existing hostname CNAME
while retaining GitHub Pages as the documentation origin, then authorize this
narrow route to the downloads Worker. Do not migrate the docs or change their
workflow. Route configuration is not evidence that DNS or deployment is live;
account setup and activation remain explicit administrative actions. No account
ID or token is stored in Git. The route does not remove the `/downloads/` prefix.

## Feature-branch CI and publication gate

`.github/workflows/native-cli-node.yml` builds on pushes to the explicit
`feat/native-cli-downloads` branch. This supports the first public feature-branch
publication **without advancing Main**. `workflow_dispatch` is only an additional
trigger after GitHub recognizes the workflow on its default branch; first use
does not rely on it. A push builds/packages/qualifies the archive and uploads a
30-day Actions artifact. That temporary artifact is not indefinite retention.

Production publication is off unless repository variable `NATIVE_CLI_PUBLISH`
is exactly `true`. Before enabling it, the account/repository owner must:

1. Review the public source, actual complete archive size, acquired notice bundle
   and extracted-package qualification; resolve actual DNS/route prerequisites.
2. Configure the `native-cli-downloads` GitHub environment with the intended
   approval/branch protections. A bare environment name does not itself require
   human approval; configure protection before enabling the repository gate.
3. Supply `CLOUDFLARE_ACCOUNT_ID` as a variable and `CLOUDFLARE_API_TOKEN` as a
   protected secret. Creation/route setup needs the appropriate account/zone
   permissions; do not assume an existing docs token can create this Worker.
4. Set `NATIVE_CLI_WRANGLER_VERSION` to an exact reviewed, supported `x.y.z`
   version. The job rejects missing configuration or a floating version before
   invoking the CLI. Wrangler is acquired only in the gated publishing job.
5. Enable the repository gate before the approved feature-branch push (or rerun
   the full workflow after configuration). Review/protect this branch because
   its workflow is the deployment producer. Nothing here pushes public source
   or changes default-branch selection automatically.

The gated job downloads this run's qualified artifact and invokes `wrangler
deploy` with only the separate downloads config. Enabling that job is production
activation, including the configured narrow route, not a dry run. For an
account-owner preview, `wrangler versions upload --config
scripts/native-aot/downloads.wrangler.json` uploads a version without deploying
it; preview version URLs are public, not private staging storage.

After approved activation, verify the canonical anonymous v3 download,
non-HTML/archive content, extraction, executable mode and in-package provenance.
Verify the site root, `/docs/`, installers, search and custom 404 still reach
GitHub Pages; confirm another ordinary docs deployment leaves the download
available. Until those checks pass, source/config preparation is not a live
publication claim and no user-facing website download link is added.

## Focused source-only checks

```sh
python3 scripts/native-aot/tests/test_package.py
npm run quality:code-index
dotnet build dotnet/Foxwarm.CliNode/Foxwarm.CliNode.csproj -c Release
```

Packaging tests use tiny synthetic files and owned temporary paths. They test
archive contents/modes/provenance, omission of unwanted inputs, channel staging,
size rejection, missing notices and Worker ownership. They do not establish a
real artifact's final size, license clearance or Native AOT execution behavior.
