# Linux x64 Native AOT CLI Node

This recipe publishes the standalone .NET CLI Node, including its optional Linux
PTY shim. It does not build Main, frontend assets or the TypeScript CLI. The
qualified target is **Linux x64 with glibc**; this is not an ARM64 or musl recipe.

The build uses official .NET SDK 10.0.401 and runtime/ILCompiler 10.0.12 with the
UBI 9 distro compiler, headers and libraries. It copies SDK files, not the SDK
image's libc/libm. No system-library replacement or symbol shim is involved.

## Build

From the repository root, with Docker BuildKit:

```sh
mkdir -p .temp/cli-aot

docker build --platform=linux/amd64 --progress=plain \
  -f scripts/native-aot/cli-linux-x64.Dockerfile \
  --target artifact --output type=local,dest=.temp/cli-aot .
```

The output contains `Foxwarm.CliNode`, `libfoxwarm-pty.so` and native debug output.
Keep the shim beside the executable when PTY support is wanted. The CLI does not
need a .NET/ASP.NET Core runtime installed on its execution machine. It still
needs the native libraries and shell tools described below.

`SDK_IMAGE` and `BUILD_IMAGE` build arguments can select explicit official
image digests. The defaults are `mcr.microsoft.com/dotnet/sdk:10.0.401` and
`registry.access.redhat.com/ubi9/ubi:latest`. Record actual image/package versions
when qualifying a rebuild; mutable distro repositories do not promise
byte-identical future output. BuildKit leaves the publish in one output
directory, not a separate copy per runtime distro.

Do not publish this graph on a newer userspace and assume it has the same ABI.
The measured UBI 9 output requires GLIBC_2.34, unlike the previous expanded
artifact with `fmod@GLIBC_2.38`. The complete current graph does not build or run
on ordinary UBI 8. See the canonical [measured compatibility and kernel limits](../../docs/code-index/units/dotnet-cli-linux-aot.md)
for the tested distro table, failures and feature coverage.

## Runtime prerequisites

Use packages from the actual runtime distro:

- glibc 2.34 or later, its loader/libm and ordinary GCC/C++ support libraries;
- ICU (globalization is not invariant), OpenSSL and appropriate CA trust for TLS;
- Bash and normal shell utilities for native exec, `/bin/sh` for the generated
  trigger entry, and writable owned state/temporary directories;
- optional Git for Code Git services;
- optional adjacent PTY shim and a real shell for Code terminals. The Linux
  kernel must provide the existing pidfd operations, including `pidfd_open`
  (upstream Linux 5.3, subject to vendor backports);
- optional installed Chromium plus its OS libraries for browser tools. Select
  it with `PUPPETEER_EXECUTABLE_PATH` or `CHROME_PATH`; the CLI does not download
  one.

For example, Ubuntu 22.04 uses `libicu70`, `libssl3`, `ca-certificates`,
`libstdc++6`, `zlib1g` and `bash`; UBI 9 uses `libicu`, `openssl-libs`,
`ca-certificates`, `libstdc++`, `zlib` and `bash`. Install Git/Chromium only when
needed. The smoke image provisions a broader test environment and is not a
minimal production image.

Run the published CLI using the existing pairing/credential interface:

```sh
.temp/cli-aot/Foxwarm.CliNode \
  --host https://example.invalid/foxwarm --id my-node --token '<pairing-token>' \
  --credentials-file /path/to/owned-state/node-credentials.json
```

Subsequent authenticated starts may use the saved credentials. This recipe does
not change bootstrap selection, service installation or approval policy.

## Focused no-CLR smoke probe

The fixture extends the native exec lifetime check with trusted TLS, loaded
library evidence, files, cwd/status/Unicode, background recovery and ACKs,
loopback trigger, Git, PTY and the same-executable Code helper. No standing Main
or model provider is required. The fixture never falls back to another service.
It is a manual smoke entry, not a routine browser test.

The smoke image has no .NET runtime. An official Node 22 binary is installed at
`/test-driver/node` only as the test protocol driver, not on PATH or as a CLI
implementation dependency. Use an existing development checkout with installed
root Node dependencies (`ws`) available read-only at `/repo/node_modules`.

The following example tests Ubuntu 22.04. Use a fresh owned temporary directory
for the synthetic certificate and logs, and retain only what the immediate
qualification needs:

```sh
SRC="$PWD"
ARTIFACT="$SRC/.temp/cli-aot"
PROBE=$(mktemp -d)
mkdir -p "$PROBE/cert"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj /CN=localhost -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' \
  -keyout "$PROBE/cert/key.pem" -out "$PROBE/cert/cert.pem"
# Synthetic test material, readable by the nonroot container.
chmod 644 "$PROBE/cert/key.pem" "$PROBE/cert/cert.pem"

docker build --platform=linux/amd64 --progress=plain \
  -f scripts/native-aot/cli-linux-smoke.Dockerfile \
  --build-arg BASE_IMAGE=ubuntu:22.04 -t fw-cli-aot-smoke:ubuntu22 .

docker run --rm --platform=linux/amd64 \
  --network none --read-only --tmpfs /tmp:rw,exec,mode=1777 \
  --cap-drop ALL --security-opt no-new-privileges \
  --cpus 2 --memory 1g --memory-swap 1g --pids-limit 256 \
  -v "$SRC:/repo:ro" -v "$SRC/node_modules:/repo/node_modules:ro" \
  -v "$ARTIFACT:/native:ro" -v "$PROBE/cert:/cert:ro" \
  -e HOME=/tmp -e TMPDIR=/tmp \
  -e FOXWARM_CLI_EXECUTABLE=/native/Foxwarm.CliNode \
  -e FOXWARM_TEST_TLS_CERT=/cert/cert.pem -e FOXWARM_TEST_TLS_KEY=/cert/key.pem \
  -e SSL_CERT_FILE=/cert/cert.pem -e SSL_CERT_DIR=/nonexistent \
  fw-cli-aot-smoke:ubuntu22
```

If dependencies live outside the source checkout, create an empty ignored
`node_modules` mountpoint in that checkout and bind the installed root
dependencies there read-only. Do not install into a real runtime environment
merely to run the protocol peer.

Repeat with the **same artifact** and appropriate `BASE_IMAGE` values to test
other userspaces. Image/package acquisition failure is not a successful runtime
result. The fixture's JSON records the actual distro, glibc, shared host kernel,
loaded libraries and optional-feature outcome.

For PTY absence, bind only the existing executable file at
`/native/Foxwarm.CliNode` instead of the whole artifact directory, and set
`FOXWARM_TEST_EXPECT_PTY=0`. Do not rebuild a different executable. For a
representative browser run, use a Debian 13 smoke image with its official
`chromium` package and set `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`; allow
2 GiB/512 PIDs for that container. This additionally checks both built-in ARIA
selector signatures and host evaluate serialization. It does not qualify browser
packages on the other distros.

Inspect both output ELF files with `file`, `readelf -h -l -d -V` and
`objdump -T`. Direct ELF dependencies alone miss ICU/OpenSSL loaded on demand;
retain actual TLS/library and feature execution evidence too. Docker containers
share the host kernel: their distro labels and ELF GNU/Linux ABI notes do not
establish a minimum kernel or CPU.

Remove the exact owned probe images, certificate directory and intermediate
outputs when no longer needed. Do not run global Docker prune or remove another
workspace's state.
