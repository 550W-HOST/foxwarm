---
title: Install Foxwarm
description: Install Foxwarm on Linux, WSL, macOS, Windows or Docker, then start, stop, update and locate your instance.
sidebar:
  order: 1
---

The Foxwarm server runs on **Linux x64** (including x64 WSL), **macOS arm64** (Apple Silicon) and **Windows x64**, or in Docker on Linux x64. On Windows you can also use the [desktop app](#windows-desktop-app).

| Platform | Command |
| --- | --- |
| Linux x64 or x64 WSL | `curl -fsSL https://foxwarm.net/install-foxwarm.sh \| bash` |
| macOS, Apple Silicon | `curl -fsSL https://foxwarm.net/install-foxwarm.sh \| bash` |
| Windows x64, in PowerShell | `irm https://foxwarm.net/install-foxwarm.ps1 \| iex` |
| Docker | See [Docker](#docker) |

Run the command from the directory where you want Foxwarm installed. The installer downloads the latest prebuilt release, creates `./foxwarm` for the program and `./foxwarm-data` for configuration, conversations and Agent files, starts Foxwarm and prints the WebUI sign-in link. The program's `data_dir` file remembers the data location.

Nothing is compiled during installation. Existing TypeScript installations should follow the [migration guide](/docs/typescript-migration/).

## Packages

Each [release](https://github.com/550W-HOST/foxwarm/releases/latest) provides:

| Package | Use |
| --- | --- |
| [`foxwarm-linux-x64-native.tar.gz`](https://github.com/550W-HOST/foxwarm/releases/latest/download/foxwarm-linux-x64-native.tar.gz) | Linux server compiled to native code; needs no .NET runtime (default on Linux) |
| [`foxwarm-linux-x64.tar.gz`](https://github.com/550W-HOST/foxwarm/releases/latest/download/foxwarm-linux-x64.tar.gz) | Linux server; uses the installed ASP.NET Core 10 runtime |
| [`foxwarm-osx-arm64.tar.gz`](https://github.com/550W-HOST/foxwarm/releases/latest/download/foxwarm-osx-arm64.tar.gz) | Apple Silicon Mac server; uses the installed ASP.NET Core 10 runtime |
| [`foxwarm-osx-arm64-self-contained.tar.gz`](https://github.com/550W-HOST/foxwarm/releases/latest/download/foxwarm-osx-arm64-self-contained.tar.gz) | Apple Silicon Mac server with the .NET runtime included |
| [`foxwarm-win-x64.zip`](https://github.com/550W-HOST/foxwarm/releases/latest/download/foxwarm-win-x64.zip) | Windows server; uses the installed ASP.NET Core 10 runtime |
| [`foxwarm-win-x64-self-contained.zip`](https://github.com/550W-HOST/foxwarm/releases/latest/download/foxwarm-win-x64-self-contained.zip) | Windows server with the .NET runtime included |
| [`foxwarm-desktop-win-x64.zip`](https://github.com/550W-HOST/foxwarm/releases/latest/download/foxwarm-desktop-win-x64.zip) | Windows desktop app, .NET runtime included |
| [`SHA256SUMS`](https://github.com/550W-HOST/foxwarm/releases/latest/download/SHA256SUMS) | Checksums of the release files |

Each release also includes:

- `foxwarm-code-<version>.tar.gz`: the Code editor for server packages. The desktop app already includes it. When Code is missing, the WebUI's Code page shows the command that installs it.
- `native-cli-node-*`: the standalone [Node](/docs/nodes/) client for Linux, macOS and Windows. Node bootstrap commands download it for you.
- The Docker image `ghcr.io/550w-host/foxwarm`, tagged with the version (for example `0.9.4`), the minor version (`0.9`) and `latest`; see [Docker](#docker).

Older versions are on the [releases page](https://github.com/550W-HOST/foxwarm/releases); replace `latest/download` in a link with `download/v<version>` to fetch a specific version.

On Linux the installer uses the native package; `--framework-dependent` selects the package that uses the installed ASP.NET Core 10 runtime. On macOS and Windows the installers choose the smaller package when `dotnet --list-runtimes` shows `Microsoft.AspNetCore.App 10.x`, and the self-contained package otherwise. Use `--self-contained` / `--framework-dependent` (macOS) or `-SelfContained` / `-FrameworkDependent` (Windows) to choose yourself.

## Requirements

| | Linux x64 / WSL | macOS arm64 | Windows x64 |
| --- | --- | --- | --- |
| tmux (optional, preferred for background start) | ✓ | ✓ | — |
| curl or wget, tar | ✓ | included with macOS | — |
| sha256sum or shasum | ✓ | shasum is included | — |
| ICU and OpenSSL libraries (present on most Linux systems) | ✓ | uses macOS system libraries | — |
| ASP.NET Core 10 runtime | only for the framework-dependent package | only for the smaller package | only for the smaller package |

Linux packages, including semantic history search, need glibc 2.34 or later (for example Ubuntu 22.04, Debian 12, RHEL 9).

Optional tools used by some features:

- **Node.js** on `PATH` prepares chart, image and React artifacts that agents show in the WebUI, and runs the `browser_*` tools. Everything else works without it.
- **Chromium or Chrome** for the `browser_*` tools, which are available on a machine only when both Node.js and a browser are installed. Select a browser with `PUPPETEER_EXECUTABLE_PATH`, or install one under a common name. Foxwarm keeps the browser's own sandbox on; where Chromium cannot create one (running as root, restricted containers), point `PUPPETEER_EXECUTABLE_PATH` at a launcher script suited to that environment.
- **Git** for the Code workbench's source control view.

## Linux x64 or x64 WSL

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash
```

To choose directories or a release:

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash -s -- \
  --dir "$PWD/foxwarm" \
  --data-dir "$PWD/foxwarm-data" \
  --version 0.9.0
```

`--package FILE` installs an already downloaded package, and `--no-start` installs without starting. You can read the [installer](https://github.com/550W-HOST/foxwarm/blob/main/install-foxwarm.sh) before running it.

To switch an existing installation to another package, rerun the installer with `--native` or `--framework-dependent`. Its program directory, data and configuration stay the same.

### Moving from the self-contained Linux package

Since 0.9.4 the native package replaces `foxwarm-linux-x64-self-contained.tar.gz`. An installation of the self-contained package switches to the native package at its next update and keeps its data and configuration. Later updates stay on the native package.

- To update through 0.9.4, run `./foxwarm/foxwarmctl update 0.9.4`. The 0.9.4 release also publishes the native package under the old name for this; run `update` again afterwards to reach later releases.
- Releases after 0.9.4 don't publish that name, so a plain `update` of such an installation fails. To update it directly to 0.9.5 or later, rerun the installer from the directory you originally installed from, with the same `--dir` if you used one:

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash
```

The installer downloads the native package, checks your data with it while the old release keeps running, then switches and restarts Foxwarm.

## macOS (Apple Silicon)

Requires **macOS 15 or later**, following the [.NET 10 support policy](https://github.com/dotnet/core/blob/main/release-notes/10.0/supported-os.md). Intel Macs are not supported. There is no macOS desktop package.

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash
```

The same directory and version options as Linux apply. The installer chooses between the framework-dependent and self-contained arm64 packages; there is no native macOS package yet. No Homebrew ICU or OpenSSL installation is needed. Install tmux if you want an attachable console; otherwise Foxwarm starts in the background with file logs.

The packages are tested on macOS 15 on Apple Silicon. Semantic history search and the browser tool are included but not yet verified on macOS.

These packages are not signed or notarized for distribution. The curl installer does not add quarantine, but archives downloaded with a browser can be quarantined by Gatekeeper. After verifying the archive against the release's `SHA256SUMS` and deciding to trust it, remove quarantine from that archive before installing it:

```bash
xattr -d com.apple.quarantine foxwarm-osx-arm64-self-contained.tar.gz
curl -fsSLO https://foxwarm.net/install-foxwarm.sh
bash install-foxwarm.sh --package foxwarm-osx-arm64-self-contained.tar.gz
```

If you already extracted the archive and Gatekeeper blocks its executables, clear quarantine only on that extracted package with `xattr -dr com.apple.quarantine /path/to/extracted-package`. Do not disable Gatekeeper system-wide.

## Windows PowerShell

```powershell
irm https://foxwarm.net/install-foxwarm.ps1 | iex
```

The installer starts Foxwarm in the background and opens the WebUI when it is ready. To read the script first or choose options, download it:

```powershell
Invoke-WebRequest https://foxwarm.net/install-foxwarm.ps1 -OutFile install-foxwarm.ps1
.\install-foxwarm.ps1 -InstallDir .\foxwarm -DataDir .\foxwarm-data
```

It also accepts `-Version`, `-Package FILE` and `-NoStart`. If script execution is blocked, run the downloaded file with `powershell -ExecutionPolicy Bypass -File .\install-foxwarm.ps1`.

## Windows desktop app

Download [`foxwarm-desktop-win-x64.zip`](https://github.com/550W-HOST/foxwarm/releases/latest/download/foxwarm-desktop-win-x64.zip) from the [latest release](https://github.com/550W-HOST/foxwarm/releases/latest), extract it and open **Foxwarm.Desktop.exe**. It runs Foxwarm inside a window with a tray icon and keeps its data under `%LOCALAPPDATA%\Foxwarm\Desktop`. It needs the Microsoft Edge WebView2 Runtime, which Windows 10 and 11 normally include. The desktop app listens only on this computer; install the server if other devices should connect.

## Open the WebUI

Use the sign-in link printed by the installer, typically:

```text
http://localhost:3001/#token=...
```

If you no longer have it, read `state/token` in your data directory, for example `cat foxwarm-data/state/token` or `Get-Content .\foxwarm-data\state\token`. Treat the token and the link like a password.

On a new installation, Foxwarm opens **Setup → Models**. Follow [Set up your first model](/docs/model-setup/) to connect a provider.

## Start, stop, update and inspect

The installer places `foxwarmctl` in the program directory:

| Action | Linux, WSL, macOS | Windows |
| --- | --- | --- |
| Start in the background | `./foxwarm/foxwarmctl start` | `.\foxwarm\foxwarmctl.cmd start` |
| Stop | `./foxwarm/foxwarmctl stop` | `.\foxwarm\foxwarmctl.cmd stop` |
| Restart | `./foxwarm/foxwarmctl restart` | `.\foxwarm\foxwarmctl.cmd restart` |
| Status | `./foxwarm/foxwarmctl status` | `.\foxwarm\foxwarmctl.cmd status` |
| Update to the latest release | `./foxwarm/foxwarmctl update` | `.\foxwarm\foxwarmctl.cmd update` |
| Watch the console | `./foxwarm/foxwarmctl attach` | logs under `state\logs` |
| Run in the foreground | `./foxwarm/foxwarmctl run` | `.\foxwarm\foxwarmctl.cmd run` |

On Linux and macOS, start uses the tmux session `foxwarm` when tmux is available (`FOXWARM_TMUX_SESSION` changes the name); detach with <kbd>Ctrl</kbd>+<kbd>b</kbd>, then <kbd>d</kbd>. Without tmux, Foxwarm starts as a detached background process and keeps running when the terminal or SSH connection closes. `attach` then shows the paths of `state/logs/foxwarm.stdout.log` and `foxwarm.stderr.log` in the data directory. `status` reports the PID and launch mode. Both modes keep a `foxwarm.pid` file in the program directory; stale PID files are ignored. Stop waits up to 60 seconds for running work to finish, then ends the process.

`update` downloads and checks the new release while the old one keeps running, then stops Foxwarm, switches to the new release, starts it again if it was running and removes the old release. `update 0.9.1` installs a specific version. `update` keeps the installed package type. Rerunning the installer on an existing installation does the same, and can also switch the package type (see [Linux](#linux-x64-or-x64-wsl)). See [data, updates, and backups](/docs/data-upgrades-backups/) before upgrading important data.

Logs are under `state/logs/` in the data directory.

## Docker

The image runs the native Linux build of Foxwarm, without a .NET runtime, and includes Node.js and Chromium:

```bash
mkdir -p foxwarm-data && sudo chown 1000:1000 foxwarm-data
curl -fsSLO https://raw.githubusercontent.com/550W-HOST/foxwarm/main/docker/seccomp-chromium.json
docker run -d --name foxwarm --init -p 3001:3001 \
  --security-opt seccomp=seccomp-chromium.json --shm-size 1g \
  -v "$PWD/foxwarm-data:/data" ghcr.io/550w-host/foxwarm:latest
```

The container runs Foxwarm as the non-root `node` user (uid 1000) with passwordless `sudo`, so Agents can still install packages. The mounted data directory must be writable by uid 1000; Foxwarm does not change its ownership and refuses to start otherwise. A data directory written by an earlier image that ran as root needs a one-time `sudo chown -R 1000:1000 foxwarm-data` before upgrading. The seccomp profile is Docker's default plus the namespace calls Chromium's sandbox needs, so browser tools work with the sandbox on and without extra capabilities. Without it, the first browser call fails with a sandbox error.

Open `http://localhost:3001/` using the token from `foxwarm-data/state/token`. Tags follow releases, such as `0.9.0`, `0.9` and `latest`; to update, pull the new image and recreate the container. First-run model setup works the same way as a local installation.

The repository's `docker-compose.yml` runs the same image with a healthcheck, plus an optional paired sandbox Node built from the checkout:

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
mkdir -p foxwarm-data/state foxwarm-data/agents
sudo chown -R 1000:1000 foxwarm-data
docker compose up -d foxwarm
```

If you change `bot.httpPort`, update the port mapping and healthcheck as well. For a model or embedding service on the Docker host, use a host-reachable address; `localhost` inside Foxwarm's container refers to that container.

## Optional components

- **Semantic history search:** disabled by default. It needs an embedding service; see [search requirements](/docs/history-search/#enable-semantic-search).
- **Code workbench:** the large editor assets are not included in the packages or the image. See the [workbench setup](https://github.com/550W-HOST/foxwarm/blob/main/packages/vscode-web/README.md).
- **HEIC/HEIF images:** require additional native decoders. See [image prerequisites](https://github.com/550W-HOST/foxwarm/blob/main/docs/native-image-prerequisites.md). PNG/JPEG use the bundled image support.

## Running from source

For development, run a source checkout instead of a release. It needs Git, Node.js 20.19+ (20.x) or 22.12+ with npm, a .NET SDK for `net10.0`, Python 3, and on Linux tmux, make, GCC/G++ and libc/libutil development files:

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
mkdir -p ../foxwarm-data
printf "%s\n" "$PWD/../foxwarm-data" > data_dir
npm start
```

`npm start` builds the checkout and starts it in tmux; `npm run restart` rebuilds and restarts, and `npm run stop` stops it. On Windows use `npm run start:windows`, `restart:windows`, `stop:windows` and `status:windows`. For source changes and tests, see the repository's [development guide](https://github.com/550W-HOST/foxwarm/blob/main/docs/development.md).
