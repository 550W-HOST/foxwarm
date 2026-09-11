---
title: Data, upgrades, and backups
description: Keep Foxwarm program files separate from runtime data, upgrade safely, and back up one consistent restore set.
---

Foxwarm separates replaceable program files from user-owned runtime data.

A default installer layout is:

```text
foxwarm/       program checkout and bundled Skills
foxwarm-data/  configuration, Agents, Sessions, tokens, logs, and databases
```

The checkout's `data_dir` pointer records the active external data directory so later starts use the same state.

## What to back up

Back up the **whole data directory as one restore set**. It includes more than YAML configuration:

- `agents/` memory and workspaces;
- `state/models.yaml` and `state/config.yaml`;
- access and Node tokens;
- Session metadata and archives;
- SQLite databases, reservation records, and recovery journals;
- optional derived vector data.

Do not treat logs as the only state, and do not restore one database independently from a mismatched data-directory snapshot.

## SQLite consistency

For a live instance, use a SQLite-consistent online backup process. The simplest conservative procedure is to stop Foxwarm cleanly, verify it is stopped, and then copy the complete data directory. Copying only a `.sqlite` file while its WAL writer is active is not a complete backup.

## Upgrade

Before an important upgrade:

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

On Windows, use `npm run stop:windows`, update the checkout, and run `npm run start:windows`. The Windows start path installs and builds while the old instance is stopped so loaded native files are not replaced in place.

:::caution
Do not run `git reset --hard` as an upgrade strategy when the checkout contains local work. Review local changes and preserve them deliberately.
:::

For archive storage details and external JSONL export, see [Archive Store](https://github.com/550W-HOST/foxwarm/blob/main/docs/archive-store.md).
