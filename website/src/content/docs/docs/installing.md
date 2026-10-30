---
title: Install Foxwarm
description: Install Foxwarm, configure your first model, and manage the running app.
sidebar:
  order: 1
---

Install Foxwarm on **Linux x64** (including x64 WSL) or **Windows x64**, or use the Linux x64 [Docker Compose](#docker-compose) setup. macOS Main is not currently supported by these installation instructions.

For a new installation, the source installer creates `./foxwarm` for the program and `./foxwarm-data` for configuration, conversations, Agent files and other data. It builds and starts the app, then prints the WebUI login URL. The program's `data_dir` file remembers the chosen data location for later starts and installer reruns.

Existing TypeScript installations should follow the [migration guide](/docs/typescript-migration/).

## Before installing from source

Both source installers need:

- Git and Node.js **20.19+ in the 20.x line, or 22.12+**, with npm.
- A .NET SDK supporting `net10.0`, with the **ASP.NET Core 10 runtime** installed.
- Internet access to download the locked npm/NuGet dependencies and native worker.

Check the selected .NET installation with `dotnet --version` and `dotnet --list-runtimes`. The runtime list must include `Microsoft.AspNetCore.App 10.x`. An exact SDK patch version is not required.

The SDK and native compilers are source-build requirements; Main runs on the ASP.NET Core runtime. The installers check prerequisites but do not install system packages. Docker builds these dependencies inside the image instead.

## Linux x64 or x64 WSL

Also install **tmux, Python 3, make, GCC/G++, and libc/libutil development files**. These provide the native terminal helpers and worker used during the build.

Run this from the directory where you want the program and data directories created:

```bash
curl -fsSL https://foxwarm.550w.host/install-foxwarm.sh | bash
```

To choose different directories:

```bash
curl -fsSL https://foxwarm.550w.host/install-foxwarm.sh | bash -s -- \
  --dir "$PWD/foxwarm" \
  --data-dir "$PWD/foxwarm-data"
```

You can inspect the [Bash installer](https://github.com/550W-HOST/foxwarm/blob/main/install-foxwarm.sh) before running it. Run the downloaded script with `--help` for its other options.

## Windows PowerShell

Also install **Python 3** for the native worker build. Windows does not require tmux or WSL.

Open PowerShell in the directory where you want Foxwarm installed:

```powershell
irm https://foxwarm.550w.host/install-foxwarm.ps1 | iex
```

The installer starts Foxwarm in the background and opens the WebUI URL when available.

To inspect the script or pass installation paths, download it first:

```powershell
Invoke-WebRequest https://foxwarm.550w.host/install-foxwarm.ps1 -OutFile install-foxwarm.ps1
.\install-foxwarm.ps1 -InstallDir .\foxwarm -DataDir .\foxwarm-data
```

If script execution is blocked, run the downloaded file with a process-specific policy:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-foxwarm.ps1
```

Before rerunning the installer, stop the existing instance with `npm run stop:windows` from its checkout. This avoids replacing native dependencies while they are loaded.

## Open the WebUI and configure a model

Use the URL printed at startup, typically:

```text
http://localhost:3001/#token=...
```

If you no longer have the URL, read `state/token` in your data directory. For a default install, from the parent of `foxwarm`:

```bash
cat foxwarm-data/state/token
```

On Windows, use `Get-Content .\foxwarm-data\state\token` instead. Treat the token and token-bearing URL like a password.

Once logged in, open **Setup → Models**, configure your provider, save, and start a conversation. Follow [Set up your first model](/docs/model-setup/) for the provider fields and connection test.

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
