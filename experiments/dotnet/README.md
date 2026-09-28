# Experimental .NET prototype

This directory is a manual migration experiment and is not part of the Node.js build or test dependency graph. It contains ordinary .NET 10 projects for focused contract probes:

- `Foxwarm.ConditionalMemory` ports the pure conditional-memory helpers.
- `Foxwarm.MessageJson` is an owned `JsonObject` compatibility leaf for supported canonical messages and tool arguments.
- `Foxwarm.OpenAIResponses.Streaming` ports one complete, transport-neutral OpenAI Responses event accumulator plus an async SSE collector. It is not a provider client: request construction, authentication, retries, routing, timeouts/watchdogs, WebSocket pooling, journaling, Session ownership, final `Message` conversion, and runtime integration remain outside the experiment.
- `Foxwarm.OpenAIResponses.Client` adds one bounded HTTP Responses client over the existing collector. It serializes the supported canonical text/reasoning subset, performs a real `ResponseHeadersRead` POST, converts completed text/refusal/reasoning/phase/usage into an owned assistant Message, and implements the SessionTurns chat boundary without retries or hidden persistence.
- `Foxwarm.SessionTurns` ports the first bounded Main-local Session-turn seams: owned Message JSON state, source-blind ordinary queue batching, ordered authority snapshot saves, one processor claim, one active cancellation handle, Stop finalization, and an in-process fake chat host. It has no production runtime integration.
- `Foxwarm.SessionPersistence` provides the accepted current-v1 authority validator, exact TypeScript six-column message and 15-column block Archive tables, and Linux atomic JSON writer over test-owned roots. The persistent adapter connects these primitives to `SessionTurns` while retaining the in-memory test substitute.
- `Foxwarm.SessionRestartHarness` is a test-only CLI with narrow process-A, process-B, and fail-closed load-check modes for Slice D. It is not a product entry point.
- `Foxwarm.ExperimentHost` is an independent single-process, multi-Session HTTP host with a small JSON configuration subset for multiple concrete localhost Responses models, per-Session model/effort selection, and full-level synchronous layered context compaction. It is not the Foxwarm production backend.

## Interactive experimental HTTP host

Build `Foxwarm.ExperimentHost`, choose **new separate** data/workspace directories, and set explicit environment variables. Do not point the data root at a Foxwarm production/test installation. The host binds only to `127.0.0.1`; use a local scripted Responses server when validating without provider spend:

```sh
export FOXWARM_EXPERIMENT_DATA_ROOT=/path/to/new/experiment-data
export FOXWARM_EXPERIMENT_TOOL_ROOT=/path/to/new/tool-workspace
export FOXWARM_EXPERIMENT_PORT=39091
export FOXWARM_EXPERIMENT_API_TOKEN='private-local-api-token'
export FOXWARM_EXPERIMENT_RESPONSES_BASE_URI='http://127.0.0.1:39092'
export FOXWARM_EXPERIMENT_PROVIDER_TOKEN='private-provider-token'
export FOXWARM_EXPERIMENT_REQUEST_MODEL='local-scripted-model'
export FOXWARM_EXPERIMENT_CONCRETE_MODEL='local-scripted-model'
# Optional: a build from the separate current-frontend experimental Chat branch.
export FOXWARM_EXPERIMENT_WEBUI_DIST=/path/to/experimental-chat-webui/packages/webui/dist
# Optional: FOXWARM_EXPERIMENT_INSTRUCTIONS and FOXWARM_EXPERIMENT_MAX_OUTPUT_TOKENS.
dotnet run --no-build --project experiments/dotnet/Foxwarm.ExperimentHost
```

The previous single-model environment variables remain a fallback when `FOXWARM_EXPERIMENT_MODELS_FILE` is absent. To select multiple concrete Responses models instead, set that variable to a **separate JSON file** with the following experiment-only subset (replace URLs and credential-environment-variable names with locally controlled values):

```json
{
  "default": "local-a/model-a",
  "providers": {
    "local-a": {
      "providerType": "openai",
      "baseUrl": "http://127.0.0.1:39092",
      "apiKeyEnv": "FOXWARM_LOCAL_A_TOKEN",
      "contextLimit": 18000,
      "effort": { "allowed": ["none", "low", "high"], "default": "low" },
      "models": [{ "id": "model-a" }]
    },
    "local-b": {
      "providerType": "openai-responses",
      "baseUrl": "http://127.0.0.1:39093",
      "apiKeyEnv": "FOXWARM_LOCAL_B_TOKEN",
      "contextLimit": 24000,
      "effort": { "allowed": ["none", "low", "high"], "default": "none" },
      "models": [{ "id": "model-b" }]
    }
  }
}
```

