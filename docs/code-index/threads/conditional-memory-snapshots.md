# Thread: conditional memory snapshots

## Overview

Foxwarm materializes each memory-backed Session system-prompt snapshot for one canonical concrete model identity. Individual memory source bodies may contain bounded full-line `foxwarm-if` blocks; the resulting snapshot begins with a deterministic current-model marker used to decide whether the persisted bytes can be reused for a selected provider attempt.

## Source assembly

- [src-conditional-memory](../units/src-conditional-memory.md) owns the pure conditional grammar and current-model header format.
- [src-llm](../units/src-llm.md) applies conditional filtering independently to each selected source body before adding provenance wrappers. The root framework source and its legacy framework fallback remain raw-content sources, so frontmatter-looking bytes stay model-visible; ordinary inherited, current-agent, and configured custom memory files retain Session frontmatter parsing before conditional filtering.
- Skill catalog text, generated directory/recall guidance, tool instructions, and chat history are not scanned for conditional blocks.
- A materialized snapshot always starts with the exact canonical concrete model identity. Snapshot construction does not select a virtual route.

## Actual request boundary

- The existing model-routing loop selects one concrete `ModelConfigEntry` and derives its canonical identity through the same concrete attribution helper used for assistant metadata.
- Immediately before concrete request-plan construction, a narrow optional prompt resolver receives that selected identity. Fixed low-level, CLI, and setup callers omit the resolver and keep their supplied prompt unchanged.
- Memory-backed `chat` compares the selected identity with the snapshot's first-line marker. A match reuses the exact bytes without file reads, persistence, or cache-key rotation. A missing or different marker rebuilds from the configured memory sources for that concrete identity.
- The first selected attempt's effective prompt becomes the request journal prompt. Later attempts pass their effective prompt to the existing optional per-attempt prompt reference boundary. Routing selection, retries, request identity, and assistant attribution remain one logical request.

## Ownership and detached work

- Normal authoritative Sessions persist a rebuilt snapshot through a strict owner seam on their existing Main or Session-worker `CurrentSessionEffects` before provider send. Main reuses the authority save lane and catalog-resync behavior while unrelated `saveSession` callers remain best-effort. A precommit failure prevents send and restores the prior hot snapshot; an authority-postcommit projection failure also prevents send but retains the committed/resynchronized snapshot rather than falsely rolling it back.
- BTW and compact planning explicitly mark their cloned Sessions as detached. They may refresh only the clone's snapshot and never persist or reload the live owner by shared Session ID.
- Compact clones preserve `systemPromptFiles`, prompt-cache lineage, and the captured model/settings alongside the copied snapshot.

## Lifecycle refresh

- Fresh concrete Sessions can materialize immediately from their known concrete configuration entry.
- A never-run virtual Session has no truthful concrete generation identity and leaves its snapshot unmaterialized until an actual attempt selects a leaf.
- Forks retain the copied snapshot and cache lineage; first actual use rebuilds when the selected concrete identity differs.
- Explicit, stale-idle, agent-metadata, and compaction-commit refreshes rebuild using the snapshot's recorded concrete generation identity. A concrete Session without a marker can derive its identity directly. A markerless virtual Session defers rather than selecting a synthetic leaf.
- Compaction commit keeps its existing memory reread behavior when a truthful live snapshot identity exists. Detached compact prompts are never copied back over live authority.

## Journal linkage

Exact request and attempt prompt durability is owned by [canonical LLM request journal](./llm-request-journal.md). The prompt-cache key remains stable across snapshot rebuilds and continues to own prefix lineage and session-hash routing.

## Design Decisions

### D-conditional-memory-concrete-snapshot-identity

[2026-09-08] Conditional memory matches the canonical concrete model identity selected for the physical provider attempt, not the configured virtual alias or the unqualified upstream model string. One narrow prompt resolver runs after existing leaf selection and before request-plan construction. Matching snapshots remain byte-stable; mismatches rebuild and persist only at the existing authority boundary.

Virtual routing is never duplicated merely to prefill a snapshot. Markerless virtual Sessions defer materialization, while lifecycle refreshes reuse an already-recorded concrete generation identity. Detached BTW and compact work mutate only captured prompt state. This preserves one retry loop, one logical journal request, existing prompt-cache lineage, and exact per-attempt prompt reconstruction without a per-model snapshot cache or separate persisted identity field.
