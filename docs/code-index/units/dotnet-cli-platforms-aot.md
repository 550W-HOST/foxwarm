# Unit: Windows/macOS Native AOT CLI delivery

Files: `scripts/native-aot/publish-platform.py`, `scripts/native-aot/qualify-platform.py`, `.github/workflows/native-cli-platforms.yml`, `packages/webui/test/dotnetCliNodeAot.e2e.mjs`, `scripts/native-aot/tests/bootstrap-windows.test.mjs`
Secondary/integration references: `dotnet/Foxwarm.CliNode/Foxwarm.CliNode.csproj`, `dotnet/Foxwarm.NodePrimitives/Foxwarm.NodePrimitives.csproj`, `dotnet/Foxwarm.BrowserSupport/Foxwarm.BrowserSupport.csproj`, `.github/workflows/release.yml`, `scripts/test/test-inventory.mjs`

## Build and delivery contract

The first non-Linux targets are **win-x64** and **osx-arm64**. Their native-host jobs use Windows and Apple Silicon runners, SDK 10.0.403 and runtime/ILCompiler 10.0.14, publishing the same CLI/NodePrimitives/BrowserSupport graph as Linux. The build does not cross-compile across operating systems, build Main, change dependency versions, suppress upstream trim/AOT diagnostics or remove features. `publish-platform.py` checks host architecture and selects the exact SDK through a temporary invocation-directory `global.json` with roll-forward disabled (never a repository pin), retains the actual toolchain/package inventory and collects managed dependency notices.

The [distribution unit](./native-cli-distribution.md) owns archive layout, size limits, checksums and publication. Windows uses its system PowerShell and ConPTY; macOS includes the shared PTY dylib and its architecture-matched helper. The macOS inventory checks all three native images for Homebrew/build-machine dependencies. System CA trust, writable state/temp, optional external Git and an explicitly selected installed browser remain runtime dependencies. The lane does not sign or notarize packages.

The [CLI unit](./dotnet-cli-node.md) owns capability advertisement. The shared detached launcher already supports macOS exec; the CLI service gate also enables macOS Code filesystem/Git and optional PTY. Shared Code metadata supplies the Darwin stat/lstat backend as described in [native primitives](./dotnet-node-primitives.md). A missing optional terminal backend must not remove independent services. Windows trigger artifacts use an early same-executable PowerShell entry, including managed-development dispatch, rather than requiring a POSIX shell.

## Qualification and ownership

The existing Linux entry imports `dotnetCliNodeAot.e2e.mjs`; common wire, file, exec, recovery and service assertions remain shared. Platform branches select shell commands, executable format, module inspection and native trigger entry. Windows process interruption is forceful; the probe records this separately from Unix's draining SIGTERM. In both cases the detached command must survive, finish exactly once and recover its original completion capability, with accepted ACK removing tracking. Windows fixture commands record their actual PowerShell PID; teardown waits on those process handles and the PTY PID before removing the owned cwd. Status publication and accepted completion ACK are not process-exit receipts. A process that fails to exit is terminated as owned test cleanup and fails qualification; directory deletion is never retried. Original assertion errors are printed before teardown so a secondary cleanup failure cannot hide them.

`qualify-platform.py` runs only on Windows/macOS and creates two owned short-lived certificate pairs. The disposable hosted runner trusts only the positive certificate in its OS store, then removes the certificate in `finally`. macOS deletes the certificate by identity from the system keychain without the hosted-blocking `remove-trusted-cert` command; residual trust-settings metadata belongs to the discarded runner. Windows uses its elevated machine Root store: CurrentUser root import requires UI consent and cannot run in the noninteractive job. The fixture requires trusted WSS registration before independent untrusted-certificate and hostname-mismatch controls. It never disables certificate validation or contacts a standing Main. This script changes runner trust and is intended for disposable qualification environments, not installation setup. Setup commands have bounded execution, the probe has a three-minute outer deadline, and certificate deletion has a ten-second deadline. Timed-out subprocess groups/trees are terminated; existing wire-operation deadlines are not increased.

The actual extracted executable must pass:

- PE/Mach-O identity and process module snapshots without CLR/hostfxr/hostpolicy;
- registration, ordinary Unicode files and culture-sensitive directory ordering;
- Code filesystem, real Git, PTY dimensions/Unicode and capability-bound Code helper IPC;
- missing-browser diagnostics followed by usable independent core tools;
- generated same-executable trigger entry without Node/Python/.NET on helper PATH;
- foreground inherited environment/cwd, Unicode output, nonzero status and sidecars;
- detached background survival, completion after client exit, original-grant recovery/ACK and no effect replay.

`bootstrap-windows.test.mjs` additionally runs the shared PowerShell template against the complete native ZIP with Node absent from PATH. A loopback peer observes registration and saved credentials. Separate synthetic source bundles exercise unpublished/unsupported fallback and server-error rejection without consuming installation data. The real Main HTTP tests verify rendered protocol URLs; shell bootstrap tests exercise Apple Silicon selection and fallback.

Native archive upload follows successful qualification. Failure artifacts contain diagnostics only, not qualified distributions. The independent download deployment waits for every platform job; the release workflow consumes the same qualified archives and computes its ordinary aggregate checksums. Public route activation remains a separate protected operation.

## Measured results and limits

| Target | Source revision | Hosted qualification |
| --- | --- | --- |
| osx-arm64 | `501183d4` | Passed the complete extracted-package headless probe with SDK 10.0.403/runtime 10.0.14 on the Apple Silicon macos-15 runner. |

Windows has built and packaged successfully with the approved SDK/runtime, but its full executable qualification remains pending. The latest Windows Server 2025 run passed the earlier TLS/Code/PTY/trigger checks and reached foreground exec; its exact path assertion compared the runner's 8.3 TEMP alias with .NET's expanded path. The fixture now resolves its owned Windows root before constructing both inputs and expectations; environment, cwd and output assertions remain exact. The PowerShell onboarding fixture uses the same root normalization. The next Windows attempt failed during directory removal before emitting its success JSON; because teardown masked any earlier exception, that log does not establish all earlier assertions passed. Explicit process-handle waiting and pre-teardown error reporting address that fixture gap without changing independent exec lifetime.

Earlier hosted attempts exposed SDK-selection precedence, noninteractive Windows CurrentUser certificate consent, missing shared Darwin Code stat support and unbounded certificate cleanup. The current implementation selects the exact job-local SDK, uses the Windows machine Root store, supplies Darwin stat/lstat, and bounds setup/probe/cleanup. No Windows success row is recorded until the full probe and onboarding suite pass.

On November 6, 2026, a Linux x64 Native AOT build using SDK 10.0.401/runtime 10.0.12 passed the shared probe in a development execution environment, including trusted/negative TLS, files, Code filesystem/Git, PTY/Code and trigger helpers, foreground exec and background recovery/ACK. No CLR was mapped. This checks the shared-probe refactor; it is not a new distribution baseline or a Windows/macOS measurement. The execution environment did not expose `/etc/os-release`. Historical Linux distribution measurements remain in the [Linux delivery unit](./dotnet-cli-linux-aot.md).

Browser-installed operations remain qualified separately in the Linux lane. The new platform lanes check missing-browser isolation, not installed-browser support, arbitrary callbacks or every historical OS version. Interactive console parity is not established by the headless probe.