Set `FOXWARM_LOCAL_A_TOKEN` and `FOXWARM_LOCAL_B_TOKEN` in the host environment before startup; `apiKeyEnv` names an environment variable and deliberately **is not** the TypeScript config's `apiKey` value. Credentials are resolved only in host memory, never serialized into Session JSON or browser model metadata. This is not a `models.yaml` parser or direct production configuration import. Only concrete `openai`/`openai-responses` HTTP loopback providers are admitted; unknown/virtual/hosted/WS/failover providers fail at startup. Provider/model `contextLimit` and `effort` defaults/allow-lists follow this explicit JSON subset; there is no Setup save or hot reload. Each provider request captures one selected model URI, credential, wire ID and effort before sending. Explicit per-Session model/effort changes use its ordered save lane and survive clean restart; changing one while a request is in flight affects only later requests.

The API is an **experiment subset**, not the whole WebUI backend. API calls, including `/health`, accept `Authorization: Bearer $FOXWARM_EXPERIMENT_API_TOKEN`; when the optional WebUI dist is configured, the root page and its static assets can load before login, and the experiment-only `/api/auth` exchanges a manually entered token for a same-origin, HTTP-only, SameSite-Strict cookie. No token goes into the URL, localStorage, built assets, or provider request. A minimal CLI interaction after startup is:

```sh
curl -H "Authorization: Bearer $FOXWARM_EXPERIMENT_API_TOKEN" -H 'Content-Type: application/json' \
  -X POST "http://127.0.0.1:$FOXWARM_EXPERIMENT_PORT/api/sessions"
# Use the returned safe generated sessionId as ID:
curl -H "Authorization: Bearer $FOXWARM_EXPERIMENT_API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"text":"hello"}' "http://127.0.0.1:$FOXWARM_EXPERIMENT_PORT/api/sessions/ID/message"
curl -N -H "Authorization: Bearer $FOXWARM_EXPERIMENT_API_TOKEN" \
  "http://127.0.0.1:$FOXWARM_EXPERIMENT_PORT/api/sessions/ID/stream"
```

Supported CLI routes are `GET/POST /api/sessions`, `GET /api/sessions/{id}/state|history|stream`, `POST /api/sessions/{id}/message|stop|model`, exact `GET /api/sessions/{id}/archive/messages/{seq}`, one-layer `GET /api/sessions/{id}/context-blocks/{blockId}/expand`, `POST /admin/shutdown`, and `GET /health`. Message accepts nonempty text and optional `clientMessageId`; HTTP 202 acknowledges an ingress queue-save **attempt**, not guaranteed durability or processing. `/compact` explicitly starts an idle synchronous planner under a durable busy claim; `/stop compact` cancels that planner without discarding ordinary queued input. `/stop` still controls a normal turn. Busy background compaction is not supported. Graceful shutdown stops admission and active requests, waits for processor/save completion, and reports persistence failures. Only host-owned JSON files load on restart; Archive IDs detect missing authority but cannot rebuild it. Persisted busy/stopping state fails closed rather than attempting crash repair.

For the **current Chat leaf** only, build the separate `spike/dotnet-chat-webui` worktree with `VITE_FOXWARM_EXPERIMENT_CHAT=1 npm --prefix packages/webui run build`; set `FOXWARM_EXPERIMENT_WEBUI_DIST` to that worktree's `packages/webui/dist`. Start this host and open `http://127.0.0.1:$FOXWARM_EXPERIMENT_PORT/`; enter the same local API token in the login page, then create/select Sessions. That frontend worktree holds the thin experiment-only shell and optional Chat/Composer UI restrictions; the normal WebUI build retains its production defaults. Do not serve the normal frontend dist and mistake its complete App/Setup/Agents for supported features.

The original Chat uses `WS /api/webui/stream` with Session-only revisioned subscriptions, real v2 draft progress, canonical messages and queue state; it does not consume the separate CLI SSE. `GET /api/sessions/{id}/history` implements consistent tail, prefix+historyVersion, afterSeq+historyVersion and full snapshot with real seq/version/queue preview. The current model selector shows concrete model choices and effort only; child defaults and Setup are hidden. `/compact`, `/stop compact`, and `/stop` are supported in the text composer. CTX cards expand their actual archived child blocks and raw messages after refresh/restart. `/api/models` and `/api/commands` advertise only supported options. ASR remains unconfigured, and uploads/other slash commands fail explicitly. Same-origin Cookie and CLI Bearer protect API and WebSocket. Static assets are restricted to the explicitly configured dist. HTTP-only loopback cookies are not production authentication.

