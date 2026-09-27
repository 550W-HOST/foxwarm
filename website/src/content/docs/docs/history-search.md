---
title: Long conversations and history search
description: Use compaction and recall, and optionally enable semantic search over older conversations.
---

Foxwarm can compact a long conversation and recall earlier messages without Vector search. Optional semantic search helps find older material when you remember the topic but not the Session or message location.

Agent memory is separate: it contains the instructions and knowledge you want to carry between Sessions. See [Agents, Sessions, and memory](/docs/agents-sessions-memory/) for the distinction.

## Compaction

Automatic compaction reduces the active context as a conversation approaches the model's context limit. Older material is summarized into traceable blocks; the original archived messages remain available for recall. You can also request compaction with `/compact`.

The defaults are usually a reasonable starting point. To change them, edit `state/config.yaml` and restart Foxwarm:

```yaml
llm:
  compactThresholdPercent: 0.85
  compactKeepPercent: 0.3
```

`compactThresholdPercent` sets the automatic trigger relative to the selected model's context window. `compactKeepPercent` controls the fraction of recent rendered history kept by default during compaction. Both take a number greater than 0 and at most 1. A Session-specific threshold-token override takes precedence over the global trigger.

## Enable semantic search

Vector search is disabled by default. It requires an embedding service in addition to your chat model endpoint.

The current runtime requests the model **`qwen3-embedding:0.6b`** from an OpenAI-compatible `/embeddings` API. Your service must provide that model name. The configuration does not currently offer a different embedding-model name or an API-key field; use an endpoint Foxwarm can reach without an API key. Do not put credentials in its URL.

For an embedding service listening locally on port 11434, add this to `state/config.yaml`:

```yaml
vector:
  baseUrl: http://localhost:11434/v1
```

Restart Foxwarm after saving. The URL is the API base, not the full `/embeddings` endpoint; Foxwarm appends `/embeddings`. Keep any required version or gateway prefix such as `/v1` in the base URL. In Docker, use an address reachable from the container instead of assuming `localhost` reaches the host.

Enabling Vector starts indexing existing archived history in the background. Search can be incomplete while that work is in progress, and newly committed messages may not be searchable immediately. The `/session index` command can request indexing for the current Session while Vector is enabled.

:::note
History text is sent to the configured embedding service. Choose that service with the same care as a chat model provider, especially when Sessions contain private data.
:::

## Add keyword matching

Hybrid search combines semantic similarity with keyword matching. Enable both options together:

```yaml
vector:
  baseUrl: http://localhost:11434/v1
  lexicalIndex: true
  hybridSearch: true
```

`lexicalIndex` builds the keyword index; `hybridSearch` uses it during retrieval. Both default to `false`, and hybrid search requires the lexical index. Restart Foxwarm after changing these settings.

## Ask for earlier context

Ask the agent to recall the subject or decision you need, mentioning a Session or project when you know it. You can also search directly from chat:

```text
/search --limit 5 why we chose this deployment layout
```

Add `--session <session-id>` or `--agent <agent-name>` to narrow the search within your permitted scope.

Results lead back to archived source messages or summaries. They do not replace the active conversation or rewrite Agent memory.

To turn semantic search off, use `vector: false` and restart. Compaction, archived history, and exact message reads remain available.

## Storage and maintenance

The vector and keyword indexes are derived data in `state/db/`. Back up your [whole data directory](/docs/data-upgrades-backups/), including the original Session history and archives.

Vector maintenance is enabled by default. It compacts vector data and removes old table versions after the default 24-hour retention period; it does not delete the original conversation archive. For storage formats, recovery behavior, and maintenance tuning, see the repository's [Vector memory reference](https://github.com/550W-HOST/foxwarm/blob/main/docs/vector-memory.md).
