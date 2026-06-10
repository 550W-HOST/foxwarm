# Post-Upgrade Checklist

Read this file **after updating the program repo to the new version**. It is kept separate from the main maintenance guide so an agent can re-read the latest post-upgrade advice from the freshly updated checkout.

Do not apply user-data migrations silently. Inspect, summarize the diff/risk, then ask the user before changing live `state/` or `agents/` files.

## 1. Re-resolve the data root

From the program repo root:

```bash
DATA_ROOT="${FOXWARM_DATA_DIR:-$(cat data_dir 2>/dev/null || pwd)}"
printf 'DATA_ROOT=%s\n' "$DATA_ROOT"
ls -ld "$DATA_ROOT/state" "$DATA_ROOT/agents" 2>/dev/null || true
```

Remember that the program repo's `templates/` directory is not automatically applied to initialized user data.

## 2. Check framework prompt template drift

Compare the latest framework prompt template with the live framework prompt actually used by the install.

Current layout:

```text
<program-repo>/templates/agents/00_SYSTEM.md    # latest template
<data-root>/agents/00_SYSTEM.md                 # live framework prompt, preferred location
```

Legacy layout still supported as fallback:

```text
<data-root>/agents/main/memory/00_SYSTEM.md
```

Suggested checks:

```bash
TEMPLATE="templates/agents/00_SYSTEM.md"
LIVE="$DATA_ROOT/agents/00_SYSTEM.md"
LEGACY="$DATA_ROOT/agents/main/memory/00_SYSTEM.md"

ls -l "$TEMPLATE" "$LIVE" "$LEGACY" 2>/dev/null || true

if [ -f "$LIVE" ]; then
  diff -u "$LIVE" "$TEMPLATE" || true
elif [ -f "$LEGACY" ]; then
  diff -u "$LEGACY" "$TEMPLATE" || true
else
  echo "No live framework 00_SYSTEM found; fresh startup may create one."
fi
```

If there is a meaningful template/live diff, summarize it and ask the user whether to merge any changes into the live prompt. Do not overwrite live prompt files automatically; they may contain user edits.

## 3. Consider migrating legacy framework 00_SYSTEM

If the install still uses:

```text
<data-root>/agents/main/memory/00_SYSTEM.md
```

and does not have:

```text
<data-root>/agents/00_SYSTEM.md
```

recommend migrating to the preferred top-level file. This avoids confusing framework-level instructions with main-agent memory.

Safe migration outline, after user approval:

```bash
mkdir -p "$DATA_ROOT/agents"
cp "$DATA_ROOT/agents/main/memory/00_SYSTEM.md" "$DATA_ROOT/agents/00_SYSTEM.md"
```

Then ask whether to keep the legacy file as a temporary backup or remove/rename it after verifying the new prompt works. Runtime code ignores agent memory `00_SYSTEM.md` during normal agent memory loading and uses it only as a fallback when top-level `agents/00_SYSTEM.md` is absent.

## 4. Review other template/config migrations

Check release notes, commits, or docs for new templates or changed defaults that affect initialized data. Common places:

```text
templates/
docs/session-management.md
docs/development.md
README.md
```

For each candidate migration:

1. Identify the live user-owned file under `DATA_ROOT`.
2. Diff template/default vs live file.
3. Explain what changed and whether it is required or optional.
4. Ask before merging into live data.

## 5. Verify after migration/restart

After any approved post-upgrade changes:

```bash
npm run build-all
npm run restart
# then inspect logs
tail -n 120 "$DATA_ROOT/state/logs/foxwarm.log"
```

For Docker Compose installs, use the compose build/restart flow and read `docker compose logs` instead.
