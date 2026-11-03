# Post-Upgrade Checks

Read this file from the target revision when planning an upgrade. Apply only
changes relevant to that installation; changing source does not authorize a
user-data migration or replacement of customized configuration.

For the first update from TypeScript Main, read the dedicated
[migration guide](https://foxwarm.net/docs/typescript-migration/).

## Source build and restart

For a public source checkout, follow [Source Updates](SOURCE-UPDATES.md). Check
the C# prerequisites before building, preserve the installation/data roots, and
confirm a running replacement separately from a successful build. Restart
removes earlier runtime outputs after the old Main has stopped.

## Framework prompt

| File | Role |
| --- | --- |
| `<program-repo>/templates/agents/00_SYSTEM.md` | Bundled framework prompt; updated with Foxwarm |
| `<data-root>/agents/00_SYSTEM.local.md` | Optional installation additions, appended after the bundled prompt |
| `<data-root>/agents/00_SYSTEM.md` | Legacy copy from an earlier release; replaces the bundled prompt when edited |
| `<data-root>/agents/main/memory/00_SYSTEM.md` | Older legacy copy, used only when the previous file is absent |

Startup removes legacy copies that are byte-identical (apart from line endings)
to a released template. An edited legacy copy keeps working as a full
replacement, and Main logs that the installation is not receiving framework
prompt updates. With the administrator's approval, migrate it: compare it with
the bundled template, move only the installation-specific instructions to
`agents/00_SYSTEM.local.md`, then delete the legacy file. Do not overwrite the
bundled template for one installation.

## Configuration and persisted data

Review release notes, changed templates, and migrations for the target revision.
Distinguish a required format migration from an optional new setting or changed
default. Resolve the actual data root before editing a live file. Main reads
`<data-root>/state/config.yaml` and `<data-root>/state/models.yaml`; retired generic
configuration-filename environment overrides do not redirect these files. The
separate MCP configuration retains `MCP_CONFIG_PATH` / `paths.mcpConfigPath`.

For a persisted-format change, identify whether the previous runtime can still
read newly written data. Retain a verified restore set before applying a change
that would make a code-only rollback unsafe. Do not reconstruct active Session
history from Archive as a substitute for missing authoritative JSON.

## Verify the intended result

Check the affected behavior using the installation's normal entry point. If a
backend restart was needed, confirm that the replacement uses the intended
revision and data root. A template or memory edit does not itself rebuild every
existing Session's prompt snapshot; refresh snapshots only when that is part of
the approved change.
