# Unit: Linux x64 Native AOT CLI delivery

Files: `scripts/native-aot/cli-linux-x64.Dockerfile`, `scripts/native-aot/cli-linux-smoke.Dockerfile`, `scripts/native-aot/cli-linux-musl-x64.Dockerfile`, `scripts/native-aot/pty-native-probe.c`, `scripts/native-aot/README.md`, `packages/webui/test/dotnetCliNodeAotLinux.e2e.mjs`
Secondary/integration references: `dotnet/Foxwarm.CliNode/Foxwarm.CliNode.csproj`, `dotnet/Foxwarm.NodePrimitives/Foxwarm.NodePrimitives.csproj`, `dotnet/Foxwarm.BrowserSupport/Foxwarm.BrowserSupport.csproj`, `scripts/test/test-inventory.mjs`

## Build and compatibility contract

The separate [CLI Node](./dotnet-cli-node.md), shared native primitives and BrowserSupport are the entire application build graph. The recipe uses official .NET SDK 10.0.401 with runtime/ILCompiler 10.0.12 and an ordinary UBI 9 compiler/linker/libc environment. It does not build Main, frontend assets or the TypeScript CLI. SDK files are copied from the Microsoft image; native compilers, headers and libraries come from the builder distro. Runtime behavior and project globalization/serialization settings are unchanged. There are no symbol-version shims, replacement system libraries, warning suppressions or additional runtime packages in the project graph.

The default recipe qualifies Linux **x64/glibc**; the explicitly selected static-musl build is qualified separately below. Docker callers can explicitly select `--platform=linux/amd64`; the recipe is not an ARM build or Main Native AOT delivery lane. Image arguments permit caller-controlled image/digest selection. Package repositories can update, so a future rebuild still needs its own actual ABI and execution checks.

The measured UBI 9 build uses clang 21.1.8, GCC 11.5 and glibc 2.34. Its executable is ELF64 x86-64 PIE, dynamically linked through `/lib64/ld-linux-x86-64.so.2`. Direct `DT_NEEDED` entries are `libm.so.6`, `libc.so.6` and `ld-linux-x86-64.so.2`. Both executable and `libfoxwarm-pty.so` require at most **GLIBC_2.34**; the shim directly needs libc. This is an ABI floor for these artifacts, not proof that all glibc 2.34 systems supply every runtime dependency or kernel feature. The previous expanded CLI artifact had `fmod@GLIBC_2.38`; this build resolves `fmod@GLIBC_2.2.5` without changing runtime code.

Upstream PuppeteerSharp analysis warnings remain visible. The measured recipe emits IL2104 and IL3053 assembly summaries and IL3000 for BrowserFetcher; prior detailed native analysis is described in the [browser unit](./dotnet-cli-browser.md). Successful bounded browser checks do not qualify arbitrary CLR callbacks, DTOs or future package branches.

## Measured userspaces

On October 21, 2026, the **same published executable and shim**, without per-distro rebuilding, ran the focused native fixture on these official image userspaces:

| Userspace | glibc | Core, TLS, helpers, Git and PTY | Installed-browser proof |
| --- | --- | --- | --- |
| UBI / RHEL 9.8 | 2.34 | Passed | Not provisioned |
| Ubuntu 22.04.5 | 2.35 | Passed | Not provisioned |
| Ubuntu 24.04.5 | 2.39 | Passed | Not provisioned |
| Debian 12 (bookworm) | 2.36 | Passed | Not provisioned |
| Debian 13 (trixie) | 2.41 | Passed | Chromium 155.0.8059.79: passed representative ARIA/evaluate checks |
| UBI / RHEL 10.2 | 2.39 | Passed | Not provisioned |
| Fedora 43 | 2.42 | Passed | Not provisioned |
| UBI / RHEL 8.10 | 2.28 | Failed before registration: loader lacks GLIBC_2.29, GLIBC_2.32 and GLIBC_2.34 | Not run |

A separate Ubuntu 22.04 run mounted only the identical executable, without the PTY shim. It omitted `vscode-pty` while registration, TLS, files, exec, recovery, Git and trigger helpers still passed. Missing-browser errors likewise left core tools usable on the rows without Chromium. These are separate optional dependency outcomes, not proof of browser support on every listed distro.

The ordinary UBI 8.10 **build** also failed: the SDK and restore worked, but the existing C PTY source could not compile against its headers/libc (`SYS_pidfd_open`, `posix_spawn_file_actions_addchdir_np`, `posix_spawn_file_actions_addclosefrom_np`). `addclosefrom_np` requires glibc 2.34. The baseline therefore remains UBI 9; no lower-feature build tier or PTY compatibility fork is introduced.

## Runtime requirements and kernel limits

