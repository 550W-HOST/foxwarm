# Experimental .NET prototype

This directory is a manual migration experiment and is not part of the Node.js build or test dependency graph. It contains ordinary .NET 10 projects for focused contract probes:

- `Foxwarm.ConditionalMemory` ports the pure conditional-memory helpers.
- `Foxwarm.MessageJson` is an owned `JsonObject` compatibility leaf for supported canonical messages and tool arguments.
- `Foxwarm.OpenAIResponses.Streaming` ports one complete, transport-neutral OpenAI Responses event accumulator plus an async SSE collector. It is not a provider client: request construction, authentication, retries, routing, timeouts/watchdogs, WebSocket pooling, journaling, Session ownership, final `Message` conversion, and runtime integration remain outside the experiment.
- `Foxwarm.SessionTurns` ports the first bounded Main-local Session-turn seams: owned Message JSON state, queue/source batching, ordered authority snapshot saves, one processor claim, one active cancellation handle, Stop finalization, and an in-process fake chat host. It has no production runtime integration.

## Build and tests

With the private .NET 10 SDK selected:

```sh
export DOTNET_ROOT=/path/to/private/dotnet-sdk-10
export PATH="$DOTNET_ROOT:$PATH"
dotnet restore experiments/dotnet/Foxwarm.DotnetSpike.sln
dotnet test experiments/dotnet/Foxwarm.DotnetSpike.sln --no-restore
```

The Responses collector uses native async `Stream.ReadAsync`, incremental UTF-8 decoding, source-equivalent narrow SSE framing, and explicit `StreamOwnership.Dispose` (the default) or `LeaveOpen`. The accumulator owns retained input JSON by deep clone and emits cumulative progress, meaningful-progress, safety-buffering, decoded-text, and complete-block callbacks. Typed semantic terminal, malformed-event, read, EOF, and normal .NET cancellation categories are covered by independent xUnit tests. The loopback cancellation test proves accepted/requested/held/cancelled/connection-closed milestones without sleep-based synchronization; it does not contact a provider and does not restart a runtime.

## Session-turn experiment

`Foxwarm.SessionTurns` is an experiment-only translation of the current Main-local `sessionWorkers:false` path. `SessionState` keeps bounded queue and history records using owned Message JSON. `SessionEntry` protects short synchronous state mutations with a per-Session gate, serializes authority snapshot commits through a separate async save lane, claims one processor atomically, and transfers one active cancellation handle to Stop. `SessionIngress` awaits a best-effort save attempt before acknowledging ordinary input. Busy claims, queue/history commits, assistant persistence, and busy release use strict saves; strict claim failure rolls back the busy fields and makes no fake-chat call.

`SessionTurnRunner` batches compatible leading sources by passive stream/conversation boundary and `preferDirectReply`, while preserving one canonical history row per queue item. `LocalSessionTurnHost` binds one exact Session entry and owns the fake chat's assistant append/persist step. Stop sets the boundary, takes and cancels the active request before waiting for its later best-effort save, and finalizes accepted queued inputs into history without another model call. Strict append and stop-finalization failures use operation-scoped compensation: they remove only their own appended history objects, restore only their selected/drained rows ahead of newer queue entries, and compare-and-restore only their own timestamp or state-field transitions. No broad snapshot restore or generic transaction abstraction is used. The committed observer runs after strict persistence succeeds and outside the rollback catch, so an observer exception can fail processing without rolling back already-persisted queue/history state. Deterministic xUnit tests cover save ordering, newer-input preservation during strict failure, source boundaries, processor claims, cross-Session concurrency, Stop/CTS races, finish-window handoff, observer failures, canonical session-marker escaping, `lastMessageTime` preparation, prebuilt/empty rows, callback reentry, unsupported paths, and ordinary chat failure.

The first committed nonempty input in a bounded turn controls parts preparation: a prebuilt message consumes that boundary without preparation, an empty row does not consume it, and a parts item prepares numeric `lastMessageTime` only when it is first. History-empty first-parts preparation also prepends the canonical `<foxwarm-system kind="session" currentSessionId="..." />` marker after Foxwarm attribute normalization and ECMAScript-whitespace collapsing. Later parts after a leading prebuilt message therefore receive no marker and do not change the timestamp. This is bounded owned Message JSON compatibility, not a complete canonical Message implementation: sequence metadata, archive integration, filesystem/SQLite durability, crash recovery, and other runtime-owned fields remain outside the experiment.

The component intentionally excludes tools/tool loops, compact execution, retry, waits, managed state, channel delivery, Worker IPC or placement, filesystem/SQLite persistence, crash recovery, performance equivalence, and production runtime integration. The in-memory authority store proves snapshot ordering and round-trip cloning only; it is not a filesystem or crash-recovery substitute.

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

Run the preserved Phase 2A differential oracle separately with `python3 experiments/dotnet/run-parity.py` after the repository JavaScript dependencies and shared generated package are available. The prototype remains outside normal Node CI and does not alter TypeScript runtime behavior, persistence, model routing, or Session ownership.
