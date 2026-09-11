---
title: Install Foxwarm
description: Install Foxwarm on Linux, macOS, WSL, or Windows and open the local WebUI.
sidebar:
  order: 1
---

The installer creates a program checkout at `./foxwarm` and stores runtime state in `./foxwarm-data`. It then builds Foxwarm, starts it, and prints a local WebUI URL with the login token.

:::note
This site hosts the installer files. Your Foxwarm WebUI, API, Agents, and data remain on the machine where you install them.
:::

## Linux, macOS, or WSL

### Before you run the installer

You will need:

- Git
- Node.js 20 or newer, including npm
- tmux

The installer reports missing prerequisites. Install any system packages yourself, then run it again.

```bash
curl -fsSL https://foxwarm.550w.host/install-foxwarm.sh | bash
```

When startup finishes, open the tokenized URL printed by the script, typically on `http://localhost:3001/`.

To choose different locations:

```bash
curl -fsSL https://foxwarm.550w.host/install-foxwarm.sh | bash -s -- \
  --dir "$PWD/foxwarm" \
  --data-dir "$PWD/foxwarm-data"
```

You can set the same locations and startup options with environment variables:

```bash
export FOXWARM_DIR="$PWD/foxwarm"
export FOXWARM_DATA_DIR="$PWD/foxwarm-data"
export FOXWARM_TMUX_SESSION=foxwarm
export FOXWARM_BRANCH=main
curl -fsSL https://foxwarm.550w.host/install-foxwarm.sh | bash
```

Attach to the console with `tmux attach -t foxwarm`. Detach without stopping the app by pressing <kbd>Ctrl</kbd>+<kbd>b</kbd>, then <kbd>d</kbd>.

## Windows PowerShell

### Before you run the installer

Install Git for Windows and Node.js 20 or newer with npm, then open PowerShell:

```powershell
irm https://foxwarm.550w.host/install-foxwarm.ps1 | iex
```

The Windows installer builds Foxwarm, starts it in the background, and opens the tokenized local WebUI URL when it becomes available. Windows installs do not require tmux or WSL.

If local script execution is blocked, download the script and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-foxwarm.ps1
```

To choose paths or a branch:

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

## Continue with model setup

When WebUI opens, [set up your first model](/docs/model-setup/).
