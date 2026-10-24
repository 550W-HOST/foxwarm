---
name: foxwarm-maintenance
description: "Foxwarm source updates and restarts, data layout, backup and restore boundaries, and upgrade checks. Use when updating a source installation or assessing changes to its storage and persisted data."
---

# Foxwarm Maintenance

This skill covers installation details that are specific to Foxwarm. For the
public source checkout, use the source-update procedure below. Use an
installation's own runbook for custom deployment, backup destinations and
retention. Inspect its actual configuration rather than assuming a process
manager, repository layout, or remote.

## Data layout and ownership

Resolve the running process's data root in this order:

1. Nonempty `FOXWARM_DATA_DIR` in its environment.
2. Nonempty `data_dir` file in the program repository.
3. The program repository itself.

Relative values resolve against the program repository, not the operator's shell
working directory. A shell's environment may differ from the running service.

- `<data-root>/state/` contains configuration, credentials, Session authority,
  databases, blobs, and logs. `<data-root>/agents/` contains user-owned Agent
  files and the live framework prompt.
- `<program-repo>/skills/` supplies global skills unless `paths.skillsDir`
  selects another directory. Source builds also copy skills into their payload
  for standalone publication. Templates and native resources come from the
  running binary's resource directory; templates initialize defaults and do not
  replace initialized user data.
- `state/` and `agents/` may be separate repositories or worktrees. A source
  commit, pull, or push does not necessarily include either one. Inspect each
  repository boundary before updating or backing up; do not sweep user data into
  a source commit or change nested repository pointers incidentally.
- Untracked data inside a source checkout is still user data. Preserve it across
  source updates; moving the data root is a separate migration.

## Backup and restore

Read [Backup and Restore](references/BACKUP-RESTORE.md) for the restore-set
contents, consistency boundaries, and the bundled SQLite chunk helper:

```bash
python3 skills/foxwarm-maintenance/scripts/sqlite-chunks.py create SOURCE.sqlite NEW-SNAPSHOT-DIRECTORY
python3 skills/foxwarm-maintenance/scripts/sqlite-chunks.py verify SNAPSHOT-DIRECTORY
python3 skills/foxwarm-maintenance/scripts/sqlite-chunks.py restore SNAPSHOT-DIRECTORY NEW.sqlite
```

Run these from the program repository. They operate on one SQLite component,
not a complete installation. Online SQLite backups must include committed WAL
state through the backup API; copying the main database file alone is unsafe.
A live LanceDB directory also needs a verified snapshot or quiesced capture.
Restore to new paths and verify before any authorized replacement of live data.

## Upgrades and runtime changes

Read [Source Updates](references/SOURCE-UPDATES.md) for first C# prerequisites,
the public pull/build/restart sequence, generated output ownership and old-output
retention for independent exec helpers. Build staging under `build/` is separate
from runnable outputs under `runtime/`, even on the first startup.

Read [Post-Upgrade Checks](references/POST-UPGRADE.md) from the target revision
when planning an upgrade. Source, initialized configuration, and Agent memory
have separate ownership; an update must not silently replace the latter two.

Use the installation's existing launch configuration, including its data root
and environment. A source update, successful build, and running replacement are
separate facts. Report which happened. Confirm the intended runtime payload and
data root after restart. Source edits alone do not update resources already
collected into a running payload, such as the WebUI and native helpers.
