# Unit: Skill resolution and runnable skills

Files: `dotnet/Foxwarm/Skills.cs`, `dotnet/Foxwarm/SkillRuns.cs`, `dotnet/Foxwarm.Tests/Tools/RunnableSkillTests.cs`

## Purpose

`Skills` enumerates and resolves the configured Agent skills (Agent-local, inherited and global) for the catalog, `skill load` and `skill run`, and validates a skill's optional runnable entry. The catalog text in the memory snapshot is owned by the [Session domain](./session-domain.md); running an entry is a [ToolScript](./toolscript.md#d-toolscript-skill-entry-source) run, and the `skill` commands are in the [ctl command registry](./ctl-command-registry.md).

## Runnable skills

**User decisions (2026-11-23).** A skill may declare one runnable entry, run with `ctl skill run` without loading `SKILL.md`. The entry's source is read through the skill subsystem under the `run_skill` rule, not through `read` on master (Q9), and every entry is one self-contained file (Q10; ToolScript has no local import, [D-toolscript-top-level-source](./toolscript.md#d-toolscript-top-level-source)).

**User decision (2026-11-25).** The catalog shows a runnable skill's args schema, so a model can call it without loading it or running `--help`: a skill with `run.args` gets `<args>` holding the compact JSON Schema right after its `<run>`, and the catalog's sentence says that `<args>` gives the arguments and a skill without it takes none. The compact schema may have at most 1000 characters (`Skills.MaxArgsLength`).

`SKILL.md` frontmatter `run:` holds `entry` (a path relative to the skill directory), `effect` (one line of at most 200 characters, shown in the catalog), optional `mode` (`foreground`, the default, or `background`), optional `timeoutSecs` (a positive number), and optional `args`, a JSON Schema object of at most 1000 characters as compact JSON, limited to `type`, `properties`, `required`, `enum`, `items`, `description` and `additionalProperties`. Without `args` the entry takes no arguments. Frontmatter keeps untagged scalars as strings (`FrontMatterYaml`), so `Skills.ParseRun` converts `additionalProperties` to a boolean and `enum` values to the declared type; a `required` name must be a declared property. `SkillRun.ArgsText` is that normalized schema serialized once with `JsonText.ToJsonText` (compact, declared property order, relaxed escaping, so non-ASCII stays literal); the length limit measures it, and the catalog shows it XML-escaped. It is null without `run.args`. The runner applies no defaults; the script handles absent values.

`Skills.BuildAsync` validates the block for listing and loading alike. An invalid block (unknown field, wrong type, an over-long effect or args schema, an entry that escapes or is missing) leaves the skill listed and loadable, with `SkillInfo.Run` null and `RunError` saying why; `skill run` reports that reason and the catalog omits `<run>` and `<args>`. `Skills.EntryPath` accepts only `/`-separated relative paths without empty, `.` or `..` segments, colons or backslashes, and requires each component below the skill directory to be a real directory or regular file, never a reparse point. Older Foxwarm versions read only `description` and ignore `run`.

`Skills.ReadEntryAsync` resolves the name exactly as `LoadAsync` does (Agent-local, inherited, global; the first valid match wins, so a non-runnable local skill shadows a runnable global one; nested skills are rejected), rechecks the entry path, reads it as strict UTF-8 (a leading BOM is dropped; an empty entry is an error) and returns it with the SHA-256 of its bytes. Every skill root is a Main server directory, so the entry is always read on the Main server, whatever the Session's current Node. `Skills.ValidateArgs` checks run arguments against the schema; errors name the field (`args.question`) and what it expects. The errors of `skill run` are the `skill load` error for an unknown skill, "has no runnable entry; load it with `ctl skill load <name>`", the invalid block's reason, a missing, non-UTF-8 or empty entry, argument errors, and the ordinary failures of the run itself.

## Tests

`RunnableSkillTests` covers valid and invalid `run` blocks, the effect and args length limits, the compact `args` text, entry containment (`..`, absolute, backslash, missing, a linked file or directory, non-UTF-8), the entry hash, local, inherited and global resolution with shadowing and nested-skill rejection, argument validation including values built in code, the catalog's prefix guard and `<run>`/`<args>` elements, and the `skill run` command forms.
