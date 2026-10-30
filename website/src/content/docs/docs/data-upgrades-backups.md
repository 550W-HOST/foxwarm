---
title: Data, updates, and backups
description: Find your data, make a consistent backup, and update Foxwarm.
---

## Where your data lives

A new source installation made by the installer has this layout:

```text
foxwarm/           program checkout, dependencies and build output
  data_dir         text file containing the data-directory path
foxwarm-data/      configuration, Agents, Sessions, tokens, logs and databases
```

The data directory is the parent of `state/` and `agents/`, not the `state/` directory itself. The default Docker Compose setup instead mounts its checkout's `foxwarm-data/` at `/data` in the container.

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

## Update a source installation

Review the target changes, preserve any local edits, and make a consistent backup before updating an important instance. Keep the existing installation and data paths.

Existing TypeScript installations should use the [migration guide](/docs/typescript-migration/) for their first C# update.

### Linux x64 or WSL

From the program checkout:

```bash
cd foxwarm
npm run stop
# Back up the complete data directory before continuing.
git pull --ff-only origin main
npm start
```

`npm start` installs the locked dependencies, builds the app and starts it in tmux. For later restarts after a reviewed update, `npm run restart` prepares the new build while the old Main runs, then stops the old Main, selects the new output and sends the startup command. A build failure leaves the old Main running; a successful command send still needs a startup check.

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

Completed runtime outputs are retained under the checkout's `runtime/`. Older independent jobs may still use an earlier output, so keep it until its consumers finish. Never remove the output selected by `runtime/current`. See [source updates and runtime retention](https://github.com/550W-HOST/foxwarm/blob/main/skills/foxwarm-maintenance/references/SOURCE-UPDATES.md) for the detailed controls.

## Update a Docker installation

Stop the service and back up its mounted data before an important update. From the same Compose checkout and with the same project/volume configuration:

```bash
docker compose stop foxwarm
# Back up the mounted data before continuing.
git pull --ff-only origin main
docker compose up -d --build foxwarm
```

Check `docker compose logs foxwarm` and the WebUI afterward. Retain the existing data mount; rebuilding the image does not require a new data directory.

:::caution
If the checkout contains local work, review and preserve it before updating. `git reset --hard` discards those changes.
:::

For archive storage details and external JSONL export, see [Archive Store](https://github.com/550W-HOST/foxwarm/blob/main/docs/archive-store.md).