The host advertises the fixed `read`, `write`, exact-`msg#N` `recall`, and `submit_compact_plan` Responses definitions. The ordinary turn executes relative UTF-8 regular-file read/write under the separate tool workspace (1 MiB, no symbolic-link components, create-new default), or paginated current-Session read-only recall of one immutable Archive `message_json` by exact seq (up to 12,000 Unicode code points per call). The planner accepts only a single `submit_compact_plan` call and does not execute read/write/recall. An unauthenticated/fabricated cross-Session target cannot be supplied to recall. These path-level limits are not an OS sandbox. `write_fixture` remains only in earlier test harnesses; no production provider/config, Agent/catalog platform, Channels, Worker, Node, MCP, general tool registry, images, routing/retry, crash recovery, receipts, or full WebUI frontend compatibility is claimed.

`host-e2e.py` retains CLI/SSE and clean restart checks. The separate frontend experiment worktree contains `experimentHostChat.e2e.mjs` (original Chat/queue/Stop regression) and `experimentHostModelCompact.e2e.mjs` (two real browser-visible concrete model choices and effort, frozen in-flight request, automatic+manual L1→L2 compaction, invalid-plan retry, Archive originals and nested CTX after restart, prune-only recovery with exact paginated model recall, and held-planner Stop preserving queued input). All drivers use disposable roots and scripted localhost Responses replies, not paid providers.

## Build and tests

With the private .NET 10 SDK selected:

```sh
export DOTNET_ROOT=/path/to/private/dotnet-sdk-10
export PATH="$DOTNET_ROOT:$PATH"
dotnet restore experiments/dotnet/Foxwarm.DotnetSpike.sln
dotnet test experiments/dotnet/Foxwarm.DotnetSpike.sln --no-restore
```

## Session persistence C1/C2/D experiment

`Foxwarm.SessionPersistence` accepts one explicitly bound Session ID and the current bounded ordinary v1 authority subset. It preserves open unknown top-level, queue-item/source, Message, part, metadata and provider JSON. The host additionally admits supported CTX-BLOCK metadata, preserved raw flags and `nextBlockId`; it still rejects fork/alias lineage, wait/managed/child-handoff/indexing state, Worker mailbox progress, images and unimplemented structured queue kinds. Active JSON is the sole active-history authority; Archive is immutable audit/recall data and is never used to rebuild active history.

The SQLite store pins `Microsoft.Data.Sqlite` 10.0.12. It admits the exact six-column TypeScript `archive_messages` and 15-column `archive_blocks` table layouts (including source IDs, raw seq/time ranges, summary, memory facts, creation time). Archive insertion is immutable/byte-exact on replay with inserted-only rollback. The Session save lane stages a compaction rewrite from active history only; it writes blocks plus a completion raw row to Archive, atomically replaces authority JSON, then publishes only its owned hot history/version/nextSeq/nextBlock delta without rolling back concurrent queue/Stop/model settings. Pre-rename failure removes only newly inserted rows; postrename failure retains and publishes committed authority and throws. Only historical tool-response pruning reads Archive to verify exact original provenance before reducing active output, and that path commits only when the estimated session fits 50% of the selected context limit. No new catalog, manifest, cross-store transaction or crash-repair protocol is introduced.

Stored `message_json` read from SQLite retains its original string and is never silently reserialized. New C# rows use a bounded ECMAScript-compatible projection over owned JSON. Object keys follow ECMAScript array-index ordering; strings preserve the verified JSON escaping boundary; finite binary64 numbers use .NET's shortest round-trip digits plus ECMAScript's fixed/scientific thresholds, lowercase exponent style, explicit positive exponent sign, and `-0` → `0`. JSON-parsed numbers and CLR `double`/`float` are supported. Integral CLR values are accepted only when exactly representable as a binary64 Number; over-precise integers and CLR `decimal` values fail before database insertion rather than being silently rounded. Actual `JSON.stringify` checks cover non-ASCII, U+2028/U+2029, a literal `\\u2028`, quotes, backslashes, controls, numeric-key ordering, `-0`, the `1e-6`/`1e21` thresholds and adjacent representable values, fractional timing, binary64 extrema, and a finite 512-value seeded sample. This remains a tested projection, not a general custom ECMAScript runtime.

