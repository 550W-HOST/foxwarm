# Experimental .NET prototype

This directory is a manual migration experiment and is not part of the Node.js build or test dependency graph. It contains ordinary .NET 10 projects for focused contract probes:

- `Foxwarm.ConditionalMemory` ports the pure conditional-memory helpers.
- `Foxwarm.MessageJson` is an owned `JsonObject` compatibility leaf for supported canonical messages and tool arguments.
- `Foxwarm.OpenAIResponses.Streaming` ports one complete, transport-neutral OpenAI Responses event accumulator plus an async SSE collector. It is not a provider client: request construction, authentication, retries, routing, timeouts/watchdogs, WebSocket pooling, journaling, Session ownership, final `Message` conversion, and runtime integration remain outside the experiment.
- `Foxwarm.OpenAIResponses.Client` adds one bounded HTTP Responses client over the existing collector. It serializes the supported canonical text/reasoning subset, performs a real `ResponseHeadersRead` POST, converts completed text/refusal/reasoning/phase/usage into an owned assistant Message, and implements the SessionTurns chat boundary without retries or hidden persistence.
- `Foxwarm.SessionTurns` ports the first bounded Main-local Session-turn seams: owned Message JSON state, source-blind ordinary queue batching, ordered authority snapshot saves, one processor claim, one active cancellation handle, Stop finalization, and an in-process fake chat host. It has no production runtime integration.

## Build and tests

With the private .NET 10 SDK selected:

```sh
export DOTNET_ROOT=/path/to/private/dotnet-sdk-10
export PATH="$DOTNET_ROOT:$PATH"
dotnet restore experiments/dotnet/Foxwarm.DotnetSpike.sln
dotnet test experiments/dotnet/Foxwarm.DotnetSpike.sln --no-restore
```

The Responses collector uses native async `Stream.ReadAsync`, incremental UTF-8 decoding, source-equivalent narrow SSE framing, and explicit `StreamOwnership.Dispose` (the default) or `LeaveOpen`. The accumulator owns retained input JSON by deep clone and emits cumulative progress, meaningful-progress, safety-buffering, decoded-text, and complete-block callbacks. Typed semantic terminal, malformed-event, read, EOF, and normal .NET cancellation categories are covered by independent xUnit tests. The loopback cancellation test proves accepted/requested/held/cancelled/connection-closed milestones without sleep-based synchronization; it does not contact a provider and does not restart a runtime.

## Responses HTTP client experiment

`Foxwarm.OpenAIResponses.Client` accepts an explicit base URI, request model name, concrete model identity, bearer token, instructions, and output cap. It POSTs `/responses` with `ResponseHeadersRead`, `store:false`, streaming enabled, no tools, and the current bounded request fields. It never reads Foxwarm live configuration or credentials. Non-success bodies are captured up to 64 KiB; cancellation flows through send, body read, the SSE collector, and owned response-stream disposal.

The request serializer clones canonical input and filters only exact `modelVisible:false`. Its supported subset is user/model text, canonical Foxwarm system wrappers, plain system text wrapping, recognized assistant phases, compatible reasoning replay, and same-model output-text annotations. Multi-field parts follow the TypeScript field order `system` then reasoning metadata then `text`. System wrapping uses ECMAScript trim characters and ASCII word-boundary behavior, including FEFF trimming, NEL preservation, whitespace-only self-closing tags, and non-ASCII characters immediately after `foxwarm-system`. Open property bags remain open: unrelated message, part, and provider metadata is ignored rather than rejected or mutated. Inputs requiring unimplemented semantic conversion fail by name, including tool history/calls/results, image data/references, native Responses output-item replay, and legacy system-text normalization.

Completed Responses output is converted to one owned canonical assistant Message containing reasoning, text/refusal, recognized phase, compatible annotations, token usage, concrete model identity, and canonical request timing. The persisted `completedAt` is the completion wall clock, `durationMs` is monotonic and may be fractional, and `startedAt` is derived as `completedAt - durationMs` so a wall-clock jump cannot contradict the measured duration. Function calls and other unimplemented output-item/content types fail before persistence. `IChatService` now returns this owned optional assistant Message; only `LocalSessionTurnHost` performs the one strict assistant append. If that save fails, the host removes only its own hot assistant object, does not repeat HTTP, and later busy release persists the compensated state. Empty completed output produces no fabricated assistant row.

The localhost integration suite proves request receipt and fragmented SSE completion, canonical strict persistence, held-body Stop cancellation with server-observed connection close, bounded non-2xx capture, malformed/early-EOF rejection, controlled function-call rejection, and no HTTP repetition after assistant-save failure. `responses-request-corpus.json` is compared against the actual TypeScript `convertToOpenAIResponsesFormat` implementation for system/text, open metadata, empty assistant/user fields, phases, exact-false display exclusion, reasoning, and annotations.

This client remains experiment-only and in-memory. It excludes tool execution/loops, images and hosted tools, model routing/failover/retries, provider request compression, prompt-cache headers, WebSocket transport, streaming UI callbacks, request journaling/IDs, seq/Archive, filesystem/SQLite authority, Channel delivery, Worker placement, and production integration.

## Session-turn experiment

`Foxwarm.SessionTurns` is an experiment-only translation of the current Main-local `sessionWorkers:false` path. `SessionState` keeps bounded queue and history records using owned Message JSON. `SessionEntry` protects short synchronous state mutations with a per-Session gate, serializes authority snapshot commits through a separate async save lane, claims one processor atomically, and transfers one active cancellation handle to Stop. `SessionIngress` awaits a best-effort save attempt before acknowledging ordinary input, and the owned processor makes another ordered best-effort snapshot attempt immediately before selecting an ordinary prefix. Busy claims, queue/history commits, assistant persistence, and busy release use strict saves; strict claim failure rolls back the busy fields and makes no fake-chat call.

