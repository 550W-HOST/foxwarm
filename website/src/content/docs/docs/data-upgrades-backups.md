---
title: Data, updates, and backups
description: Find your data, make a consistent backup, and update Foxwarm.
---

## Where your data lives

An installation made by the installer has this layout:

```text
foxwarm/           program directory
  data_dir         text file containing the data-directory path
  foxwarmctl       start, stop, update and status commands
  runtime/current  the selected release
foxwarm-data/      configuration, Agents, Sessions, tokens, logs and databases
```

The data directory is the parent of `state/` and `agents/`, not the `state/` directory itself. A source checkout uses the same `data_dir` pointer. The Docker examples mount `foxwarm-data/` at `/data` in the container.

### Selecting a directory

The installer chooses the explicit data-directory argument first, then `FOXWARM_DATA_DIR`, then an existing `data_dir` pointer. A fresh installation without a selection uses the sibling `foxwarm-data` directory. Rerunning the installer without an override keeps the saved selection.

Normal startup uses `FOXWARM_DATA_DIR`, then the installation's `data_dir`, then the installation directory itself. Relative saved paths resolve from the installation directory; relative paths passed to the installer resolve from the directory where you invoked it. An ordinary startup environment override does not rewrite the saved pointer.

Changing the pointer selects a directory; it does not copy or move data. To move an instance, stop Main and any independent jobs still using its files, copy the complete data directory, update the pointer or service configuration, and verify the instance before removing the old copy. Keep the existing data directory when updating program code.

## What to back up

Back up the whole data directory as one restore set. Along with YAML configuration, it contains:

- `agents/` memory and workspaces;
- `state/models.yaml` and `state/config.yaml`;
- access and Node tokens;
- Session histories, archives, and recovery data;
- optional search indexes.

Include Agent workspaces or other writable paths you have configured outside that directory. Keep credentials private in the backup as well as in the running installation.

A live instance needs a SQLite-consistent online backup. A simpler option is to stop Foxwarm cleanly, confirm that it has stopped, and copy the complete data directory. Stop independent jobs that are still writing into the backup set as well. Copying only a `.sqlite` file while its writer is active can omit committed data still in the WAL. Restore databases and the rest of the state from the same snapshot.

## Update a release installation

Make a consistent backup before updating an important instance, then run from the parent of the program directory:

```bash
./foxwarm/foxwarmctl update          # Linux x64 or WSL
.\foxwarm\foxwarmctl.cmd update      # Windows
```

`update` downloads the release for the same package type and verifies its checksum. The new release first checks the existing data while the old one keeps running; a blocking problem leaves the installed release unchanged. Foxwarm is then stopped (ended after 60 seconds if it has not exited), the new release is selected, Foxwarm starts again if it was running and the previous release is removed. Add a version, such as `update 0.9.1`, to install a specific release, or `--package FILE` (`-Package FILE` on Windows) to use a downloaded package. Rerunning the installer on an existing installation performs the same update and keeps its data directory.

Existing TypeScript installations should use the [migration guide](/docs/typescript-migration/) for their first C# update.

## Update a source installation

Review the target changes, preserve any local edits, and make a consistent backup before updating an important instance. Keep the existing installation and data paths.

:::caution
If the checkout contains local work, review and preserve it before updating. `git reset --hard` discards those changes.
:::

### Linux x64 or WSL

From the program checkout:

```bash
cd foxwarm
npm run stop
# Back up the complete data directory before continuing.
git pull --ff-only origin main
npm start
```

`npm start` installs the locked dependencies, builds the app and starts it in tmux. For later restarts after a reviewed update, `npm run restart` prepares the new build while the old Main runs, then stops the old Main (killing it if it has not exited after 60 seconds), selects the new output and sends the startup command. A build failure leaves the old Main running; a successful command send still needs a startup check.

### Windows

For an update that may change dependencies:

```powershell
cd foxwarm
npm run stop:windows
# Back up the complete data directory before continuing.
git pull --ff-only origin main
npm run start:windows
```

`start:windows` installs the locked dependencies and builds after the old process has stopped. This avoids replacing loaded native dependencies.

When the installed dependencies already match the checkout, `npm run restart:windows` **builds into staging first**, then stops Main, selects the completed output and starts the replacement. It does not reinstall npm dependencies. The PowerShell start/restart wrappers also accept `-SkipBuild` to use already-built output.

### Check the result

Open the WebUI, confirm that the expected conversations and settings are present, and check a model request plus any configured Channels or Nodes. If startup fails, inspect `state/logs/` in the selected data directory and the platform's process output. Do not overwrite data with a backup just because a new process did not start.

Completed runtime outputs live under the checkout's `runtime/`, selected by `runtime/current`. Restart removes earlier outputs once the old Main has stopped; a standalone build leaves them until the next restart. See [source updates and runtime retention](https://github.com/550W-HOST/foxwarm/blob/main/skills/foxwarm-maintenance/references/SOURCE-UPDATES.md) for the detailed controls.

## Update a Docker installation

Stop the container and back up its mounted data before an important update. With Compose, from the directory that contains its `docker-compose.yml`:

```bash
docker compose stop foxwarm
# Back up the mounted data before continuing.
docker compose pull foxwarm
docker compose up -d foxwarm
```

For a container started with `docker run`, pull `ghcr.io/550w-host/foxwarm:latest`, remove the old container and start a new one with the same data mount. Check the container logs and the WebUI afterward. A new image does not require a new data directory.

For archive storage details and external JSONL export, see [Archive Store](https://github.com/550W-HOST/foxwarm/blob/main/docs/archive-store.md).