The JSON authority writer writes a unique same-directory UTF-8 temp file, calls `Flush(true)`, atomically renames it over the target, and fsyncs the Linux parent directory. Matching the current TypeScript portability rule, directory-open/fsync errors `EPERM`, `EISDIR`, `EINVAL`, `ENOSYS`, and `ENOTSUP` are reported as unsupported rather than durable; other errors fail. Failures before rename remain precommit and remove the temp file. Failures after rename throw `AuthorityCommittedException` and leave the new authority visible, so a later caller cannot misclassify the operation as rollback-safe. File fsync and directory fsync are separate durability boundaries; injected failures and normal reopen do not prove power-loss or cross-SQLite/JSON atomicity.

The C1 tests use only fresh temporary roots. An actual current TypeScript helper writes one source-derived v1 JSON/full Archive fixture for C# read/rewrite/TypeScript reread, and reads a C#-created limited fixture in the opposite direction. The C#-created path also invokes actual `writeArchiveMessages` with the same semantic records and requires zero inserted rows, proving exact immutable replay rather than read-only semantic acceptance. Run against the intended current TypeScript build explicitly:

```sh
FOXWARM_TS_ROOT=/path/to/current/foxwarm \
  dotnet test experiments/dotnet/Foxwarm.SessionPersistence.Tests/Foxwarm.SessionPersistence.Tests.csproj --no-restore
```

C2 adds `PersistentSessionAuthorityStore` in the SessionTurns leaf. Ordinary queue/busy/Stop snapshots and canonical appends share the existing ordered per-Session save lane. The lane lock only reserves and links the next tail; a separately completed asynchronous launch signal starts prior-wait and operation execution after the lock is released, so synchronous SQLite/file fsync cannot hold `laneGate`. A canonical append captures selected queue object identities and an owned staged v1 snapshot under the short state gate, assigns contiguous `seq`/finite timestamps without accepting caller-supplied `seq`, then performs Archive insertion followed by atomic JSON replacement without holding either gate. Timestamp `0` and `-0`, like missing/null, use the injected/current clock to match TypeScript's `timestamp || Date.now()`; other supported finite timestamps are retained. Ordinary append preserves persisted `historyVersion` exactly—compact/clear structure rewrites own that field. Only after authority commit does the append publish its queue/history/next-seq/meta delta to hot state. Newer ingress and Stop/meta changes remain hot and are persisted by their already-ordered saves; ordinary ingress acknowledgement waits for its own save attempt. In-memory tests use the same staged publish path without claiming filesystem durability.

Before rename, a JSON failure rolls back only the rows newly inserted by that operation; byte-identical preexisting replays are never deleted and hot staged state is not published. After rename, `AuthorityCommittedException` retains Archive plus new JSON, publishes the corresponding hot delta, and reports the postcommit problem without provider/tool retry or rollback. Directory-sync `Unsupported` remains observable on the persistent store and is not described as full durability. Missing or malformed active JSON fails closed when Archive rows exist; Archive never reconstructs active history. A default fire-and-forget trigger records its process-local failure count and last error instead of dropping the fault or automatically retrying. The durable queue remains available, but recovery requires an explicit trigger or later admitted input; there is no background spin or persistent retry state. Slice D proves one bounded clean-idle restart: process A exits after a persisted four-row tool turn, then a distinct process B loads the same explicit Session ID from JSON and commits rows 5/6 without repeating the file effect. A busy-claim postrename failure intentionally retains committed `busy` and fails closed in that process; D does not cover that state, arbitrary crash points, power loss, or production restart orchestration.

The Responses collector uses native async `Stream.ReadAsync`, incremental UTF-8 decoding, source-equivalent narrow SSE framing, and explicit `StreamOwnership.Dispose` (the default) or `LeaveOpen`. The accumulator owns retained input JSON by deep clone and emits cumulative progress, meaningful-progress, safety-buffering, decoded-text, and complete-block callbacks. Typed semantic terminal, malformed-event, read, EOF, and normal .NET cancellation categories are covered by independent xUnit tests. The loopback cancellation test proves accepted/requested/held/cancelled/connection-closed milestones without sleep-based synchronization; it does not contact a provider and does not restart a runtime.

## Responses HTTP client experiment