- The executable includes its reachable .NET code; no .NET/ASP.NET Core shared framework is installed in the runtime images and the fixture verifies no `libcoreclr` mapping in the actual client processes.
- ICU is required because invariant globalization is not enabled. The actual mapped ICU versions span 67.1, 70.1, 72.1, 74.2, 76.1 and 77.1 across the tested userspaces. The distro C++/GCC support libraries and compression dependencies must also remain available; `DT_NEEDED` alone does not enumerate dynamically loaded dependencies.
- TLS needs distro OpenSSL libraries and a usable CA trust source. Every passing row made a real WSS connection to an owned, trusted certificate fixture with certificate validation enabled; maps include libssl/libcrypto 3. Ordinary deployment needs its own appropriate CA trust. No host libc, OpenSSL or ICU is injected into another distro.
- Native exec uses Bash and ordinary shell utilities. The trigger's generated shell entry uses `/bin/sh` and re-enters the same executable; detached paths/status helpers also use that executable, not Node, Python or a .NET host. State and local helper IPC require writable owned directories, including temporary storage.
- Git remains an optional external executable for Code Git services. The fixture uses each distro's real Git, not a bundled replacement.
- PTY requires the adjacent `libfoxwarm-pty.so`, a real shell, temporary IPC and the existing Linux syscalls. `pidfd_open` is mandatory at spawn (upstream Linux 5.3); failure kills/reaps the child rather than falling back. Shell signalling uses `pidfd_send_signal`. Vendor kernel backports can differ, and a loaded shim does not establish that PTY creation will work.
- Chromium and its matching distro libraries are optional and separately provisioned. CLI executable selection and no-download behavior remain owned by the browser adapter. The representative Debian 13 proof does not qualify all browser actions/distributions.

Every container above shared the same **6.12.101+deb13-amd64** host kernel. No older kernel/VM matrix or minimum CPU execution probe was run. The ELF GNU/Linux 3.2 ABI note is not a whole-program minimum-kernel guarantee. ARM64, Windows, macOS, Main Native AOT and unlisted distro versions remain unqualified. This dynamic matrix does not qualify musl; the separate static result is below.

## Probe and ownership boundaries

`dotnetCliNodeAotLinux.e2e.mjs` extends the maintained focused native exec probe rather than substituting an analyzer or `--help` check. It uses an explicit native executable, owned temporary state and a loopback HTTPS/WebSocket peer. It verifies:

- authenticated registration over trusted TLS, native executable identity and ICU/OpenSSL maps;
- ordinary file write/read and Unicode; foreground native exec with inherited environment, cwd, final cwd sidecar, nonzero status and Unicode output;
- an independently surviving background command, same-executable status/path helper after client exit, original-grant recovered completion and accepted ACK removing tracking without replaying the one effect;
- loopback trigger and actual generated same-executable shell entry;
- representative real Git, PTY dimensions/Unicode and capability-bound same-executable Code helper;
- optional PTY absence, missing-browser isolation and, when explicitly provisioned, browser ARIA query-one/query-all and host evaluate serialization.

The smoke Dockerfile contains no .NET runtime. Its explicit `/test-driver/node` drives only the test protocol peer and is not placed on PATH. Repo fixtures and installed test dependencies are mounted read-only. Tests run nonroot with network disabled, a read-only root, owned executable temporary storage, dropped capabilities, no new privileges and explicit Docker memory/CPU/PID limits. They do not contact standing Main instances or use installation configuration/tokens/data. The [test inventory](./test-runner.md) classifies this fixture as a manual smoke check, not a routine browser job requiring an unavailable native artifact and certificate.

Public build/probe instructions in `scripts/native-aot/README.md` describe the commands and environment inputs. This is a focused packaging qualification; it neither replaces the existing complete CLI interoperability suites nor changes bootstrap selection.

## Explicit static-musl qualification

`cli-linux-musl-x64.Dockerfile` is a separate CLI-only publication using official SDK 10.0.401-alpine3.23/runtime 10.0.12 and native Alpine static archives. It sets `StaticExecutable`, `StaticICULinking`, `StaticOpenSslLinking` and `EmbedIcuDataPath`; globalization stays non-invariant. The explicit `FoxwarmStaticMusl` project property requires a static linux-musl-x64 Native AOT CLI publication, statically links the production PTY object and makes libc/PTY imports direct. It does not change default dynamic or managed publication, Main, bootstrap or dependency versions. An ELF static PIE may have a relocation DYNAMIC segment; the relevant loader checks are absence of PT_INTERP and DT_NEEDED, plus actual runtime library-load evidence.

Musl lacks the close-from spawn action used by the unchanged glibc path. Only this static target selects the bounded native spawn prelude described in [native primitives](./dotnet-node-primitives.md). The small native probe compiles against the actual production C source, checks cwd/session/signal defaults and parent-mask retention, sparse inherited descriptors with concurrent parent fd churn, PATH/permission/cwd errors, resize, read/write cancellation, closed parent stdio, exact reaping and descriptor release. An inherited seccomp filter forces real close_range ENOSYS/procfs fallback and separately verifies synchronous error/reap when procfs enumeration is denied. It is a manual smoke entry, not a general native test framework.

