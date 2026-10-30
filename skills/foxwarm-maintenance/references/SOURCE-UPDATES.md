# Updating a source installation

Use this procedure for the public source checkout. A packaged runtime, container,
or installation with its own deployment runbook has a different build/control
boundary. Obtain approval for the target installation and restart before acting.

## Prerequisites

Check these before building a source installation:

- A .NET SDK that supports `net10.0`, and the ASP.NET Core 10 runtime.
  Check the selected tools with `dotnet --version`, `dotnet --list-sdks` and
  `dotnet --list-runtimes` from the checkout.
- Git, Node.js 20.19+ in the 20.x line or 22.12+ in newer supported lines, and npm.
- Linux x64: tmux for the Bash controls, Python 3, make, GCC/G++, and the
  development files providing `pty.h` and libutil. The root npm dependency
  node-pty still needs its native build tools.
- Windows x64: Python 3 for a fresh pinned Monty worker acquisition. The Windows
  controls use PowerShell and the background Main control pipe, not tmux.
- Access to the locked npm/NuGet dependencies and the pinned Monty artifact, or
  already provisioned compatible caches. The scripts do not install host tools.

Linux x64 and Windows x64 are the source installation targets; macOS Main is
not supported by this workflow. For an existing TypeScript Main installation,
first read the [migration guide](https://foxwarm.550w.host/docs/typescript-migration/).
Optional Vector search has additional [native platform requirements](https://foxwarm.550w.host/docs/history-search/#enable-semantic-search).

## Pull and restart

Inspect the checkout, branch and local changes first. Review the target revision
and [Post-Upgrade Checks](POST-UPGRADE.md), including persisted-data compatibility
and the installation's backup policy. Preserve the installation root, `data_dir`,
selected data root, initialized configuration and Agent content.

For the existing Linux tmux installation, from its checkout:

```bash
git pull --ff-only
./scripts/restart.sh
```

Use the installation's existing `FOXWARM_TMUX_SESSION`, `FOXWARM_DATA_DIR`, PATH
and other launch settings. Restart installs the root/WebUI lockfiles and builds
the complete resources in staging while the old Main continues running. Only a
successful build proceeds to Ctrl+C, waits for the exact dedicated tmux pane's
foreground Main to drain, promotes the output, and sends the new launch command.
For first startup, `./scripts/start.sh` uses the same staging and promotion; it
refuses an existing exact session. Restart also creates the session if absent.

On Windows, `npm run restart:windows` builds with the already installed npm
dependencies, then stops Main, promotes and starts the replacement. If lockfiles
changed or dependencies are missing, use `npm run stop:windows` followed by
`npm run start:windows`; the latter installs both lockfiles before building.
PowerShell `scripts/start.ps1` and `scripts/restart.ps1` use these commands;
`-SkipBuild` starts/restarts the already selected runtime. First source installers
perform the same prerequisite checks and preserve their external data directory.

For a foreground source launch, `npm run build-all` followed by `node .` builds
and selects the complete payload. With dependencies already installed,
`npm run build` (or `npm run build:delivery`) suffices. A build alone does not
restart an existing Main. `npm run build:core` uses the same separate output
layout for backend-only development and does not prepare complete frontend
assets. Plain `dotnet build` retains its ordinary developer output and does not
change the runtime selected by the package entry or one-shot CLI.

## Output ownership and retention

The checkout has two generated, Git-ignored top-level directories:

- `build/core/`: disposable staging for a build. Each build starts clean here;
  a build failure removes partial staging and leaves the selected runtime alone.
- `runtime/`: completed runnable outputs, each in its own uniquely named
  directory. Promotion moves the staged directory here and updates
  `runtime/current`, a directory symlink on Linux or junction on Windows.

The Main/package entry, Windows launcher and public one-shot CLI share this
selection. They resolve `runtime/current` to its stable real directory before
starting .NET. Published packages still select their root apphost or DLL.
Data/configuration paths remain relative to the installation, not to `build/`
or `runtime/`. Compiled WebUI assets, templates and native helpers come from the
selected payload; source changes to them require a new build. Global skills
retain their installation-relative `skills/` default or configured
`paths.skillsDir`. Their packaged copies serve standalone published runtimes.

Older runtime directories are retained deliberately. An independent Linux exec
script records its original DLL path and calls it again to write completion
status, even after Main has restarted. Existing Main/CLI processes and their
helpers can also hold their original resources. Keep an old directory until
those consumers have finished; stopping Main alone is not sufficient. Remove
obsolete directories manually after checking this condition, and never remove
the selected target of `runtime/current`. There is no automatic cleanup or
rollback service. On the first update from the earlier Debug-output layout,
retain `dotnet/Foxwarm/bin/Debug/net10.0` until its old processes and independent
execs have finished as well.

Build and restart operations on one checkout should be run serially. The scripts
use ordinary directory moves/link changes; they do not coordinate concurrent
builders or provide a transaction across process shutdown and startup.

## Confirm completion

Distinguish these outcomes in the report:

- **Build failed:** restart did not stop the old Main or replace its binary
  output. Source files/dependency installation may already have changed. Correct
  the build failure and rerun the command; do not report a deployment.
- **Build succeeded:** the output is complete. `npm run build` selects it for
  subsequent launches, but an already running Main keeps its previous output.
- **Restart sent/completed:** the Bash script reports that it sent startup, not
  application readiness. Confirm Main's startup log, expected HTTP behavior,
  executable directory and retained data before reporting the update complete.
  A failure after shutdown can leave Main stopped; inspect the error and use the
  normal controls after correcting it.

These checks do not authorize a data restore, template overwrite or change to
an installation's branch/deployment policy.
