# Unit: src-skills

Files: src/skills.ts, src/skillCatalogSnapshot.test.ts, src/toolscriptSkills.test.ts
Secondary files: skills/web-search/web-search.js, skills/web-search/web-search.test.js, skills/mcp-management/SKILL.md

## Purpose

Implements the skills system: discovering, resolving, and loading skill definitions from multiple sources (agent-local, inherited-agent, global directories). Skills are `SKILL.md`-based knowledge/capability units that can be listed as a catalog and loaded on demand.

## Key Exports

- `SkillMetadata` — interface for metadata parsed from `SKILL.md` frontmatter/body (name, description, etc.)
- `SkillInfo` — interface describing a resolved skill's location, source type, entry document files, and lazily listed resource files
- `SkillDocument` — interface for a loaded skill document (path + content)
- `validateSkillName(skillName)` — validates skill name format
- `formatSkillSourceLabel(skill)` — returns a human-readable source label
- `getSkillInfo(skillName, options)` — resolves a skill by name across search roots
- `listSkills(options)` — lists all available skills with priority-based deduplication
- `loadSkillDocuments(skillName, options)` — loads full document contents for a skill

## Function Index

| Function | Lines (approx) | Description |
|----------|----------------|-------------|
| `validateSkillName(skillName)` | ~50–58 | Validates skill name characters and nested path segments |
| `formatSkillSourceLabel(skill)` | ~60–70 | Formats a human-readable label for skill source type |
| `getAgentSkillsDir(agentName)` | ~72 | Returns the skills directory path for an agent |
| `getSkillDirFromRoot(baseDir, skillName)` | ~76 | Joins base dir with skill name |
| `readAgentMetadataSnapshot()` | ~84–95 | Reads agents.json for inheritance resolution |
| `getAgentInheritanceChain(agentName)` | ~97–115 | Walks agent inheritance with cycle detection |
| `getSkillSearchRoots(agentName)` | ~117–132 | Builds ordered list of directories to search for skills |
| `parseFrontMatter(content)` | ~144–157 | Parses YAML front matter from markdown content |
| `extractHeadingName(content)` | ~159–162 | Extracts first H1 heading as skill name |
| `extractDescriptionParagraph(content)` | ~164–200 | Extracts first prose paragraph as description |
| `parseSkillMarkdownMetadata(content)` | ~202–216 | Combines front matter, heading, and paragraph extraction |
| `readSkillMarkdownMetadata(markdownPath)` | ~218–221 | Reads file and parses markdown metadata |
| `resolveSkillMetadata(skillName, skillDir)` | ~223–270 | Resolves metadata from `SKILL.md` |
| `listSkillDocumentFiles(skillDir, mainDocumentPath)` | ~272–285 | Collects the entry document path for a skill |
| `listSkillResourceFiles(skillDir, documentFiles, maxFiles)` | ~287–335 | Lists supporting resource files under a skill without reading them |
| `isSkillDirectory(dir)` | ~337 | Checks for `SKILL.md` |
| `findParentSkillBoundary(baseDir, skillName)` | ~339–352 | Detects when a requested nested path is inside an existing skill boundary |
| `getSkillInfoFromRoot(skillName, root)` | ~297–320 | Builds a SkillInfo from a single search root |
| `getSkillInfo(skillName, options)` | ~322–350 | Resolves skill across all search roots with priority |
| `findSkillDirectories(baseDir, relativePath)` | ~355–385 | Recursively discovers skill directories |
| `listSkills(options)` | ~387–410 | Lists all skills with deduplication (first match wins) |
| `loadSkillDocuments(skillName, options)` | ~412–423 | Loads all document file contents for a skill |

## Dependencies

- `./common` — `logger`
- `./config` — `AGENTS_FILE`, `getAgentDir`, `SKILLS_DIR`

Test file additionally imports:
- `./commands` — `COMMANDS`
- `./llm` — `buildSessionSystemPromptSnapshot`
- `./tools` — `definitions`
- `./toolsSessionAgent` — `tool_skill({ action: "load" })`

## Behavior

