---
title: Install Foxwarm
description: Install Foxwarm on Linux, macOS, WSL, or Windows and open the local WebUI.
sidebar:
  order: 1
---

The installer clones Foxwarm into `./foxwarm`, creates `./foxwarm-data` for runtime state, builds the app, starts it, and prints a local WebUI URL containing the login token.

:::note
The project site hosts the installers, but your Foxwarm WebUI and API run on your own machine. `foxwarm.550w.host` is not a hosted agent service.
:::

## Linux, macOS, or WSL

### Prerequisites

Install these before running the script:

- Git
- Node.js 20 or newer, including npm
- tmux

The installer checks prerequisites but does not install system packages.

```bash
curl -fsSL https://foxwarm.550w.host/install-foxwarm.sh | bash
```

When startup finishes, open the tokenized URL printed by the script, typically on `http://localhost:3001/`.

Useful overrides:

```bash
curl -fsSL https://foxwarm.550w.host/install-foxwarm.sh | bash -s -- \
  --dir "$PWD/foxwarm" \
  --data-dir "$PWD/foxwarm-data"
```

Environment variables are also supported:

```bash
export FOXWARM_DIR="$PWD/foxwarm"
export FOXWARM_DATA_DIR="$PWD/foxwarm-data"
export FOXWARM_TMUX_SESSION=foxwarm
export FOXWARM_BRANCH=main
curl -fsSL https://foxwarm.550w.host/install-foxwarm.sh | bash
```

Attach to the console with `tmux attach -t foxwarm`. Detach without stopping the app by pressing <kbd>Ctrl</kbd>+<kbd>b</kbd>, then <kbd>d</kbd>.

## Windows PowerShell

### Prerequisites

Install Git for Windows and Node.js 20 or newer with npm. Then open PowerShell:

```powershell
irm https://foxwarm.550w.host/install-foxwarm.ps1 | iex
```

The Windows installer builds Foxwarm, starts it as a background process, and opens the tokenized local WebUI URL when available. It does not require tmux or WSL.

If local script execution is blocked, download the script and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-foxwarm.ps1
```

Optional paths and branch:

```powershell
.\install-foxwarm.ps1 -InstallDir .\foxwarm -DataDir .\foxwarm-data -BranchName main
```

Stop a running Windows instance before rerunning the installer:

```powershell
cd foxwarm
npm run stop:windows
```

## Manual checkout

If you are developing Foxwarm or want to inspect the installer first:

```bash
git clone https://github.com/550W-HOST/foxwarm.git foxwarm
cd foxwarm
npm run build-all
```

Create an external data directory and a persistent pointer to it:

```bash
mkdir -p ../foxwarm-data
printf "%s\n" "$PWD/../foxwarm-data" > data_dir
export FOXWARM_DATA_DIR="$PWD/../foxwarm-data"
npm start
```

Read the token from `../foxwarm-data/state/token` if the startup output is no longer visible.

## Next step

Continue to [Set up your first model](/docs/model-setup/).
