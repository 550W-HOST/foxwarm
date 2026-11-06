# Unit: Windows/macOS Native AOT CLI delivery

Files: `scripts/native-aot/publish-platform.py`, `scripts/native-aot/qualify-platform.py`, `.github/workflows/native-cli-platforms.yml`, `packages/webui/test/dotnetCliNodeAot.e2e.mjs`, `scripts/native-aot/tests/bootstrap-windows.test.mjs`
Secondary/integration references: `dotnet/Foxwarm.CliNode/Foxwarm.CliNode.csproj`, `dotnet/Foxwarm.NodePrimitives/Foxwarm.NodePrimitives.csproj`, `dotnet/Foxwarm.BrowserSupport/Foxwarm.BrowserSupport.csproj`, `.github/workflows/release.yml`, `scripts/test/test-inventory.mjs`

## Build and delivery contract

The first non-Linux targets are **win-x64** and **osx-arm64**. Their native-host jobs use Windows and Apple Silicon runners, SDK 10.0.401 and runtime/ILCompiler 10.0.12, publishing the same CLI/NodePrimitives/BrowserSupport graph as Linux. The build does not cross-compile across operating systems, build Main, change dependency versions, suppress upstream trim/AOT diagnostics or remove features. `publish-platform.py` checks host architecture and SDK before publication, retains the actual toolchain/package inventory and collects managed dependency notices.

The [distribution unit](./native-cli-distribution.md) owns archive layout, size limits, checksums and publication. Windows uses its system PowerShell and ConPTY; macOS includes the shared PTY dylib and its architecture-matched helper. The macOS inventory checks all three native images for Homebrew/build-machine dependencies. System CA trust, writable state/temp, optional external Git and an explicitly selected installed browser remain runtime dependencies. The lane does not sign or notarize packages.

The [CLI unit](./dotnet-cli-node.md) owns capability advertisement. The shared detached launcher already supports macOS exec; the CLI service gate also enables macOS Code filesystem/Git and optional PTY. A missing optional terminal backend must not remove independent services. Windows trigger artifacts use an early same-executable PowerShell entry, including managed-development dispatch, rather than requiring a POSIX shell.

## Qualification and ownership

The existing Linux entry imports `dotnetCliNodeAot.e2e.mjs`; common wire, file, exec, recovery and service assertions remain shared. Platform branches select shell commands, executable format, module inspection and native trigger entry. Windows process interruption is forceful; the probe records this separately from Unix's draining SIGTERM. In both cases the detached command must survive, finish exactly once and recover its original completion capability, with accepted ACK removing tracking.

`qualify-platform.py` runs only on Windows/macOS and creates two owned short-lived certificate pairs. The disposable hosted runner trusts only the positive certificate in its OS store, then removes that trust in `finally`. The fixture requires trusted WSS registration before independent untrusted-certificate and hostname-mismatch controls. It never disables certificate validation or contacts a standing Main. This script changes runner trust and is intended for disposable qualification environments, not installation setup.

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

Windows and macOS hosted publication/qualification have not yet run for this change. Source support, Linux managed tests and workflow lint do not qualify either target; no measured Windows/macOS row is claimed here.

On November 6, 2026, a Linux x64 Native AOT build using the pinned SDK/runtime passed the shared probe in a development execution environment, including trusted/negative TLS, files, Code filesystem/Git, PTY/Code and trigger helpers, foreground exec and background recovery/ACK. No CLR was mapped. This checks the shared-probe refactor; it is not a new distribution baseline or a Windows/macOS measurement. The execution environment did not expose `/etc/os-release`. Historical Linux distribution measurements remain in the [Linux delivery unit](./dotnet-cli-linux-aot.md).

Browser-installed operations remain qualified separately in the Linux lane. The new platform lanes check missing-browser isolation, not installed-browser support, arbitrary callbacks or every historical OS version. Interactive console parity is not established by the headless probe.
