# Release packages

Foxwarm releases are prebuilt packages. Installing one compiles nothing and needs neither Node.js nor the .NET SDK.

## Packages

| Asset | Contents |
| --- | --- |
| `foxwarm-linux-x64.tar.gz` | Server for Linux x64; runs on the installed ASP.NET Core 10 runtime |
| `foxwarm-linux-x64-self-contained.tar.gz` | Server for Linux x64 including the .NET runtime |
| `foxwarm-osx-arm64.tar.gz` | Server for Apple Silicon Macs; runs on the installed ASP.NET Core 10 runtime |
| `foxwarm-osx-arm64-self-contained.tar.gz` | Server for Apple Silicon Macs including the .NET runtime |
| `foxwarm-win-x64.zip` | Server for Windows x64; runs on the installed ASP.NET Core 10 runtime |
| `foxwarm-win-x64-self-contained.zip` | Server for Windows x64 including the .NET runtime |
| `foxwarm-desktop-win-x64.zip` | Windows desktop app including the .NET runtime |
| `SHA256SUMS` | SHA-256 checksums of the assets |

Asset names carry no version, so `releases/latest/download/<asset>` always names the newest release; each archive has a single top-level directory such as `foxwarm-0.9.0-linux-x64/`. Every package contains `release.json` (version, target, runtime identifier, whether it is self-contained, its asset name and source commit). Server packages also contain the installation control script: `foxwarmctl` on Linux and macOS, `foxwarmctl.ps1` and `foxwarmctl.cmd` on Windows.

Each server package is the complete published Core: WebUI, skills, templates, Node client bundles, browser and Code extensions, artifact compiler resources, ToolScript worker and native libraries for its platform. Artifact preparation still runs the collected compiler under a `node` found on `PATH`; it is optional at runtime. The Code workbench assets and HEIF decoders remain separate optional installations.

macOS packages require **macOS 15 or later**, following the [.NET 10 supported operating systems](https://github.com/dotnet/core/blob/main/release-notes/10.0/supported-os.md). They use the system ICU and Apple cryptography libraries; no Homebrew ICU or OpenSSL installation is required. The native qualification checks bundled dylibs and entry executables for Homebrew library dependencies. Intel Macs and macOS Desktop are not packaged. These archives are not signed or notarized as distribution packages; browser downloads can carry Gatekeeper quarantine. See the [installation guide](https://foxwarm.net/docs/installing/#macos-apple-silicon) before using a browser-downloaded archive. The curl installer does not add quarantine.

## Installed layout

```text
foxwarm/
  data_dir             data-directory pointer (same meaning as in a source checkout)
  foxwarmctl           control script copied from the selected release
  runtime/0.9.0/       extracted release
  runtime/current      symlink (Windows: junction) to the selected release
```

Main runs with `--installation-root` set to the program directory, so `data_dir` and relative settings resolve there. Framework-dependent packages start `dotnet Foxwarm.dll` with the `dotnet` found on `PATH`, because the apphost does not search `PATH` for a runtime installed outside the default location. Self-contained packages start their apphost.

`foxwarmctl update` and a rerun of the installer use the same sequence as a source restart: extract and run the new release's `--inspect-upgrade` while the old Main keeps running, stop Main (SIGKILL on Linux/macOS or process termination on Windows after 60 seconds), select the new release, start it if Main had been running, then delete every other release. A blocked inspection or failed download leaves the installation unchanged.

On Linux and macOS, start uses tmux when available. Main runs as the process of one pane in window `foxwarm` of the tmux session `foxwarm` (`FOXWARM_TMUX_SESSION`), with `remain-on-exit` on that pane so an early exit stays visible. The control script recognizes its Main as the live pane in that window whose current directory is the program directory, and stops, restarts or removes only that pane: other windows in the session, and other panes in that window, are left alone. If another program holds the window, start refuses and stop/update do not touch it; set `FOXWARM_TMUX_SESSION` to run the installation in another session.

Without tmux, start uses `nohup` with closed terminal input and appends output to `state/logs/foxwarm.stdout.log` and `foxwarm.stderr.log` in the data directory, so Main survives terminal/SSH hangups. In this mode, `attach` prints the log paths. Both Unix modes write Main's PID to `foxwarm.pid` in the program directory. Status, stop, restart and update ignore a stale PID unless it still identifies this installation's Main; tmux pane discovery also recognizes older installations without a PID file. `status` prints `Running (PID N), release ...` followed by the launch mode and exits 0 when running, or 3 otherwise.

Windows uses the background launch and the data-root-specific control pipe of the [Windows controls](code-index/units/windows-service-scripts.md).

## Building

`scripts/release/package.mjs` publishes the packages from built delivery assets:

```bash
npm ci && npm --prefix packages/webui ci
node scripts/release/package.mjs --build-assets --output dist
node scripts/release/package.mjs --output dist --target linux-x64   # one package
```

A Linux x64 host builds the Linux and Windows targets. macOS arm64 targets must be built on an Apple Silicon macOS host: Clang builds the Darwin PTY library and its controlling-terminal helper during publish. With no `--target`, macOS selects its two server variants and Linux selects the Linux and Windows targets. Windows packages are cross-published; the script installs the locked target-native esbuild and sharp packages (verified against `package-lock.json`) beside the host ones so the artifact runtime collector can find them. Tar archives use Python 3 on both GNU and BSD hosts, with sorted entries, commit timestamps, numeric root ownership and a fixed gzip header. `--directory-only` leaves the published directories under `dist/.work` instead of archiving them.

`scripts/release/smoke-server.sh PACKAGE [PORT] [--without-tmux]` and `scripts/release/smoke-server.ps1 -Package FILE [-Port N]` install a package into a temporary directory with the real installer, then check startup, the sign-in page, status, a forced reinstall through `update`, release cleanup and stop. `scripts/release/release-install.test.js` covers the Linux installer and control script with fixture packages, including tmux pane isolation, detached background lifecycle, launcher hangups, stale PIDs and checksum-tool fallback. `scripts/release/package.test.mjs` covers portable archives, merged checksums, macOS installer selection and the `shasum` fallback. The macOS smoke uses system Bash 3.2 and BSD utilities, with tmux and with a system-only PATH that excludes tmux; the self-contained background smoke also excludes `dotnet`.

## Publishing a release

The **Release packages** workflow builds all packages on every push to `testing` and `main` and qualifies them:

- the Linux framework-dependent package on the runner, and the self-contained package on Ubuntu 22.04 without .NET;
- both macOS arm64 packages, built on the official `macos-15` arm64 runner and exercised from their extracted archives: Main startup and file logging, detached exec surviving an actual Main restart with once-only recovery, PTY input/output/resize/cancel, native Monty/ToolScript, and installer/control start/status/update/stop with and without tmux;
- both Windows server packages, and the Desktop package through its validation and WebView2 acceptance;
- the container image built from the Linux package.

The Linux/Windows and macOS build jobs upload separate artifacts. An aggregation job merges their assets and regenerates one `SHA256SUMS` covering all seven packages before uploading `release-packages`; the tag-only release job waits for aggregation and every qualification job. The packages remain available as the `release-packages` workflow artifact for 14 days. To publish:

1. Set `version` in the root `package.json` (and the root entries of `package-lock.json`) to the release version.
2. Push a tag `v<version>` for that commit. The workflow refuses a tag that differs from `package.json`.
3. After all qualification jobs pass, the workflow creates the GitHub release with the assets and pushes `ghcr.io/550w-host/foxwarm` tagged with the version, its minor version and `latest`.

The container package must be public on GitHub for anonymous `docker pull`; set its visibility once after the first push.
