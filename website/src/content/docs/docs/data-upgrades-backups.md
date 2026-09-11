---
title: Data, upgrades, and backups
description: Understand Foxwarm data layout, make a consistent backup, and update the program checkout.
---

Foxwarm keeps the program checkout separate from runtime data.

The default installer creates:

```text
foxwarm/       program checkout and bundled Skills
foxwarm-data/  configuration, Agents, Sessions, tokens, logs, and databases
```

The checkout's `data_dir` file points to the active data directory, so later starts return to the same state.

## What to back up

Back up the whole data directory as one restore set. Along with YAML configuration, it contains:

- `agents/` memory and workspaces
- `state/models.yaml` and `state/config.yaml`
- access and Node tokens
- Session metadata and archives
- SQLite databases, reservation records, and recovery journals
- optional derived vector data

Logs are only one part of the state. Restore the databases and the rest of the data directory from the same snapshot.

## SQLite consistency

A live instance needs a SQLite-consistent online backup. A simpler option is to stop Foxwarm cleanly, confirm that it has stopped, and copy the complete data directory. A `.sqlite` file copied while its WAL writer is active is incomplete.

## Upgrade

Before updating an important instance:

1. Read changes on the public `main` branch.
2. Stop Foxwarm cleanly.
3. Create a consistent full data-directory backup.
4. Update the program checkout.
5. Reinstall/build using the project commands for your platform.
6. Start Foxwarm and verify WebUI, model access, and any configured Channels or Nodes.

For a default Linux/macOS installer checkout:

```bash
cd foxwarm
npm run stop
git pull --ff-only origin main
npm run build-all
npm start
```

On Windows, run `npm run stop:windows`, update the checkout, and then run `npm run start:windows`. The start command installs and builds after the old process stops, which avoids replacing native files that are still loaded.

:::caution
If the checkout contains local work, review and preserve it before updating. `git reset --hard` will discard those changes.
:::

For archive storage details and external JSONL export, see [Archive Store](https://github.com/550W-HOST/foxwarm/blob/main/docs/archive-store.md).
