---
name: foxwarm-maintenance
description: "Use for safely maintaining a Foxwarm installation: restarting, reading logs, updating from upstream, and protecting runtime data in state/agents/data_dir layouts."
---

# Foxwarm Maintenance

Use this skill when the task is to operate or update a running Foxwarm installation: inspect health, read logs, restart, upgrade from upstream, or reason about `data_dir` / `state/` / `agents/` layout safety.

## Safety Rules

- Do not restart, stop, upgrade, migrate data layout, or rewrite git history unless the user has authorized that action.
- Never use broad destructive commands such as `git reset --hard`, `git clean -fdx`, or unscoped `rm -rf` in a live install. They can delete runtime data.
- Treat `state/`, `agents/`, tokens, model/channel configs, session archives, vector DBs, and logs as user data unless proven otherwise.
- Before changing code or pulling from upstream, inspect the source repo status and the data directory layout.
- Prefer fast-forward/merge-based updates and scoped file operations. Preserve evidence and report blockers instead of forcing through conflicts.

## First: Identify the Install Layout

From the Foxwarm program repo root, collect:

```bash
pwd
git status --short --branch
git remote -v
cat data_dir 2>/dev/null || true
printf 'FOXWARM_DATA_DIR=%s\n' "${FOXWARM_DATA_DIR:-}"
```

Resolve the data root in this order:

1. `$FOXWARM_DATA_DIR`, if set for the running process or current shell.
2. The repo-root `data_dir` pointer file, if present.
3. The program repo root itself, for older/manual installs.

Runtime data normally lives under the data root:

```text
<data-root>/state/
<data-root>/agents/
```

Bundled skills live in the program repo under:

```text
<repo>/skills/
```

## Read Logs

For local/tmux installs:

```bash
DATA_ROOT="$(cat data_dir 2>/dev/null || pwd)"
tail -n 200 "$DATA_ROOT/state/logs/foxwarm.log"
tail -f "$DATA_ROOT/state/logs/foxwarm.log"
```

If `FOXWARM_DATA_DIR` is used, prefer that value:

```bash
tail -n 200 "$FOXWARM_DATA_DIR/state/logs/foxwarm.log"
```

To inspect the live tmux console:

```bash
tmux attach -t "${FOXWARM_TMUX_SESSION:-foxwarm}"
# detach without stopping: Ctrl-b then d
```

For Docker Compose installs:

```bash
docker compose logs --tail=200 foxwarm
docker compose logs -f foxwarm
```

## Restart

Ask for confirmation before restarting a live instance.

Local/tmux install:

```bash
cd /path/to/foxwarm
npm run restart
```

If the install uses a custom tmux session or data dir, preserve those environment variables:

```bash
FOXWARM_TMUX_SESSION=my-session FOXWARM_DATA_DIR=/path/to/foxwarm-data npm run restart
```

Foreground/manual process:

```bash
npm run build-all
npm run start:notmux
```

Docker Compose:

```bash
docker compose up -d --build
# or, for config/runtime-only changes that do not need rebuilding:
docker compose restart foxwarm
```

## Update From Upstream Safely

### 1. Confirm scope and authorization

Explain that updating may rebuild and restart Foxwarm. Confirm the target branch/ref and whether restart is allowed.

### 2. Inspect source and data layout

```bash
cd /path/to/foxwarm
git status --short --branch
git fetch --all --prune
cat data_dir 2>/dev/null || true
ls -ld state agents 2>/dev/null || true
git submodule status 2>/dev/null || true
find state agents -maxdepth 2 -name .git -print 2>/dev/null || true
```

Classify the data layout before pulling.

### Case A: data directory is outside the source repo

This is the safest layout. The installer default is usually a sibling directory such as `../foxwarm-data`, referenced by repo-root `data_dir`.

Recommended update:

```bash
git pull --ff-only
npm run build-all
npm run restart
```

If `--ff-only` fails, stop and report the divergence instead of rebasing/resetting automatically.

### Case B: data directory is inside the repo as a nested repo or submodule

Examples:

- `state/` and/or `agents/` are nested git repositories.
- `state/` and/or `agents/` are submodules.
- A single in-repo data directory is ignored by the outer repo and has its own `.git`.

Before updating:

```bash
git status --short --branch
git submodule status 2>/dev/null || true
git -C state status --short --branch 2>/dev/null || true
git -C agents status --short --branch 2>/dev/null || true
```

Rules:

- Do not run outer-repo cleanup commands that recurse into or delete nested data repos.
- Do not update submodule pointers unless that is explicitly part of the task.
- If nested data repos have changes, leave them alone unless the user asked for data backup/commit work.
- Pull/update only the program repo, then build and restart if authorized.

### Case C: data directory is inside the repo as untracked files/directories

This layout is risky because upstream changes, cleanup commands, or future tracked paths can collide with user data.

If you see untracked runtime paths such as:

```text
?? state/
?? agents/
```

or an untracked in-repo data directory, do **not** blindly pull/clean. Recommend a user-authorized migration first.

Preferred migration options:

1. Move data outside the program repo and write a `data_dir` pointer.
2. If the user wants data to stay physically inside the checkout, convert it into an ignored nested data repo:
   - add the runtime data path (for example `/state/`, `/agents/`, or `/foxwarm-data/`) to the outer repo `.gitignore`;
   - initialize or attach a separate nested git repo for that data if the user wants versioned backups;
   - verify the outer `git status` no longer lists runtime data as untracked.

Only perform this migration after explicit user approval and, when practical, a backup.

### 3. Pull/build/restart

After data safety is clear:

```bash
git pull --ff-only
npm run build-all
npm run restart
```

For Docker Compose:

```bash
git pull --ff-only
docker compose up -d --build
```

After restart, verify:

```bash
tail -n 100 "${FOXWARM_DATA_DIR:-$(cat data_dir 2>/dev/null || pwd)}/state/logs/foxwarm.log"
```

## Quick Troubleshooting Checklist

- WebUI not reachable: check the port in `state/config.yaml`, tmux console, and `state/logs/foxwarm.log`.
- Restart does not affect the right instance: check `FOXWARM_TMUX_SESSION`, `FOXWARM_DATA_DIR`, and `data_dir`.
- Update blocked by git status: identify whether dirty paths are source files or runtime data; do not stash or clean runtime data blindly.
- Model/channel config broken: inspect `state/models.yaml` and `state/config.yaml` in the resolved data root, not necessarily the program repo root.
- After a code update, remember that initialized `agents/` data is user-owned; framework templates in `templates/` do not automatically overwrite live agent memory.
