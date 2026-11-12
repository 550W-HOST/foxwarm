# Release packages

Foxwarm releases are prebuilt packages. Installing one compiles nothing and needs neither Node.js nor the .NET SDK.

## Packages

| Asset | Contents |
| --- | --- |
| `foxwarm-linux-x64.tar.gz` | Server for Linux x64; runs on the installed ASP.NET Core 10 runtime |
| `foxwarm-linux-x64-native.tar.gz` | Server for Linux x64 compiled to native code (NativeAOT); needs no .NET runtime |
| `foxwarm-osx-arm64.tar.gz` | Server for Apple Silicon Macs; runs on the installed ASP.NET Core 10 runtime |
| `foxwarm-osx-arm64-native.tar.gz` | Server for Apple Silicon Macs compiled to native code; needs no .NET runtime |
| `foxwarm-win-x64.zip` | Server for Windows x64; runs on the installed ASP.NET Core 10 runtime |
| `foxwarm-win-x64-native.zip` | Server for Windows x64 compiled to native code; needs no .NET runtime |
| `foxwarm-desktop-win-x64.zip` | Windows desktop app including the .NET runtime, Code OSS and YAML support |
| `foxwarm-code-<version>.tar.gz` | Platform-independent Code OSS workbench and YAML extension for server installations |
| `SHA256SUMS` | SHA-256 checksums of the assets |

Server and Desktop asset names carry no version, so `releases/latest/download/<asset>` always names the newest release; each application archive has a single top-level directory such as `foxwarm-0.9.0-linux-x64/`. Every application package contains `release.json` (version, target, runtime identifier, whether it is self-contained and whether it is native, its asset name and source commit). Server packages also contain the installation control script: `foxwarmctl` on Linux and macOS, `foxwarmctl.ps1` and `foxwarmctl.cmd` on Windows.

Each server package is the complete published Core: WebUI, skills, templates, Node client bundles, browser and Code extensions, artifact compiler resources, ToolScript worker and native libraries for its platform. Artifact preparation still runs the collected compiler under a `node` found on `PATH`; it is optional at runtime. Server packages keep the Code workbench assets and HEIF decoders as separate optional installations. Desktop includes the complete pinned Code OSS workbench, all built-in language extensions, the pinned YAML extension, and their licenses and third-party notices.

The native Linux package replaced the self-contained Linux package in 0.9.4. It is Main compiled ahead of time with NativeAOT: the `Foxwarm` executable, its native libraries and the same resources, with no `Foxwarm.dll` and no .NET runtime. It needs glibc 2.34 or later (Ubuntu 22.04, Debian 12, RHEL 9 and later) and the system ICU and OpenSSL libraries. Its bundled native libraries are the LanceDB library for semantic search, SkiaSharp (no system dependencies beyond the C/C++ runtime), SQLite, the PTY helper library, the ToolScript worker and the artifact compiler's esbuild and sharp/libvips.

The native macOS arm64 and Windows x64 packages replaced the self-contained ones of those platforms in 0.9.6, in the same way. Windows server packages ship the Visual C++ runtime DLLs that the ToolScript worker (`monty.exe`) and LanceDB import, beside each binary that imports them, copied from the build machine's Visual Studio redistributable directory with `VC-RUNTIME-NOTICE.txt`; the Visual C++ runtime is not part of Windows.

Measured on Linux x64 from the 0.9.3 source: the native archive is 96.4 MiB (259 MiB unpacked, of which the LanceDB library is 116 MiB and the `Foxwarm` executable 45 MiB), against 127.8 MiB for the 0.9.3 self-contained archive and 82.5 MiB for the framework-dependent one.