`SessionTurnRunner` consumes the complete leading ordinary queue prefix in canonical order regardless of source platform, channel, or conversation, while preserving one canonical history row and `clientMessageId` per queue item. `QueueSource` retains provenance only and does not select a turn or reply target. `LocalSessionTurnHost` binds one exact Session entry and owns the fake chat's assistant append/persist step. Stop sets the boundary, takes and cancels the active request before waiting for its later best-effort save, and finalizes accepted queued inputs into history without another model call. Strict append and stop-finalization failures use operation-scoped compensation: they remove only their own appended history objects, restore only their selected/drained rows ahead of newer queue entries, and compare-and-restore only their own timestamp or state-field transitions. No broad snapshot restore or generic transaction abstraction is used. Queue-prefix and Stop-finalization batch notifications run after strict persistence and are best-effort: callback failure is observable but cannot roll back or poison the committed operation. Other assistant/busy/release callback behavior is unchanged. Deterministic xUnit tests cover save ordering, source-blind prefix batching, newer-input preservation during strict failure, processor claims, cross-Session concurrency, Stop/CTS races, finish-window handoff, non-poisoning queue notifications, canonical session-marker escaping, `lastMessageTime` preparation, prebuilt/empty rows, callback reentry, unsupported paths, and ordinary chat failure.

The first committed nonempty input in a bounded turn controls parts preparation: a prebuilt message consumes that boundary without preparation, an empty row does not consume it, and a parts item prepares numeric `lastMessageTime` only when it is first. History-empty first-parts preparation also prepends the canonical `<foxwarm-system kind="session" currentSessionId="..." />` marker after Foxwarm attribute normalization and ECMAScript-whitespace collapsing. Later parts after a leading prebuilt message therefore receive no marker and do not change the timestamp. This is bounded owned Message JSON compatibility, not a complete canonical Message implementation: sequence metadata, archive integration, filesystem/SQLite durability, crash recovery, and other runtime-owned fields remain outside the experiment.

The component intentionally excludes tools/tool loops, compact execution, retry, waits, managed state, child-handoff state transitions, channel delivery, Worker IPC or placement, filesystem/SQLite persistence, crash recovery, performance equivalence, and production runtime integration. The in-memory authority store proves snapshot ordering and round-trip cloning only; it is not a filesystem or crash-recovery substitute.

Run the component suite with:

```sh
dotnet vstest experiments/dotnet/Foxwarm.SessionTurns.Tests/bin/Debug/net10.0/Foxwarm.SessionTurns.Tests.dll --logger:'console;verbosity=normal'
```

## Differential oracle

The existing Phase 2A `parity-corpus.json`, categories, and runner remain unchanged. Responses streaming has a separate 10-case corpus at `responses-stream-corpus.json`. It invokes the actual TypeScript `collectOpenAIResponsesStream` with the exact synthetic string/Buffer chunks and compares it with the C# collector over the same UTF-8 bytes. Ordinary cases use string chunks; the framing case also carries explicit base64 byte chunks that split inside the UTF-8 bytes of `é` and split a CRLF delimiter across reads. The comparator reuses the repository `strict_equal` semantics, requiring exact object key presence and distinguishing booleans, numbers, and null from absent fields. It requires equal corpus/TS/C# lengths and exact semantic equality for final response JSON, every cumulative progress snapshot, meaningful-progress count, safety metadata, concatenated decoded raw text, complete SSE blocks, and normalized success/error categories. For provider terminals it compares the actual caught TS `Error.message` against a source-derived rendered message, while C# exposes and is checked for typed kind/base message/status/code fields. It also rejects missing completion, wrong progress/event counts, late terminal errors, wrong terminal messages, bool-vs-number substitutions, and absent-vs-null changes. Native malformed-parser and low-level read diagnostics are intentionally not required to be byte-identical.

Run the separate Responses differential check from the repository root:

```sh
export DOTNET_ROOT=/path/to/private/dotnet-sdk-10
export PATH="$DOTNET_ROOT:$PATH"
python3 experiments/dotnet/responses-stream-parity-compare.py dotnet
```

The TypeScript subprocess runs with a fresh owned temporary `FOXWARM_DATA_DIR`, synchronous file logging, and console-log suppression. The wrapper requires a clean exit code 0 and parses the entire stdout with `json.loads`; trailing output, nonzero exit, and timeout/kill are failures. No provider request is made. The expected result is:

```text
comparison ok: 10 cases; semantic final/progress/raw/block/error parity exact
```

Slice A adds a separate request-input differential. `responses-request-corpus.json` covers canonical system wrapping plus text, open unknown metadata, empty assistant and user fields, recognized phase boundaries, exact-false display filtering, reasoning replay, and same-model annotations. The TypeScript runner imports the actual built `convertToOpenAIResponsesFormat` from `FOXWARM_TS_ROOT`; it does not reproduce the serializer in test code or invoke the network/request runtime. Run it with the same private SDK selected:

```sh
FOXWARM_TS_ROOT=/path/to/current/foxwarm \
  python3 experiments/dotnet/responses-request-parity-compare.py dotnet
```

The expected result is:

```text
comparison ok: 12 actual TypeScript/C# Responses request-input cases
```

Run the preserved Phase 2A differential oracle separately with `python3 experiments/dotnet/run-parity.py` after the repository JavaScript dependencies and shared generated package are available. The prototype remains outside normal Node CI and does not alter TypeScript runtime behavior, persistence, model routing, or Session ownership.
