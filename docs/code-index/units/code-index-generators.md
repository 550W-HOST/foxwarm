# Unit: code-index-generators

Files: skills/code-index/SKILL.md, skills/code-index/INITIALIZATION.md, skills/code-index/WORKER.md, skills/code-index/TOP_DOWN_CHILD.md, skills/code-index/generate_code_index.py, skills/code-index/generate_code_index_standalone.py, skills/code-index/tests/test_generate_code_index.py, docs/code-index/scripts/audit_index.py
Secondary files: package.json

## Purpose

Defines governed code-index maintenance and two first-draft initialization paths. `SKILL.md` is the daily entry point; `INITIALIZATION.md` selects batch or top-down initialization; worker guides constrain delegated writes; the two generators provide ToolScript-compatible and standalone batch execution.

## Document responsibilities

- `SKILL.md` — index-root resolution, document roles, maintenance workflow, public-safety rules, canonical decision ownership, primary/secondary file ownership, and quality checks.
- `INITIALIZATION.md` — batch versus top-down initialization, generator invocation, safe points, and post-generation curation.
- `WORKER.md` — fixed-scope bottom-up worker contract and report format.
- `TOP_DOWN_CHILD.md` — context-carrying traversal, micro-batch persistence, rolling parent docs, and `_work` checkpoints.
- `generate_code_index.py` — Foxwarm ToolScript-compatible batch runner.
- `generate_code_index_standalone.py` — ordinary Python runner over the production `foxwarm model` CLI.
- `tests/test_generate_code_index.py` — path, overwrite, resume, and generation safety tests.
- `docs/code-index/scripts/audit_index.py` — repository-local publication, navigation, ownership, language, and decision-duplication audit.

## Key exports

- `generate_code_index.py::main(args)` — ToolScript-compatible batch entry.
- `generate_code_index_standalone.py::main(argv)` / `run(args)` — standalone orchestration.
- `npm run quality:code-index` — audits the repository-local index against the current source tree and treats CJK content as an error.
- Source scanning and containment validation helpers.
- Grouping/module/thread plan validation.
- Atomic output and explicit overwrite policy.
- Fingerprinted grouping-cache resume helpers.

## Stable-symbol index

| Symbol or section | Responsibility |
|---|---|
| `SKILL.md: Resolve the Index Root` | Prefer repository-local `docs/code-index/`, then an existing external fallback; use one root per task |
| `SKILL.md: Document Roles and Ownership` | Defines overview/module/thread/unit boundaries |
| `SKILL.md: Design Decision Governance` | Selects one canonical owner and converts cross-module repetition into a thread signal |
| `SKILL.md: Public-Safe, English-Only Content` | Blocks secrets, personal paths, private runbooks, and private agent context |
| `INITIALIZATION.md: After Generation` | Requires manual public-safety, ownership, decision, and stable-symbol curation |
| `WORKER.md: Writing style` | Constrains assigned-scope workers |
| `TOP_DOWN_CHILD.md: Governance While Traversing` | Applies governance during rolling top-down updates |
| `audit_index.py::audit` | Validates links, source ownership, publication safety, language, density, and likely duplicate decisions |
| `atomic_write_text` | Same-directory temporary write and atomic replace |
| `ensure_output_directory` / `ensure_contained_file` | Reject output/source escapes |
| `validate_groupings` / `validate_module_plan` / `parse_threads` | Reject unsafe names and incomplete/duplicate model plans |
| `grouping_cache_inputs` / `cache_fingerprint` | Bind resume state to the selected inputs |
| `write_generated_doc` | Preserve curated output unless explicit force is given |

## Behavior

- Index-root resolution prefers a repository-local `docs/code-index/` tree when present. An existing `~/code-index/{project}/` tree is a migration fallback; one task must not split writes across both roots.
- The index is an active source map, not an append-only decision log. Source and tests remain authoritative.
- Each decision has one canonical owner: unit for one semantic unit, module for multiple units in one module, thread for a cross-module contract, and overview for a project-wide principle.
- Repetition across modules is a signal to create or use a thread. Other layers use short summaries and stable links rather than copying full decisions.
- Final content is public-safe English. Credentials, personal paths, private deployment procedures, and agent-private collaboration notes are prohibited.
- Unit `Files:` entries declare one primary owner. Shared manifests and integration references belong under secondary files.
- Worker prompts prefer stable symbols and sections over brittle line-number-heavy function indexes.
- Generators create first drafts only and deliberately do not extract design decisions from a fixed source.
- The standalone runner validates every model-selected source path against the scanned allowlist, rejects unsafe output names and symlink escapes, and never writes failed/empty model output.
- Existing non-empty documents are preserved unless `--force` explicitly authorizes replacement.
- The repository-level `quality:code-index` command runs the copied audit script with `--source-root . --fail-on-cjk`, so public index regressions fail before merge.

## Tests

The generator tests cover absolute/parent/unscanned path rejection, malicious output names, exact grouping assignment, source filtering, empty/failed model output, cache invalidation, preserved documents, force behavior, phase preservation, atomic writes, and output symlink escapes.

## Integration

Ordinary maintenance loads `SKILL.md` and updates the resolved index root directly. Batch initialization uses one generator; top-down initialization uses the worker guide and durable micro-batch checkpoints. All generated or delegated output still requires governance review before publication. Repository contributors run `npm run quality:code-index` from the Foxwarm root after changing source or index documentation.

## Design decisions

### D-code-index-root-resolution

Prefer repository-local `docs/code-index/` for a migrated or new index, but continue maintaining an existing external index as fallback until migration is explicit. Resolve once per task and never update both roots opportunistically.

### D-code-index-canonical-decisions

A decision has one canonical owner. Cross-module repetition is a thread signal; other layers link to the canonical decision.

### D-code-index-public-snapshot

Maintained index prose is public-safe English and uses source-relative paths. Private operational context is not migrated into a repository snapshot.

### D-code-index-file-ownership

Each source file has at most one primary-owning unit. Shared manifests and integration references are secondary.

### D-code-index-stable-symbols

Generated and manually curated function indexes prefer stable symbols and sections. Line numbers are optional evidence, not the primary navigation contract.