`Foxwarm.OpenAIResponses.Client` accepts an explicit base URI, request model name, concrete model identity, bearer token, instructions, and output cap. It POSTs `/responses` with `ResponseHeadersRead`, `store:false`, streaming enabled, and one fixed `write_fixture` function definition using the current Responses function protocol (`strict:false`, `tool_choice:auto`, and parallel-call capability). It never reads Foxwarm live configuration or credentials. Non-success bodies are captured up to 64 KiB; cancellation flows through send, body read, the SSE collector, and owned response-stream disposal.

The request serializer clones canonical input and filters only exact `modelVisible:false`. Its supported subset is user/model text, canonical Foxwarm system wrappers, plain system text wrapping, recognized assistant phases, compatible reasoning replay, same-model output-text annotations, function calls, and paired tool outputs. Multi-field parts follow the TypeScript field order `system`, reasoning metadata, `text`, then function call; a model message containing a call uses the current commentary phase fallback. Stable provider call IDs, exact raw argument text, parse-error metadata, safe malformed-argument replay, and current tool-response text formatting are preserved. Tool output follows its saved call, and newly queued ordinary inputs consumed during tool execution are appended only after the paired tool row and before the next request. System wrapping uses ECMAScript trim characters and ASCII word-boundary behavior, including FEFF trimming, NEL preservation, whitespace-only self-closing tags, and non-ASCII characters immediately after `foxwarm-system`. Open property bags remain open: unrelated message, part, and provider metadata is ignored rather than rejected or mutated. Inputs requiring unimplemented semantic conversion fail by name, including missing stable call IDs, image data/references, native Responses output-item replay, and legacy system-text normalization.

Completed Responses output is converted to one owned canonical assistant Message containing reasoning, text/refusal, function calls, recognized phase, compatible annotations, token usage, concrete model identity, and canonical request timing. The persisted `completedAt` is the completion wall clock, `durationMs` is monotonic and may be fractional, and `startedAt` is derived as `completedAt - durationMs` so a wall-clock jump cannot contradict the measured duration. `IChatService` returns this owned optional assistant Message; only `LocalSessionTurnHost` strictly appends assistant and tool rows. A committed call is executed only after its assistant save succeeds, its paired tool row must save before another provider request, and neither assistant-save nor tool-row-save failure retries HTTP or executes the tool again. If the external file effect succeeded but the tool-row save failed, processing stops while the file remains; this bounded slice has no receipt journal and does not claim to roll back external effects. Empty completed output produces no fabricated assistant row.

The injected `WriteFixtureToolExecutor` accepts only `write_fixture`, requires exactly string `fileName` and `content`, rejects empty/dot/parent/absolute/path-component/NUL names, and uses atomic create-new UTF-8 writes under a test-owned temporary root. Existing files and symlinks are not overwritten. A create collision remains `file_exists`; another open/write/flush `IOException` returns the general `tool_io_error`. The executor does not retry or delete a possibly partial file and does not describe that outcome as rollback. The root is a test boundary, not an OS sandbox against a malicious process. Unknown tools, invalid schemas, and argument parse failures produce paired error responses with the original stable call ID and no file effect. The default tool-loop cap matches the current 500-iteration contract and tests can inject a smaller explicit cap.

The localhost integration suite proves two real POSTs around one real file effect, second-request call/output order, four canonical history rows, one processor claim, request receipt and fragmented SSE completion, held-body Stop cancellation with no tool start, bounded non-2xx capture, malformed/early-EOF rejection, missing-call-ID rejection, no effect after assistant-save failure, and one non-replayed effect with no second request after tool-row-save failure. Deterministic fake boundaries prove queued input ordering, malformed/unknown paired errors, the loop cap, general open/write I/O classification, and preservation of an injected partial file. `responses-request-corpus.json` is compared against the actual TypeScript `convertToOpenAIResponsesFormat` implementation for system/text, open metadata, empty assistant/user fields, phases, exact-false display exclusion, reasoning, annotations, raw and malformed call arguments, commentary fallback, paired tool output formatting/order, and the bounded error scalar domain. The latter includes single quotes, commas, line breaks, tabs, NUL, and NEL and requires exact `js-yaml` output; native V8/.NET parser diagnostics are still compared only through their existing compatibility category. The translation references current `src/sessionTurnRunner.ts`, `src/llmProviders/openai.ts`, `src/toolCallArgs.ts`, and `packages/shared/src/toolResponseFormatting.ts` behavior.

