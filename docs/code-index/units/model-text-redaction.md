# Unit: Reversible model text redaction

Files: `dotnet/Foxwarm/Models/TextRedactor.cs`, `dotnet/Foxwarm/Models/TextRedactionOptions.cs`, `dotnet/Foxwarm/Models/TextRedactionProjection.cs`, `dotnet/Foxwarm/Models/TextRedactionChatService.cs`
Secondary integration: `ConfiguredModelRequests`, `HostModels`, `ModelRequestOwner`, `ResponsesClientOptions`, `packages/shared/src/configSchemas.ts`

## D-model-text-redaction

[2026-11-03] Model-selected redaction is disabled by default. It replaces detected private ordinary input text on request copies, then restores only known placeholders in ordinary output and structured tool arguments. Local history is unchanged by input preparation. All thinking, reasoning summaries, signatures and encrypted blocks pass through unchanged in both directions. Request `extraFields`, headers, credentials, protocol identifiers and schema structure are outside detection. Citation offsets are not adjusted; restored text may no longer match a citation span.

Keys are stable across Sessions: the placeholder is `[[FW_PRIVATE_` followed by the lowercase SHA-256 of the detected original UTF-8 bytes and `]]`. The process-wide reverse map holds original strings. Unknown or modified placeholders remain unchanged. This is reversible substitution, not encryption or protection against guessing low-entropy values. Reverse data and successful detection results are memory-only; after restart, request originals repopulate them. Output never invokes the detector.

Enabled detection fails closed. Transient detection errors consume the existing request retry budget without provider-health failures, failover, provider attempt-start publication or a claim that an LLM request was sent. Configuration/authentication/invalid-response errors are terminal; Stop does not retry. Other preparation failures keep their existing behavior.

## Configuration and external service

`textRedaction` accepts a boolean or an options object. Fields inherit independently from models `defaults`, concrete provider, then model. Booleans set only `enabled`; an object does not implicitly enable redaction. Explicit lower-level `false` overrides an inherited enablement. Virtual providers cannot configure it; the selected concrete leaf supplies the captured settings. All supplied scopes validate even when masked. Raw YAML editing uses the shared Models schema; structured saves retain existing provider/model overrides and remove the concrete-only setting on virtual conversion.

```yaml
defaults:
  textRedaction:
    enabled: true
    endpoint: https://detector.example/v1/classify
    threshold: 0.5
    timeoutMs: 30000
providers:
  example:
    providerType: openai-responses
    models:
      - id: protected
      - id: unfiltered
        textRedaction: false
```

`endpoint` is the full HTTP(S) classification URL and is required when enabled. Optional `apiKey` supplies a Bearer credential to that service. A positive integer `timeoutMs` bounds each detection call (default 30000); `threshold` is finite and between zero and one (default 0.5). An existing explicit model-attempt hard deadline also includes detection. No model runtime, service management, disk cache or dedicated administration surface is provided.

`TextRedactor.RedactAsync` posts one Content-Length-delimited JSON object `{text, threshold}`. A successful response must contain `entities: [{start, end, score, label}]`, `offset_unit: "utf8_bytes"`, matching `input_bytes` and nonnegative integer `input_tokens`. Offsets are half-open UTF-8 byte ranges with strict scalar boundaries. Scores are finite within zero and one; every nonempty category, including an unknown future category, is redacted. Overlapping ranges are merged; adjacent independent ranges keep separate keys. The service owns whole-text classification and any sliding windows. A size/token-limit rejection is not partial success, and the client does not silently truncate or split input.

HTTP 408, 429, 5xx, connection failures and timeouts are retryable. Other HTTP failures and malformed/invalid success responses fail directly. Service bodies and credential values are not copied into public detection errors. The client has no additional retry loop. The shared successful-detection LRU is bounded by 2048 entries and four million UTF-16 code units across source/result strings; its key includes resolved detector settings and exact text. The reverse map intentionally lasts for the process lifetime independently of cache eviction.

## Request, progress and replay integration

`ConfiguredModelRequests.CreatePreparedService` installs the semantic wrapper only for an enabled concrete model. It runs after concrete history projection/hydration and before serializer/transport preparation, covering configured Responses HTTP/SSE/WebSocket, Chat Completions and Anthropic requests. The shared request owner reaches normal turns, compact planning, detached BTW, automatic titles, ToolScript and CLI calls without changing their budgets. Setup's ad-hoc connection test retains its transient, single-attempt connection-test configuration; it does not adopt installed model redaction settings.

`TextRedactionProjection` selects instructions, ordinary `text`/`system` and supported legacy text content, historical function-argument string values, formatted tool output text and tool/schema descriptions. JSON object keys, function names, call IDs, enums, schema example/default values and schema keywords are not substituted. Only description fields reached through schema keywords are scanned. Raw historical argument text has serializer precedence: valid JSON is parsed and its string values transformed, then both canonical args and raw JSON are kept consistent. Malformed historical raw argument text remains on its existing error/replay path, with its text detected. Tool outputs are formatted through the existing text formatter before detection; canonical business results are not rewritten.

Cumulative streaming snapshots restore ordinary text while holding a trailing incomplete placeholder. Thinking snapshots remain untouched. Tool-argument progress is published as restored JSON once a complete JSON value is available; incomplete argument JSON is withheld. Completed commentary callbacks and final results use the same canonical restoration before persistence, display and local tool execution. Valid raw argument JSON is synchronized with the restored object, so escaping quotes, backslashes and line breaks does not corrupt JSON. Invalid argument errors retain their existing non-executable status.

The wrapper returns restored committed rows to canonical consumers but keeps provider-form rows in the Responses attempt. Its append finalizer substitutes the corresponding provider-form assistant parts before WS fingerprint extension; valid raw argument JSON uses the same normalized structured representation as the next request. It never detects or guesses text during synchronous finalization. A changed canonical append discards the chain rather than caching an unrecognized replay. The next request detects its own request copy before WS suffix selection. Existing reconnect, hosted-search discard, prefix persistence and Stop semantics remain owned by Responses and the turn host.

The neutral journal manifest still contains local original input; successful journal results contain restored canonical output. Attempt digests and raw transport diagnostics observe provider-form requests/output. This feature does not redact local storage or change raw diagnostic retention.

## Evidence

- `TextRedactionTests` covers inheritance/disablement, validated structured-save preservation, Unicode byte offsets, stable/reversible keys, bounded successful-detection caching, future labels, invalid offsets, failure budgets, Stop, unsent journal attempts, provider health, shared detection/provider retries and cross-Session ToolScript one-shot restoration.
- `TextRedactionProtocolsTests` uses local HTTP detector/provider fixtures for ordinary inputs, descriptions versus schema structure, raw argument precedence, immutable history, extra-field/header/thinking pass-through, structured restoration and Anthropic/Completions progress.
- `ResponsesPrefixCommitTests.TextRedaction` uses real SSE and WebSocket peers with the normal persistent turn/tool loop: fragmented placeholders, restored early commentary, quoted/multiline tool arguments at execution, thinking retention, tool continuation and subsequent WS suffix reuse.