- Skills are resolved with a priority order: agent-local > inherited-agent > global. First match wins during listing and resolution.
- Agent inheritance is walked via `agents.json` with circular reference detection.
- Metadata comes from `SKILL.md` (YAML frontmatter, with heading/first paragraph fallback). `skill.json` is not a supported skill manifest.
- Document files loaded by `loadSkillDocuments` include only the skill's explicit entry document (`SKILL.md`).
- `loadSkillDocuments` also returns a capped list of supporting resource paths (references, scripts, assets, examples, docs, evals, etc.) without reading them; callers include this list in the `skill({ action: "load" })` header for progressive disclosure.
- Skill discovery recursively scans directories that do not already contain `SKILL.md`; once a directory has `SKILL.md`, it is a skill boundary and nested `SKILL.md` files below it are treated as resources, not independent catalog entries.
- Nested skill names such as `vendor/skill-name` remain supported only when the parent directories are ordinary containers without their own `SKILL.md`.
- Resource listing skips non-resource/runtime directories such as `.git`, `node_modules`, `memory`, `build`, `dist`, and `__pycache__`, and caps large listings.
- The bundled global `code-index` skill provides project code-index usage and maintenance guidance under `skills/code-index/`; it uses `units/` for bottom-layer semantic-unit docs, no longer bundles a fixed-source decision extraction script, keeps first-time initialization methods in `INITIALIZATION.md`, and includes `TOP_DOWN_CHILD.md` for top-down/context-carrying initialization. The original `generate_code_index.py` remains the ToolScript `run_script` entry and stays within Monty's supported subset while routing host effects through `call_tool`, as required by [D-code-index-toolscript-host-boundary](./code-index-generators.md#d-code-index-toolscript-host-boundary). `generate_code_index_standalone.py` adds a production-model-CLI-backed batch path with strict path validation, atomic writes, fingerprinted resume state, and explicit `--force` overwrite semantics. A Monty-backed skill test drives the bundled runner through path setup and its first source-scan host suspension so unsupported imports cannot regress unnoticed.
- The bundled global `foxwarm-maintenance` skill restores operational guidance removed from the framework prompt: reading logs, restarting, updating from upstream, and avoiding damage to user-owned `state/` / `agents/` / `data_dir` layouts.
- `foxwarm-maintenance` keeps its post-upgrade checklist in `skills/foxwarm-maintenance/references/POST-UPGRADE.md`, linked explicitly from `SKILL.md` rather than auto-loaded.
- The bundled global `agent-management` skill links explicit reference docs under `skills/agent-management/references/` for Organizer/Executor collaboration patterns, progressive disclosure guidance, and copyable agent `MEMORY.md` templates.
- The bundled global `isolated-worker` skill distinguishes session `currentNode` routing from agent-level isolation and packages `skills/isolated-worker/create_isolated_worker.py`. Existing-Node mode preserves connected non-master validation and its no-length-cap safe agent/session/inheritance names before composing `create_agent(createMainSession=false, isolatedNode)`, `create_session(parentSessionId=coordinator)`, and a complete `send_to_session` handoff. Optional provider-backed mode requires exact provider ID plus exact existing worktree path, section-parses Node topology separately from lifecycle-provider rows, verifies provider `ensure`, uses mutation-free inspect when the Node already exists, and on apply performs provider-neutral ensure then exact ready Docker-worktree/worktree/network validation before agent mutation. Dry run is read-only; apply is fail-fast and deliberately non-transactional, never creates a Git worktree or auto-destroys/deletes resources. Raw exact requested-Node presence is tracked separately from full validation as `present` or `unknown`; unknown becomes `possibleNodeId`, never false absence. Preflight absence and post-ensure presence are observations/possible mutation only, never creation or ownership, because no lease connects list and ensure; provider-backed cleanup retains the Node by default and emits no destroy descriptor without independent confirmation. Recovery reports only actual/possible surviving resources: pre-agent failures emit no agent cleanup, create-agent failure emits it only after a positive agent recheck, create-session failure reports agent without session, and send failure reports Node/agent/session. Companion Python tests mock all nested calls and cover both modes, section aliasing/malformed output, bounds and long-name compatibility, handoff content, mismatch/unknown-presence fences, concurrency-safe ownership truth, ordering, and every failure stage. Canonical workflow: [D-node-isolated-worker-provider-compose](../modules/nodes.md#d-node-isolated-worker-provider-compose).
- The bundled global `toolscript-automation` skill is first-reader guidance for the executable `examples/toolscript/automation_basic.py`. It documents the current Monty language subset, order-independent top-level helpers, direct nested-tool return shapes, owner-session path resolution, safe-checkpoint timeouts, foreground/background behavior, continuation output scope, and discovery of hidden run-management tools. It directs every filesystem/process effect through `call_tool`, does not claim an allocation-count limit, and is checked against the actual registered builtin surface. Tests execute the canonical example and drive the bundled code-index runner under the current async Monty pool API.
- The bundled global `agent-skill-creator` skill adapts `FrancyJGLisboa/agent-skill-creator` (MIT, upstream commit `f8ebbf6fe9262b716b02790fcd75f9922c3c048b`) as a Foxwarm SKILL.md-first skill with explicit references, scripts, examples, tracked demo/static assets, upstream project and design/history documents, and license/attribution files. Its bundled Contributor Covenant is labeled as an upstream reference and does not designate a Foxwarm enforcement contact.
- The bundled global `web-search` skill is fallback-only when provider-native search is unavailable. Its direct helper `skills/web-search/web-search.js` is trusted-host tooling and remains forbidden from isolated environments. It prefers OpenAI Responses API web search (`web_search`, `gpt-5.6-sol` by default), preserves Gemini fallback, and uses one shared 240-second provider timeout. Raw model candidate discovery skips virtual routing entries because they own no credentials; canonical routing contract: [model routing](../threads/model-routing.md). The fallback boundary is canonical in [D-skills-web-search-fallback-boundary](#d-skills-web-search-fallback-boundary).
- The bundled global `timer-automation` skill documents hidden timer tools (`create_timer`, `list_timers`, `update_timer`, `delete_timer`), examples for `call_tool`, and the actual cron syntax supported by the installed `node-schedule`/`cron-parser` runtime, including `L` support and `W` rejection.

## Integration

- Used by `toolsSessionAgent` (`tool_skill`) to load skill documents on demand during agent sessions.
- Used by `llm` module (`buildSessionSystemPromptSnapshot`) to inject an `<available_skills>` catalog into the system prompt; the prompt renders the winning `SkillInfo.sourceType` alongside name/description, preserving this unit's precedence and deduplication result.
- The `/skill` command in `commands` exposes skill listing to users.
- Relies on `config` for directory layout (agent dirs, global skills dir, agents metadata file).

## Design Decisions

### D-skills-web-search-fallback-boundary

[2026-08-11] The bundled `web-search` skill is a fallback for recent/public web lookup, not a competing path for provider-native search. Its direct helper is trusted-host-only and forbidden from isolated environments.

### D-toolscript-skill-current-state-guidance

[2026-08-03] The bundled ToolScript automation skill is written as concise current-state guidance for a first-time reader. It does not teach removed entry points or migration history, and its canonical example must remain executable against the registered builtin tool surface.