macOS packages require **macOS 15 or later**, following the [.NET 10 supported operating systems](https://github.com/dotnet/core/blob/main/release-notes/10.0/supported-os.md). They use the system ICU and Apple cryptography libraries; no Homebrew ICU or OpenSSL installation is required. The macOS job checks bundled dylibs and entry executables for Homebrew library dependencies. Intel Macs and macOS Desktop are not packaged. These archives are not signed or notarized as distribution packages; browser downloads can carry Gatekeeper quarantine. See the [installation guide](https://foxwarm.net/docs/installing/#macos-apple-silicon) before using a browser-downloaded archive. The curl installer does not add quarantine.

## Code for server installations

Open Code in the running Foxwarm installation. If its assets are missing, the setup page provides Linux/macOS and PowerShell commands for that exact Foxwarm version. The commands download `foxwarm-code-<version>.tar.gz` and the same release's `SHA256SUMS`, verify SHA-256, and extract into the selected installation asset directory. Reload Code after extraction; Main does not need a restart.

The Code archive has `vscode-web/` and `extensions/redhat.vscode-yaml/` at its root, ready to extract into `packages/vscode-web/assets`. It does not include or replace Main or instance data. The existing `npm run build:code` source option remains available. `npm run download:code` continues to select Microsoft's separately licensed development/internal-use distribution; it is not an alias for the Foxwarm release asset.

Measured with Foxwarm 0.9.2 and the pinned Code OSS 1.141.0 build (all 80 built-in extensions retained):

| Output | Size |
| --- | ---: |
| Unpacked Code OSS, including upstream notices | 182.73 MiB |
| Unpacked YAML extension | 3.54 MiB |
| Standalone Code release tar.gz | 49.17 MiB |
| Desktop ZIP before adding Code | 139.24 MiB |
| Desktop ZIP with Code and YAML | 189.55 MiB |

These are local archive-assembly measurements; later builds can differ with source or compression changes.

## Installed layout

```text
foxwarm/
  data_dir             data-directory pointer (same meaning as in a source checkout)
  foxwarmctl           control script copied from the selected release
  runtime/0.9.0/       extracted release
  runtime/current      symlink (Windows: junction) to the selected release
```

Main runs with `--installation-root` set to the program directory, so `data_dir` and relative settings resolve there. Framework-dependent packages start `dotnet Foxwarm.dll` with the `dotnet` found on `PATH`, because the apphost does not search `PATH` for a runtime installed outside the default location. Self-contained packages start their apphost, and native packages their native executable, both named `Foxwarm`.

`foxwarmctl update` and a rerun of the installer use the same sequence as a source restart: extract and run the new release's `--inspect-upgrade` while the old Main keeps running, stop Main (SIGKILL on Linux/macOS or process termination on Windows after 60 seconds), select the new release, start it if Main had been running, then delete every other release. A blocked inspection or failed download leaves the installation unchanged. `update` stays with the installed package type. Rerunning the installer with `--native` or `--framework-dependent` (`-Native` or `-FrameworkDependent` on Windows), or with a package file of the other type, switches an existing installation to that package, and an installation of a retired self-contained package is switched to the native one automatically; the installer downloads and verifies the package and hands it to the installation's own `update`, forcing it when the version is the same. For 0.9.4 only, the release published the native Linux archive also as `foxwarm-linux-x64-self-contained.tar.gz`, with its own `SHA256SUMS` line, so that such an installation's unmodified `update` reached the native package; the archive's `release.json` names the native asset, which later updates request. 0.9.6 does the same for macOS and Windows with `foxwarm-osx-arm64-self-contained.tar.gz` and `foxwarm-win-x64-self-contained.zip`; the aggregate job adds both aliases; remove that step in 0.9.7. When a release lacks the asset an installation records, `update` says so and points to rerunning the installer.

On Linux and macOS, start uses tmux when available. Main runs as the process of one pane in window `foxwarm` of the tmux session `foxwarm` (`FOXWARM_TMUX_SESSION`), with `remain-on-exit` on that pane so an early exit stays visible. The control script recognizes its Main as the live pane in that window whose current directory is the program directory, and stops, restarts or removes only that pane: other windows in the session, and other panes in that window, are left alone. If another program holds the window, start refuses and stop/update do not touch it; set `FOXWARM_TMUX_SESSION` to run the installation in another session.

Without tmux, start uses `nohup` with closed terminal input and appends output to `state/logs/foxwarm.stdout.log` and `foxwarm.stderr.log` in the data directory, so Main survives terminal/SSH hangups. In this mode, `attach` prints the log paths. Both Unix modes write Main's PID to `foxwarm.pid` in the program directory. Status, stop, restart and update ignore a stale PID unless it still identifies this installation's Main; tmux pane discovery also recognizes older installations without a PID file. `status` prints `Running (PID N), release ...` followed by the launch mode and exits 0 when running, or 3 otherwise.

Windows uses the background launch and the data-root-specific control pipe of the [Windows controls](code-index/units/windows-service-scripts.md).

## Building

`scripts/release/package.mjs` publishes the packages from built delivery assets. It requires native Python 3 on `PATH` (`python` on Windows, `python3` on Linux/macOS):

```bash
npm ci && npm --prefix packages/webui ci
node scripts/test/prepare-browser.mjs --code-only  # required for Desktop, or restore the pinned CI assets
node scripts/release/package.mjs --code-only --output dist
node scripts/release/package.mjs --build-assets --output dist --target linux-x64
# Native packages build only on their own platform; the release job links Linux in a glibc 2.34 container:
node scripts/release/package.mjs --output dist --target linux-x64-native
# On Windows, using the same prepared Code assets and the Visual Studio C++ runtime directory:
node scripts/release/package.mjs --build-assets --output dist --vc-runtime "<VS>\VC\Redist\MSVC\<version>\x64\Microsoft.VC143.CRT" --target win-x64 --target win-x64-native --target desktop-win-x64
# On an Apple Silicon Mac:
node scripts/release/package.mjs --build-assets --output dist --target osx-arm64 --target osx-arm64-native
node scripts/release/package.mjs --output dist --target linux-x64   # one package
```

NativeAOT does not cross-compile between operating systems: each native target builds only on its own platform. Windows server packages need `--vc-runtime DIR`, the x64 `Microsoft.VC14x.CRT` directory of the Visual Studio installation; `scripts/release/windows-imports.mjs EXTRACTED_PACKAGE` then fails a package when a binary imports a DLL that is neither in it nor part of Windows. A native executable needs at least the glibc it was linked against, so the release job links the Linux one in `scripts/release/native-linux.Dockerfile` (UBI 9, glibc 2.34) and checks the result with `scripts/release/check-linux-libraries.sh`. The LanceDB NuGet package's Linux library needs glibc 2.39, so both Linux packages instead ship one built from the same pinned source on glibc 2.34: `scripts/release/build-lancedb-linux.sh OUTPUT_DIR`, run in `scripts/release/lancedb-linux.Dockerfile`, then `package.mjs --lancedb-library OUTPUT_DIR/liblancedb_ffi.so`. Without that option the packages keep the NuGet library. Desktop is produced on Windows because WinUI manifest/XAML/resource generation uses Windows SDK tools. macOS arm64 targets must be built on an Apple Silicon macOS host: Clang builds the Darwin PTY library and its controlling-terminal helper during publish. With no `--target`, a host selects the published targets it can build. Use the explicit target lists above. For a cross-published target, the script installs the locked target-native esbuild and sharp packages (verified against `package-lock.json`) beside the host ones so the artifact runtime collector can find them. Tar archives use Python 3 on both GNU and BSD hosts, with sorted entries, commit timestamps, numeric root ownership and a fixed gzip header. `--directory-only` leaves the published directories under `dist/.work` instead of archiving them.

`scripts/release/smoke-server.sh PACKAGE [PORT] [--without-tmux]` and `scripts/release/smoke-server.ps1 -Package FILE [-Port N]` install a package into a temporary directory with the real installer, then check startup on the configured loopback address, the sign-in page, status, a forced reinstall through `update`, release cleanup and stop. The Windows smoke runs the installer and control script in Windows PowerShell, with non-ASCII program and data directories, and reports start and restart times. `scripts/release/smoke-upgrade.sh [--via-update ASSET] OLD NEW PORT [INSTALLER_OPTION...]` and `scripts/release/smoke-upgrade.ps1 -Old FILE -New FILE [-Port N] [-ViaUpdate ASSET] [-Native | -FrameworkDependent]` install and start OLD, then rerun the installer with NEW (or, with the via-update option, run the installation's own `update` against a download served as ASSET) to switch package type or release, and check that the token, configuration, Agent data and data directory are kept and that the new Main runs. `scripts/release/qualify-package.mjs EXTRACTED_PACKAGE [--vector]` exercises an extracted Linux x64, macOS arm64 or Windows x64 package: logging, the loopback listener, PTY, native ToolScript and, with `--vector`, indexing and search through the Vector child, with LanceDB loaded only there. `scripts/release/release-install.test.js` covers the Linux installer and control script with fixture packages, including tmux pane isolation, detached background lifecycle, launcher hangups, stale PIDs and checksum-tool fallback. `scripts/release/package.test.mjs` covers portable archives, merged checksums, macOS installer selection and the `shasum` fallback. The macOS smoke uses system Bash 3.2 and BSD utilities, with tmux and with a system-only PATH that excludes tmux; the self-contained background smoke also excludes `dotnet`.

## Publishing a release

The **Release packages** workflow builds all packages on every push to `testing` and `main` and qualifies them:

- the Linux framework-dependent package on the runner;
- the native Linux package: its glibc floor and library dependencies, installer/control smoke on the runner and on Ubuntu 22.04 without .NET, Main without CoreCLR, PTY, native ToolScript, the Vector child, detached exec across a Main restart, a framework-dependent installation switched to native, and the previous release's native installation upgraded to the new one on Ubuntu 22.04, by rerunning the installer and through its own `update`;
- both macOS arm64 packages, built on the official `macos-15` arm64 runner and exercised from their extracted archives: Main startup and file logging, detached exec surviving an actual Main restart with once-only recovery, PTY input/output/resize/cancel, native Monty/ToolScript, the Vector child for the native package, and installer/control start/status/update/stop with and without tmux; the previous release's self-contained package upgraded to native by rerunning the installer and through its own `update`, and a framework-dependent installation switched to native;
- both Windows server packages, built on the Windows runner: DLL imports, the same feature qualification and detached-exec restart as macOS, installer/control smoke, the previous release's self-contained package upgraded to native both ways and a framework-dependent installation switched to native; and the Desktop package through its validation and WebView2 acceptance;
- the container image built from the native Linux package, without a .NET runtime.

Tests and Release call the same `code-resources.yml` producer once per workflow run. It restores an exact cache of pinned Code/YAML outputs or builds on a miss, validates and packages them, then shares the archive as a per-run artifact. Desktop and Chromium consumers never rebuild Code. The key includes the pins and build/packaging inputs. Tag runs may reuse default-branch caches; a cache that exists only on another branch is not required, because the producer builds once on a miss.

The Ubuntu, Windows and macOS jobs upload separate artifacts. The Ubuntu artifact (Linux packages) also carries the shared Code release archive; the Windows job reuses that archive, builds both Windows server packages and Desktop and qualifies them before aggregation completes. An aggregation job merges their assets and regenerates one `SHA256SUMS` covering all seven application packages, the Code archive and any transition alias before uploading `release-packages`; the tag-only release job waits for aggregation and every qualification job. The packages remain available as the `release-packages` workflow artifact for 14 days. To publish:

1. Set `version` in the root `package.json` (and the root entries of `package-lock.json`) to the release version.
2. Push a tag `v<version>` for that commit. The workflow refuses a tag that differs from `package.json`.
3. After all qualification jobs pass, the workflow creates the GitHub release with the assets and pushes `ghcr.io/550w-host/foxwarm` tagged with the version, its minor version and `latest`.
4. Afterwards, move `PREVIOUS_RELEASE` at the top of `release.yml`, the release the upgrade checks start from, to the new release.

The container package must be public on GitHub for anonymous `docker pull`; set its visibility once after the first push.
