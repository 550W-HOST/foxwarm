# Vector memory

Foxwarm uses LanceDB as an optional semantic retrieval layer over the authoritative session archive.

For archive and lineage migration details, see `docs/archive-store.md`.

## Purpose

Vector memory supports:

- semantic retrieval of older session context;
- project/history recall across long conversations;
- mixed lookup of raw archive segments, layered compact blocks, and compact-extracted facts.

Vector memory is separate from agent-maintained memory files. `agents/<agent>/memory/` contains curated instructions and knowledge, while Vector indexes session archives for semantic lookup.

## Storage and authority

```text
state/archive-store.sqlite   authoritative archive, lineage, and vector checkpoints
state/db/                    derived LanceDB index
```

Legacy JSONL archives are migration-only inputs. Current archive reads/writes use SQLite, and compatibility JSONL is produced only by explicit export:

```bash
foxwarm archive export-jsonl --output <directory>
```

The current LanceDB table is `messages_v7`. It contains raw, block, and fact rows with archive source metadata. Model-facing recall reloads the original archived messages or blocks after vector location; embedding chunks are not treated as authoritative history.

## Configuration

Vector is disabled by default:

```yaml
vector: false
```

Enable it with an OpenAI-compatible API base root. Include the version prefix or custom gateway API path; Foxwarm appends only `/embeddings`:

```yaml
vector:
  baseUrl: http://localhost:11434/v1
```

A Vector object opts in unless it sets `enabled: false`. Enabled Vector requires a nonempty absolute HTTP(S) URL without username, password, query, or fragment components. A custom gateway root such as `https://gateway.example/openai/v1` is preserved exactly apart from trailing-slash removal.

For compatibility, when top-level `vector` is absent, a nonempty legacy `llm.ollamaBaseUrl` still enables Vector. That field historically named the server root, so Foxwarm normalizes it to an API base ending in `/v1` before calling `/embeddings`. Explicit top-level `vector` always wins, and current configuration should use `vector.baseUrl`.

With Vector disabled:

- archive writes and compaction remain fully functional;
- exact `recall.target` and `get_session_messages` continue to read SQLite;
- semantic `recall.vector_query` and direct semantic/index operations report that Vector is disabled;
- LanceDB, embeddings, vector maintenance, startup vector backfill, and the optional vector worker are not started;
- best-effort indexing hooks become quiet no-ops.

## Indexing and backfill

When enabled, Vector indexing:

1. reads raw messages and layered blocks from the archive store;
2. excludes display-only/system noise that is not model-visible;
3. builds bounded overlapping segments or deterministic block/fact rows;
4. requests embeddings;
5. writes LanceDB and advances SQLite vector checkpoints.

Startup backfill is asynchronous. Search may be temporarily incomplete while pending checkpoints advance.

Archive checkpoints are independent of archive writes. Raw messages and full block summaries created while Vector is disabled keep the previous checkpoint values and remain pending in `archive-store.sqlite`. After Vector is enabled and Foxwarm restarts, the normal startup backfill compares archive maxima with those checkpoints and indexes those pending raw and block sources. No archive migration or separate recovery protocol is required.

Memory facts created by compaction are formatted into their authoritative block summary, so their text is still included in the later backfilled block row. The current startup backfill does not reconstruct separate `memory_kind: fact` rows for compactions that occurred while Vector was disabled. Semantic searches can therefore still find the fact text through the block, but fact-specific kind/attribution metadata and preference reranking may be incomplete for that disabled period.

The manual session-index command can force pending indexing while Vector is enabled:

```bash
/session index
```

## Retrieval

Semantic source-backed recall:

```ts
recall({
  vector_query: 'project progress',
  limit: 5,
})
```

`recall({ vector_query })` searches raw segments, compact blocks, and facts, then reloads original archive ranges through the shared preview renderer. Exact target selection and literal result filtering remain separate operations.

Time-near raw context remains available through:

```ts
get_memory_context({
  timestamp: Date.now(),
  limit: 10,
})
```

`get_memory_context` remains raw-only and does not return block summaries.