The maintained protocol probe accepts `FOXWARM_TEST_EXPECT_STATIC=1` to require no mapped shared libraries instead of the default positive dynamic ICU/OpenSSL assertions. Both modes establish trusted registration before rejected untrusted/hostname controls, and the real file-read directory comparer must order `a`, `ä`, `z` using its existing en-US culture. The optional `FOXWARM_TEST_EXPECT_GIT=0` is a dependency-absence run only; a separate run with real external Git remains necessary. Alpine smoke images can omit Git with `INSTALL_GIT=0` to avoid bringing its OpenSSL dependency into that absence run. The driver image must match the runtime userspace, for example an official Alpine Node image for Alpine.

### Measured full static artifact

On October 21, 2026, the full CLI-plus-PTY graph built on Alpine 3.23.6/musl 1.2.5-r23 with clang 21.1.2/GCC 15.2, static ICU 76.1 and OpenSSL 3.5.9. The stripped executable is **60,061,360 bytes**, ELF64 x86-64 static PIE, with no PT_INTERP, DT_NEEDED or adjacent PTY shared object. SDK/runtime/ILCompiler remain 10.0.401/10.0.12. The existing PuppeteerSharp IL2104, IL3000 and IL3053 diagnostics remain visible and unsuppressed. No feature-deleted executable, TLS relaxation, invariant globalization or dependency fork was used.

The same executable, without rebuilding, passed these focused userspace checks:

| Userspace | Full core/TLS/culture/helpers/recovery/PTY probe | Optional external services |
| --- | --- | --- |
| Alpine 3.23.6, with all discovered ICU/OpenSSL shared-library files removed | Passed; no CLR or shared-library mappings | Git and Chromium intentionally absent; missing browser remained isolated |
| UBI / RHEL 8.10 | Passed, including where the dynamic artifact could not load | Real Git 2.43.7 passed; browser not provisioned |
| Debian 13.7 | Passed | Real Git 2.47.3 and Chromium 155.0.8059.79 passed representative ARIA query-one/query-all and evaluate checks |

Each row proves trusted registration, untrusted and wrong-host rejection before WebSocket upgrade, real en-US `a`/`ä`/`z` directory collation, Unicode files, foreground inherited environment/cwd/exit 7 and native sidecars, independent background survival after client exit, same-executable status helpers, original-capability recovery/ACK removal without replay, generated trigger entry, PTY dimensions/Unicode and the capability-bound Code helper. Rejected certificates produced a peer secureConnection followed by TLS close without upgrade, not a tlsClientError event. The probe observes that real lifecycle rather than treating an arbitrary client failure as certificate evidence.

The actual-musl native boundary probe also passed all three modes: ordinary close_range, real seccomp-forced ENOSYS/procfs fallback, and synchronous close-all failure with reaping. The last check runs in a fresh owned process because BusyBox timeout itself owns a live watchdog child; before/after ECHILD plus exact fixture-process wait preserve the failed-child cleanup assertion without claiming every wrapper child belongs to PTY.

Process maps at registration, after services/exec and after recovery show only the executable and, in glibc userspaces, optional OS timezone data. A process-following Alpine trace found zero ICU/OpenSSL/PTY shared-library open attempts across all processes, while the driver remained usable without those files. The Debian trace followed fork/clone/exec ancestry: the CLI and every re-entered native helper had zero shared-library open attempts; observed shared-library searches belonged to the separate driver, shells, Git, Chromium or utilities, with no unattributed records. Thus direct ELF inspection is backed by actual TLS/globalization/PTY/helper execution and library-open evidence, not only a startup check.

The containers ran nonroot with read-only roots, network disabled, dropped capabilities, no new privileges, owned writable temporary storage and explicit resource bounds. They all shared host kernel **6.12.101+deb13-amd64**. Neither the userspace table nor static linkage establishes an older-kernel/CPU minimum, arbitrary browser-action qualification, Windows/ARM support, Main Native AOT support or complete CLI parity. The previous dynamic matrix remains valid for that different artifact and was not rerun.

### Remaining dependencies and maintenance

Static means the measured CLI/helpers do not require runtime libc/ICU/OpenSSL/PTY shared libraries or a .NET host. It does not bundle Bash, `/bin/sh`, shell utilities, optional Git/Chromium or their own distro dependencies. TLS still needs appropriate CA trust data; process inspection/cwd uses procfs, and native descriptor closure requires usable close_range or its procfs fallback. Writable owned state/temp and the existing mandatory pidfd kernel operations remain necessary. Timezone data can remain an ordinary OS data dependency.

Static ICU/OpenSSL/native-library security fixes require rebuilding and redistributing the executable; updating a runtime `.so` does not update embedded code/data. Preserve the applicable .NET and native third-party licenses/notices, including musl, ICU/data, OpenSSL and compiler support libraries. This trial has not assembled a redistribution notice bundle or performed a release licensing audit. Image/package selection, notice collection and future updates remain release responsibilities; no new release/bootstrap switch or deployment is implied.

Historical failed attempts were retained: unavailable generic SDK image tag, missing musl close-from spawn action, an invalid wrapper-wide reaping assertion, a nonroot-inaccessible exported directory, and an overly narrow tlsClientError-only test observer. The corrected full artifact passed without a subsequent production-runtime change.
