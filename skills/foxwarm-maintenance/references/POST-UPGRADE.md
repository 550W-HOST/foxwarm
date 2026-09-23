# Post-Upgrade Checks

Read this file from the target revision when planning an upgrade. Apply only
changes relevant to that installation; changing source does not authorize a
user-data migration or replacement of customized configuration.

## Framework prompt

The bundled template and live prompt are separate files:

| File | Role |
| --- | --- |
| `<program-repo>/templates/agents/00_SYSTEM.md` | Bundled default |
| `<data-root>/agents/00_SYSTEM.md` | Preferred live framework prompt |
| `<data-root>/agents/main/memory/00_SYSTEM.md` | Legacy fallback when the preferred file is absent |

Compare the effective live file with the new template. Explain any relevant
changes and preserve user customizations when an update is approved. Do not copy
the template over the live file as part of a routine source upgrade.

An approved move from the legacy path must preserve the existing prompt content.
Once the top-level file exists, it takes precedence; the legacy file is not
loaded again as ordinary Agent memory.

## Configuration and persisted data

Review release notes, changed templates, and migrations for the target revision.
Distinguish a required format migration from an optional new setting or changed
default. Resolve the actual data root and any configuration-path override before
editing a live file.

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