This client remains experiment-only. Its fake boundary can still use the in-memory authority substitute, while the C2/D localhost integration uses test-owned JSON/SQLite authority, exact Archive replay, and one explicit clean-idle two-process continuation. It excludes a general tool registry, MCP, Node execution, permissions, runtime Agent configuration, images and hosted tools, model routing/failover/retries, provider request compression, prompt-cache headers, WebSocket transport, streaming UI callbacks, effect receipts, request journaling/IDs, Channel delivery, Worker placement, crash/busy recovery, Session discovery, and production integration.

## Session-turn experiment

`Foxwarm.SessionTurns` is an experiment-only translation of the current Main-local `sessionWorkers:false` path. `SessionState` keeps bounded queue/history records, `nextMessageSeq`, `historyVersion`, and an owned v1 authority envelope using open JSON. `SessionEntry` protects short synchronous state mutations with a per-Session gate, serializes all authority work through a separate async save lane, claims one processor atomically, and transfers one active cancellation handle to Stop. `SessionIngress` awaits a best-effort save attempt before acknowledging ordinary input, and the owned processor makes another ordered best-effort snapshot attempt immediately before selecting an ordinary prefix. Busy claims and releases remain strict snapshots with precommit-only operation-scoped rollback; postrename failures retain the committed hot meaning.

`SessionTurnRunner` consumes the complete leading ordinary queue prefix in canonical order regardless of source platform, channel, or conversation, while preserving one canonical history row and `clientMessageId` per logical input. `QueueSource` retains provenance only and does not select a turn or reply target. `LocalSessionTurnHost` binds one exact Session entry and owns the complete provider/tool loop under that processor claim: canonical assistant commit, injected tool execution, canonical paired tool-row commit, post-tool ordinary-prefix consumption, then the next provider request. User batches, model calls, tool results, and final assistants all use the same contiguous sequence/timestamp builder. Stop sets the boundary, takes and cancels the active request before waiting for its later best-effort save, and finalizes accepted queued inputs without another model call. Canonical appends do not mutate hot history/queue before Archive→JSON commit, so precommit failure needs no broad snapshot restoration; postcommit publication removes only the captured queue identities and preserves later ingress/Stop state. Queue-prefix and Stop-finalization batch notifications remain non-poisoning and observable. Other assistant/busy/release callback behavior is unchanged.

The first committed nonempty input in a bounded turn controls parts preparation: a prebuilt message consumes that boundary without preparation, an empty row does not consume it, and a parts item prepares numeric `lastMessageTime` only when it is first. History-empty first-parts preparation also prepends the canonical `<foxwarm-system kind="session" currentSessionId="..." />` marker after Foxwarm attribute normalization and ECMAScript-whitespace collapsing. Later parts after a leading prebuilt message therefore receive no marker and do not change the timestamp. Caller-supplied `seq` is rejected; C2 owns contiguous sequence assignment. This remains a bounded owned-Message/persistence experiment, not crash recovery or production integration.

The component intentionally excludes any tool beyond the injected bounded executor, a general registry or placement layer, compact execution, retry, waits, managed state, child-handoff state transitions, channel delivery, Worker IPC or placement, crash/busy recovery, Session discovery, performance equivalence, and production runtime integration. The in-memory authority store remains a snapshot-ordering substitute; the persistent adapter and clean-restart harness are restricted to test-owned roots and the one explicitly bound Session ID.

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

Slices A and B use a separate request-input differential. `responses-request-corpus.json` covers canonical system wrapping plus text, open unknown metadata, empty assistant and user fields, recognized phase boundaries, exact-false display filtering, reasoning replay, same-model annotations, raw and malformed function-call arguments, call commentary fallback, and paired tool output formatting/order. The TypeScript runner imports the actual built `convertToOpenAIResponsesFormat` from `FOXWARM_TS_ROOT`; it does not reproduce the serializer in test code or invoke the network/request runtime. Run it with the same private SDK selected:

```sh
FOXWARM_TS_ROOT=/path/to/current/foxwarm \
  python3 experiments/dotnet/responses-request-parity-compare.py dotnet
```

The expected result is:

```text
comparison ok: 15 actual TypeScript/C# Responses request-input cases
```

Run the preserved Phase 2A differential oracle separately with `python3 experiments/dotnet/run-parity.py` after the repository JavaScript dependencies and shared generated package are available. The prototype remains outside normal Node CI and does not alter TypeScript runtime behavior, persistence, model routing, or Session ownership.
