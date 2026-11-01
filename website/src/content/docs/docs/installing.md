---
title: Install Foxwarm
description: Install Foxwarm on Linux, WSL, Windows or Docker, then start, stop and locate your instance.
sidebar:
  order: 1
---

Foxwarm runs on **Linux x64** (including x64 WSL) and **Windows x64**, or in Docker on Linux x64. macOS is not supported for the Foxwarm server; a Mac can still join as a [Node](/docs/nodes/).

| Platform | Command |
| --- | --- |
| Linux x64 or x64 WSL | `curl -fsSL https://foxwarm.net/install-foxwarm.sh \| bash` |
| Windows x64, in PowerShell | `irm https://foxwarm.net/install-foxwarm.ps1 \| iex` |
| Docker Compose | See [Docker Compose](#docker-compose) |

Run the command from the directory where you want Foxwarm installed. The installer creates `./foxwarm` for the program and `./foxwarm-data` for configuration, conversations and Agent files, builds and starts the app, and prints the WebUI sign-in link. The program's `data_dir` file remembers the data location for later starts and reruns.

The installers build from source and stop with a clear message when something below is missing. They do not install system packages for you.

Existing TypeScript installations should follow the [migration guide](/docs/typescript-migration/).

## Requirements

| | Linux x64 / WSL | Windows x64 |
| --- | --- | --- |
| Git | ✓ | ✓ |
| Node.js 20.19+ (20.x) or 22.12+, with npm | ✓ | ✓ |
| .NET SDK for `net10.0`, with the ASP.NET Core 10 runtime | ✓ | ✓ |
| Python 3 | ✓ | ✓ |
| tmux, make, GCC/G++, libc/libutil development files | ✓ | — |

Internet access is needed to download the locked npm and NuGet dependencies and the native worker.

To check .NET, run `dotnet --version` and `dotnet --list-runtimes`; the runtime list must include `Microsoft.AspNetCore.App 10.x`. Any SDK patch version works. The SDK and compilers are only needed to build; Foxwarm itself runs on the ASP.NET Core runtime.

## Linux x64 or x64 WSL

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash
```

To choose different directories:

```bash
curl -fsSL https://foxwarm.net/install-foxwarm.sh | bash -s -- \
  --dir "$PWD/foxwarm" \
  --data-dir "$PWD/foxwarm-data"
```

You can read the [Bash installer](https://github.com/550W-HOST/foxwarm/blob/main/install-foxwarm.sh) before running it. Run the downloaded script with `--help` for other options.

## Windows PowerShell

Windows does not need tmux or WSL.

```powershell
irm https://foxwarm.net/install-foxwarm.ps1 | iex
```

The installer starts Foxwarm in the background and opens the WebUI when it is ready.

To read the script first or choose installation paths, download it:

```powershell
Invoke-WebRequest https://foxwarm.net/install-foxwarm.ps1 -OutFile install-foxwarm.ps1
.\install-foxwarm.ps1 -InstallDir .\foxwarm -DataDir .\foxwarm-data
```

If script execution is blocked, run the downloaded file with a process-specific policy:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-foxwarm.ps1
```

Before rerunning the installer, stop the existing instance with `npm run stop:windows` from its checkout, so native dependencies are not replaced while they are loaded.

## Open the WebUI

Use the sign-in link printed at startup, typically:

```text
http://localhost:3001/#token=...
```

If you no longer have it, read `state/token` in your data directory. For a default install, from the parent of `foxwarm`:

```bash
cat foxwarm-data/state/token
```

On Windows, use `Get-Content .\foxwarm-data\state\token`. Treat the token and the link like a password.

On a new installation, Foxwarm opens **Setup → Models**. Follow [Set up your first model](/docs/model-setup/) to connect a provider.

## Start, stop, and inspect

Run these commands from the program checkout:

| Action | Linux x64, WSL | Windows |
| --- | --- | --- |
| Start in the background | `npm start` | `npm run start:windows` |
| Restart | `npm run restart` | `npm run restart:windows` |
| Stop | `npm run stop` | `npm run stop:windows` |
| Inspect the running process | `tmux attach -t foxwarm` | `npm run status:windows` |

To detach from tmux without stopping Foxwarm, press <kbd>Ctrl</kbd>+<kbd>b</kbd>, then <kbd>d</kbd>. If you chose a custom tmux session name, use it in the attach command.

Logs are under `state/logs/` in the data directory. If startup fails, inspect those logs and the platform's process output before rerunning. See [data, updates, and backups](/docs/data-upgrades-backups/) for changing data paths, installing updates and preserving your instance.

## Docker Compose

The Linux x64 image includes the ASP.NET Core runtime, Node.js and Chromium. You need Docker with Compose on the host; the image build acquires the source-build toolchain and dependencies.

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
mkdir -p foxwarm-data/state foxwarm-data/agents
docker compose up -d --build foxwarm
```

Open `http://localhost:3001/` using the token from `foxwarm-data/state/token`. Here, Compose mounts `foxwarm-data` inside the checkout at `/data` in the container. First-run model setup works the same way as a local installation.

This command starts only the `foxwarm` service. The optional paired sandbox client is not required to use the WebUI.

For container logs and shutdown:

```bash
docker compose logs -f foxwarm
docker compose down
```

If you change `bot.httpPort`, update the Compose port mapping and healthcheck as well. For a model or embedding service on the Docker host, use a host-reachable address; `localhost` inside Foxwarm's container refers to that container.

## Optional components

- **Semantic history search:** disabled by default. It needs a compatible native Vector library and an embedding service; see [search requirements](/docs/history-search/#enable-semantic-search).
- **Code workbench:** the large editor assets are not included in the ordinary source or Docker build. See the [workbench setup](https://github.com/550W-HOST/foxwarm/blob/main/packages/vscode-web/README.md).
- **HEIC/HEIF images:** require additional native decoders. See [image prerequisites](https://github.com/550W-HOST/foxwarm/blob/main/docs/native-image-prerequisites.md). PNG/JPEG use the bundled image support.

## Manual checkout

For development or a manual Linux x64/WSL install, use the same prerequisites as the installer:

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
mkdir -p ../foxwarm-data
printf "%s\n" "$PWD/../foxwarm-data" > data_dir
npm start
```

The `data_dir` pointer keeps builds and subsequent starts pointed at the same data directory. For source changes and tests, see the repository's [development guide](https://github.com/550W-HOST/foxwarm/blob/main/docs/development.md).
