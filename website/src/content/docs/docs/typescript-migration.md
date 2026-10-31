---
title: Migrate a TypeScript installation
description: Prepare an existing TypeScript Foxwarm instance for its first C# startup.
---

This guide is for an existing instance running the TypeScript Main process. New users should follow [Install Foxwarm](/docs/installing/). Later C# updates use the ordinary [update procedure](/docs/data-upgrades-backups/).

The C# runtime reads supported existing Session files and Archive data. Keep the installation and data locations consistent through the switch; do not start two Main processes over the same state.

## 1. Record the current installation

Before changing source, identify:

- the program checkout and revision;
- the selected data directory, including any `FOXWARM_DATA_DIR` or `data_dir` setting;
- the effective application configuration and launch command;
- any external Agent/workspace directories or separately installed optional assets;
- running work, including independent exec jobs and Session Worker processes.

The data root contains `state/` and, by default, `agents/`. Preserve the root selection and configured external paths. Relative `data_dir` paths remain relative to the installation directory.

## 2. Check configuration and feature differences

### Configuration files

C# Main reads `<data-root>/state/config.yaml` and `<data-root>/state/models.yaml`. The former `FOXWARM_CONFIG_PATH` and `CONFIG_PATH` environment overrides no longer select another application YAML file.

If your launch configuration used either override, back up that effective file and reconcile its contents into the selected data root's `state/config.yaml` before starting C#. Review an existing destination rather than overwriting it blindly. Update the service configuration to use the intended data root. The separate MCP configuration still supports `MCP_CONFIG_PATH` and `paths.mcpConfigPath`.

Preserve your customized Agent memory and framework prompt. Updating bundled templates is not a reason to replace the live files.

### Work that must finish before the switch

- Finish independent TypeScript native exec jobs. Stopping Main alone does not prove those jobs have ended, and C# does not automatically adopt or replay them.
- Complete the old Session Worker handback before switching. Active Worker ownership blocks source-build promotion. Inactive mailbox residue is retained and reported without replay.
- Session Worker process hosting and managed ToolScript/controller hosting are not implemented in C# Main. Preserve their records and arrange how their work will end before migrating.
- Main's TUI is not available. An explicit `--tui` launch fails; a persisted `bot.enableTUI` setting is reported as unsupported. Use the WebUI or configured Channels.

### Optional dependencies

Install the [C# source prerequisites](/docs/installing/#before-installing-from-source) before the update. If you use semantic search, check its [native platform and embedding-service requirements](/docs/history-search/#enable-semantic-search). A working main process does not by itself establish that optional search loaded successfully.

Custom Code asset placement should follow the current [workbench setup](https://github.com/550W-HOST/foxwarm/blob/main/packages/vscode-web/README.md); the former `FOXWARM_VSCODE_*` resource/location overrides are no longer used.

## 3. Stop and back up

Drain accepted work and stop the old Main process. Confirm that independent jobs and old Worker owners have also finished their relevant work.

Make a consistent backup of the complete data directory, customized external configuration and Agent/workspace paths. Keep the previous revision and runtime needed for recovery. Copy SQLite files only after their writers have stopped, or use a SQLite-consistent online backup that includes committed WAL data. See [backup guidance](/docs/data-upgrades-backups/#what-to-back-up).

## 4. Update the same installation

Use the [source update commands](/docs/data-upgrades-backups/#update-a-source-installation) for your platform, retaining the same data root. Container installations should preserve their existing data mounts when rebuilding.

Source builds prepare a new runtime in staging and run read-only Session upgrade inspection before selecting it. Global or active-Worker blockers prevent selection and leave the previous output available; inspect the reported owners and finish the required old-runtime work. Session-local warnings identify affected records without deleting or replaying them.

A failed build does not select its partial output. A failure after the old process has stopped can leave the service stopped; inspect the error before restarting. Do not replace newer data automatically with an older backup.

## 5. Verify the migrated instance

After starting C#:

1. Confirm that it uses the expected data directory and existing token/configuration.
2. Open an existing conversation and check its history.
3. Continue a conversation and verify a tool effect in an owned test location.
4. Check configured Channels, Nodes, MCP connections and optional search.
5. Restart once more and confirm that the new conversation state and effect remain.

C# writes are not qualified for a code-only downgrade to the retired TypeScript runtime. Recovery must use a compatible complete restore set, not an older executable against arbitrarily newer state. Keep old runtime directories while any independent helper still needs them; never reconstruct missing active Session history from Archive.
