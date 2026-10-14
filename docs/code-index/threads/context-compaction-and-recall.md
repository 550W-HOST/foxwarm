# Thread: context compaction and recall

## Overview

This thread owns the end-to-end contract that keeps long sessions within model limits without losing traceable history. It spans session history transformation code, the compact-plan tool, prompt/provider calls, the SQLite archive, vector indexing, recall tools, and WebUI CTX-BLOCK expansion.

The contract is split by responsibility. Each detailed rule has one canonical owner in the sub-documents below. This page keeps the navigation and the active-history authority contract.

- [Context compaction](./context-compaction.md): triggers, historical tool-response pruning, candidate policy, planner input and submission, block metadata, and the compact-completion marker.
- [Compaction lifecycle](./compaction-lifecycle.md): snapshot jobs, the shared engine, ready-first scheduling, commit safety, cancellation, busy windows, and Session-worker placement.
- [Archive and recall](./archive-and-recall.md): SQLite archive authority and lineage, Vector indexing, semantic and lexical recall, WebUI expansion, and history search.

## Flow

### 1. Trigger and snapshot
Automatic and explicit compact requests, the default keep ratio, and the historical pruning attempt are in [triggers](./context-compaction.md#triggers-and-tool-response-pruning). Snapshot planning and the async and awaited modes are in [snapshots and jobs](./compaction-lifecycle.md#snapshots-and-jobs).

### 2. Candidate policy and planning
Raw and block candidate quotas, planner submission, and plan contents are in [candidate policy and planning](./context-compaction.md#candidate-policy-and-planning).

### 3. Commit and continuation
Safe-point application, stale-snapshot aborts, and cancellation are in [commit and safe points](./compaction-lifecycle.md#commit-and-safe-points) and [cancellation](./compaction-lifecycle.md#cancellation). Replacement of active history is governed by [D-context-active-history-authority](#d-context-active-history-authority).

### 4. Durable archive and lineage
Archive storage, lineage caps, and read paths are in [archive storage and lineage](./archive-and-recall.md#archive-storage-and-lineage).

### 5. Vector location and source reload
Vector indexing and source reload are in [vector indexing](./archive-and-recall.md#vector-indexing-and-source-reload). Lexical side-channel and rollout phases are in [lexical side-channel](./archive-and-recall.md#lexical-side-channel-and-rollout-phases).

### 6. Recall and preview
Exact and semantic recall, filters, and preview budgets are in [recall and preview](./archive-and-recall.md#recall-and-preview).

### 7. WebUI expansion
Read-only block expansion and the Main history search viewer are in [WebUI expansion](./archive-and-recall.md#webui-expansion).

## Modules

- [session context](../modules/session-context.md)
- [session core](../modules/session-core.md)
- [LLM](../modules/llm.md)
- [WebUI](../modules/webui.md)

## Invariants

- Raw content is archived before its active history entries are replaced.
- Display-only messages do not enter model context, compact summaries, or embeddings.

## Compatibility

- Persisted `history` is the sole active timeline. Obsolete embedded or standalone frontiers are ignored; the startup migration only retires standalone files and current saves drop the old embedded field.

## Design decisions

### D-context-active-history-authority

[2026-08-13, updated 2026-08-18] `state/sessions/<id>.json` `history` is the sole active and model-visible timeline in local and Session-worker placement. Archive rows remain immutable recall/audit/lineage sources and never reconstruct, reorder, overwrite, or resurrect active history. Obsolete standalone/top-level `contextFrontier` and per-message `__meta.contextFrontierItem` data are tolerated and ignored on read and omitted on every current save; `__meta.contextBlock` remains semantic and is preserved.

Layered compaction plans and builds its result solely from an exact cloned active-history snapshot. It does not read Archive to admit or reject raw/block candidates, compare active bytes, revalidate source identity, recover timestamps, or reconstruct summary input. Active pruned tool responses and offline-edited wording are therefore ordinary layered input exactly as stored in `history`. Candidate construction retains active-only structural guards: positive unique raw sequence identity, ordered raw continuity, semantic `contextBlock` metadata, nonoverlapping block raw coverage in active order, preserved-raw rules, lifecycle barriers, visibility, and atomic grouping of a present immediately consecutive call/tool-response run. A structurally valid call without following tool rows remains an ordinary single-message candidate. A malformed tool row is a local hard barrier: it starts a new segment without invalidating an already valid immediately preceding call/response prefix, and later structurally valid rows may form candidates in that new segment. Other invalid active structure and every nontransparent active row omitted from the final candidate set remain hard barriers; valid blocks reset raw-message continuity across raw→block→raw history. Raw timestamps come from active raw metadata, and block timestamps come from active block metadata.

Commit requires deep equality of the complete consumed active snapshot while allowing only an appended live suffix; it directly replaces selected history ranges with rendered CTX-BLOCK messages, copies requested exact raw messages with `preservedFromBlockId`, removes display-only consumed rows and old pure completion notices, retains the compatible appended suffix, and appends one current completion marker. The layered engine emits newly generated immutable Archive blocks before replacing active authority. Archive content is output only for this operation; identity allocation may read only the effective capped ID scalar under [block ID high-water marks](./archive-and-recall.md#d-context-block-id-high-water). It never repairs or resurrects active history from Archive. Successful compact preserves `promptCacheKey`; `/clear` remains the rotation boundary.

Required archive appends are synchronous and fail closed for the affected Session mutation. Before-authority failure restores the in-memory semantic snapshot and removes only exact rows newly inserted by that operation. After authoritative JSON replacement, catalog/projection failure is explicitly postcommit: archive rows and JSON remain aligned, the exact owner reloads/resynchronizes from authority, and Worker publication poison keeps later mutation fenced until the existing resync boundary succeeds. A required archive error at the turn boundary receives at most one presentation-only final error attempt and never recursively appends another semantic error row through the failed archive. Archive message/block same-key replay is idempotent only when the stored row is byte-semantically identical; conflicting content fails instead of overwriting immutable history. Runtime write batches contain exactly one Session ID. Block-source archive records may use decreasing/nonconsecutive endpoints only when ordered `sourceBlockIds` explicitly starts/ends at those identities; message-source ranges remain ascending.
