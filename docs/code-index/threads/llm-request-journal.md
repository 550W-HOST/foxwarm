# Thread: canonical LLM request journal

## Overview

This thread owns durable reconstruction of Foxwarm's provider-neutral LLM inputs for training and audit use. It spans normal turns, compact planning, BTW side requests, ToolScript one-shot requests, the model CLI, setup tests, and direct `requestLlmOnce` callers.

The journal records canonical inputs and observed attempt metadata. It does not claim exact HTTP wire replay.

## Durable model

The journal uses `state/llm-request-journal.sqlite` as its sole runtime authority. Its dedicated SQLite/WAL database remains isolated from the conversation archive so a short-lived model CLI cannot lock ordinary session archive writes.

- Prompt strings, complete tool-definition arrays, and individual canonical messages are content-addressed objects.
- A request manifest references those objects and identifies its purpose, optional session, iteration, requested model key, and a hash of the prompt-cache key.
- The first request is a message-list checkpoint. Later same-session requests use common-prefix deltas, with a checkpoint at least every eight links.
- Reconstruction follows only the bounded manifest chain and verifies every referenced object exists.
- Each physical provider attempt has an append-only start record with the selected concrete model, protocol, virtual key when applicable, and a hash of the semantic provider payload.
- Attempt results contain normalized success output or bounded failure/abort metadata. Auth headers and provider-hydrated request bodies are never stored.
- Successful normal assistant messages carry `llmRequestId` and `llmAttempt` metadata linking them to the journal. Ephemeral compact, BTW, ToolScript, CLI, and setup outputs remain reconstructable through attempt results even though they do not all become ordinary session assistant rows.

## Request flow

1. `requestLlmOnce` repairs canonical tool-call adjacency before provider hydration.
2. It content-addresses the system prompt, exact tool schema, and canonical internal messages. Normal chat history includes only the narrow historical concrete `modelId` provenance needed to reconstruct attempt-specific reasoning compatibility decisions; unrelated `__meta` remains excluded.
3. It durably appends the request manifest before any provider send.
4. Each concrete retry/failover attempt appends its start record before `axios.post`.
5. Clone-only image hydration and other provider-boundary preparation remain outside the canonical manifest. Immediately before provider serialization, the selected concrete attempt filters historical model-specific reasoning on its clone; extra fields, sanitation, headers, and optional compression remain ordinary provider-boundary behavior. Different failover attempts may therefore have different semantic payload hashes from the same canonical manifest; the filtering contract is [D-model-routing-history-reasoning-compatibility](./model-routing.md#d-model-routing-history-reasoning-compatibility).
6. A normalized attempt result is appended after success/failure/abort.
7. A successful result carries its request identity back through `chat` to assistant history metadata.

## Compatibility and recovery

Existing session message/block archives remain readable and unchanged. They do not receive fabricated historical request manifests. `reconstructLlmRequest` reports an unknown/legacy request as `legacy-partial` with named missing facts rather than guessing from current history or prompt snapshots.

`foxwarm archive export-jsonl --output <directory>` provides an explicit SQLite-backed compatibility export for training and inspection.

The one-time SQLite-only startup migration streams and strictly verifies any legacy active JSONL before moving it under the migration backup tree. Normal runtime never reads or appends that JSONL. SQLite uses WAL, `synchronous=FULL`, immediate writer transactions, and a bounded busy timeout for concurrent server and short-lived CLI writers. A request manifest and every attempt start commit before the corresponding provider send.

Full request/attempt row structure, object type/hash integrity, bounded delta ancestry, and reconstructed message count are checked during import and reconstruction. Corrupt records fail closed and are never labeled complete.

Request listing uses a stable `(createdAt, requestId)` composite cursor, including when multiple requests share one millisecond timestamp.

## Security boundary

The canonical journal contains the same model-visible prompt/message classes needed for training and must be protected like session archives. It stores no authorization headers, API keys, provider-hydrated image expansion, or semantic provider payload body. Physical attempts store only a payload SHA-256 digest.

Provider-specific wire replay is explicitly outside this contract. Exact wire capture would require a separate opt-in security and retention design.

## Design decisions

### D-llm-request-journal-canonical-boundary

[2026-08-03] Foxwarm durably records each provider-neutral LLM request before the first provider send using content-addressed prompt, tool-schema, and canonical-message objects plus a bounded checkpoint/delta manifest. The same narrow journal covers normal turns and every current one-shot/side/compact caller. Physical attempts record concrete routing and semantic-payload hashes, while successful assistant rows link to the request identity.

The normal journal never stores auth headers or provider-hydrated request payloads and does not claim exact HTTP wire replay. Existing archives remain legacy-partial rather than receiving inferred request records. A post-response journal-result failure is observable but must not re-enter provider retry logic and create a duplicate successful generation.

[2026-08-03] The dedicated SQLite database is the sole runtime authority. Legacy JSONL is a migration-only input that is strictly imported, verified, and moved to migration backup before completion; runtime does not dual-write it. SQLite commits use durable WAL/FULL boundaries, and compatibility JSONL is generated only by explicit export.

## Modules and units

- [LLM module](../modules/llm.md)
- [src-llm](../units/src-llm.md)
- [src-llm-request-journal](../units/src-llm-request-journal.md)
- [src-session-history](../units/src-session-history.md)
- [src-btw](../units/src-btw.md)
- [src-toolscript](../units/src-toolscript.md)
- [model-cli](../units/model-cli.md)
