---
title: Install Foxwarm
description: Install Foxwarm, open the WebUI, and manage the running process.
sidebar:
  order: 1
---

This branch is a managed Main delivery candidate, not a public release switch. Linux x64 and Windows x64 are the candidate targets; Linux x64 and Windows x64 source startup/control have been qualified separately; Linux image success does not qualify other container architectures. macOS Main is not qualified here, and other-platform TypeScript Node clients are unchanged. Main TUI, Session Worker hosting and managed ToolScript/controllers are outside this candidate. Explicit `--tui` fails; persisted `bot.enableTUI` logs an ignored diagnostic.

The installer creates `./foxwarm` for the program and `./foxwarm-data` for runtime data. It builds and starts the app, then prints a WebUI URL containing the login token.

## Linux x64 or x64 WSL

Install Git, Node.js 20.19+ (20.x) or 22.12+ with npm, a net10.0-capable .NET SDK, the ASP.NET Core 10 runtime, tmux, Python 3, make, GCC/G++, and libc/libutil development files. Python/native tools support the pinned Monty worker, Linux PTY helper and retained node-pty build. No optional image codec is required. The installer checks prerequisites but does not install system packages.

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

On Windows x64 install Git for Windows, Node.js 20.19+ (20.x) or 22.12+ with npm, a net10.0-capable .NET SDK, the ASP.NET Core 10 runtime, and Python 3 for a fresh pinned native-worker build. No exact SDK patch version is required. Then open PowerShell:

```powershell
irm https://foxwarm.550w.host/install-foxwarm.ps1 | iex
```

The installer starts Foxwarm in the background and opens the WebUI URL when available. Windows does not require tmux or WSL.

To inspect the script or pass installation paths, download it first:

```powershell
Invoke-WebRequest https://foxwarm.550w.host/install-foxwarm.ps1 -OutFile install-foxwarm.ps1
.\install-foxwarm.ps1 -InstallDir .\foxwarm -DataDir .\foxwarm-data
```

If script execution is blocked, run the downloaded file with a process-specific policy:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-foxwarm.ps1
```

Stop the existing instance with `npm run stop:windows` from its checkout before rerunning the installer. This avoids replacing native dependencies while they are loaded.

## Open the WebUI

Use the URL printed at startup, typically:

```text
http://localhost:3001/#token=...
```

If you no longer have the URL, read `state/token` in your data directory and use it as the token value. For a default install on Linux x64 or x64 WSL:

```bash
cat foxwarm-data/state/token
```

Treat the token like a password. Once logged in, [configure your first model](/docs/model-setup/).

## Start, stop, and inspect

Run these commands from the program checkout:

| Action | Linux x64, WSL | Windows |
| --- | --- | --- |
| Start in the background | `npm start` | `npm run start:windows` |
| Restart | `npm run restart` | `npm run restart:windows` |
| Stop | `npm run stop` | `npm run stop:windows` |
| Inspect the running process | `tmux attach -t foxwarm` | `npm run status:windows` |

To detach from tmux without stopping Foxwarm, press <kbd>Ctrl</kbd>+<kbd>b</kbd>, then <kbd>d</kbd>. If you chose a custom tmux session name, use it in the attach command.

Logs are under `state/logs/` in the data directory. See [upgrades and backups](/docs/data-upgrades-backups/) before replacing code or dependencies on an important instance.

## Docker Compose

The source-built Linux x64 candidate runs managed Main on Debian 13 with ASP.NET Core 10, retaining Node 24 and the existing operator tools for JavaScript and stdio MCP workloads. Chromium follows Debian's ordinary package updates. This does not promote the candidate to the public release branch or authorize replacing a live installation. On the intended candidate checkout:

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
mkdir -p foxwarm-data/state foxwarm-data/agents
docker compose up -d --build foxwarm
```

Open `http://localhost:3001/` and read the token from `foxwarm-data/state/token`. The Compose service mounts that host directory at `/data` inside the container. First-run model setup works the same way as a local installation.

The image builds its WebUI, Node archive, native helpers, resources and notices from source; host build outputs, installation data and private caches are not inputs. Large optional Code workbench assets and the separately pinned optional HEIC decoder are not bundled.

This command starts only the `foxwarm` service. The repository also defines an optional paired sandbox client; you do not need it to try the WebUI.

For container logs and shutdown:

```bash
docker compose logs -f foxwarm
docker compose down
```

If you change `bot.httpPort`, update the Compose port mapping and healthcheck as well. For a chat or embedding service on the Docker host, use a host-reachable address; `localhost` inside Foxwarm's container refers to that container.

## Manual checkout

For development or a manual Linux x64/WSL install:

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
npm run build-all
mkdir -p ../foxwarm-data
printf "%s\n" "$PWD/../foxwarm-data" > data_dir
export FOXWARM_DATA_DIR="$PWD/../foxwarm-data"
npm start
```

The `data_dir` pointer keeps subsequent starts pointed at the same data directory. The installer creates it automatically. For source changes and tests, see the repository's [development guide](https://github.com/550W-HOST/foxwarm/blob/main/docs/development.md).
