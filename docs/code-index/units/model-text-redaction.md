# Unit: Reversible model text redaction

Files: `dotnet/Foxwarm/Models/TextRedactor.cs`, `dotnet/Foxwarm/Models/TextRedactionOptions.cs`, `dotnet/Foxwarm/Models/TextRedactionProjection.cs`, `dotnet/Foxwarm/Models/TextRedactionChatService.cs`
Secondary integration: `ConfiguredModelRequests`, `HostModels`, `ModelRequestOwner`, `ResponsesClientOptions`, `InstanceSecrets`, `ModelConfiguration.Secrets`, `SecretReferences` (`SecretSinks.Models`), `SecretConfigurationChanges`, `packages/shared/src/configSchemas.ts`

## D-model-text-redaction

[2026-11-03] Model-selected redaction is disabled by default. It replaces detected private ordinary input text on request copies, then restores only known placeholders in ordinary output and structured tool arguments. Local history is unchanged by input preparation. All thinking, reasoning summaries, signatures and encrypted blocks pass through unchanged in both directions. Request `extraFields`, headers, credentials, protocol identifiers and schema structure are outside detection. Citation offsets are not adjusted; restored text may no longer match a citation span.

[2026-11-09] Placeholders are keyed and short: `[[PRIVATE_` followed by the first 16 lowercase hex characters (64 bits) of HMAC-SHA256 over the detected original UTF-8 bytes, then `]]`. The HMAC key is derived from the shared instance key (`<data root>/keys/secrets.key`) with the HKDF purpose `text-redaction-placeholder`; there is no separate key file. Placeholders are therefore stable across Sessions and restarts of one installation, differ between installations, and a provider cannot confirm a guessed low-entropy value by hashing it. The shape is deliberately distinct from irreversible `[[FW_SECRET:<label>]]` markers and uses a fixed hex alphabet that models copy verbatim. One reverse map and detection cache exist per derived key for the process lifetime. Unknown or modified placeholders remain unchanged. This is reversible substitution, not encryption. Reverse data and successful detection results are memory-only; after restart, request originals repopulate them. Output never invokes the detector.

Registering a placeholder that already maps to a different original is a collision. The request fails with a terminal (non-retryable) text-redaction failure before any provider contact; the existing mapping is kept, and the colliding text is not cached. Deterministic termination was chosen over longer digests or suffixes because a 64-bit truncated HMAC collision is not expected in practice and must never restore a wrong value.

If the instance key cannot be read (missing key beside an existing store, unreadable or malformed key file) or the request owner has no key source, an enabled request fails with a terminal text-redaction failure before detection; the original is never sent. A store file that is locked for other reasons does not block redaction while the key itself is readable.

Secret masking (stage S in `ModelRequestOwner`) runs before the journal manifest and `PrepareRequest`; this wrapper runs later in `CreatePreparedService`, so detection only sees already masked text. `[[FW_SECRET:<label>]]` markers pass through unchanged: a detected range keeps only its parts outside markers (whitespace-only remainders are not replaced), and restoration only matches this feature's placeholders.

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
    excludeLabels: [private_date, private_url]
providers:
  example:
    providerType: openai-responses
    models:
      - id: protected
      - id: unfiltered
        textRedaction: false
```

`endpoint` is the full HTTP(S) classification URL and is required when enabled. Optional `apiKey` supplies a Bearer credential to that service. It is a secret sink at defaults, provider and model level (`SecretSinks.Models`): a `${secret:NAME}` reference resolves with the catalog, the value is used only for the detection request's `Authorization` header, and literal or stored values are known values for the secret redactor. A missing referenced name fails providers whose enabled redaction would send it (for a defaults reference, only providers with a leaf that inherits that key), before detection or provider contact. Because these settings inherit field by field, model-initiated `set_config` cannot change any `textRedaction` settings while any of them reference a secret. `excludeLabels` lists detection labels left unchanged (default `private_date` and `private_url`); a lower-level list replaces the inherited list, and an empty list redacts every label. A positive integer `timeoutMs` bounds each detection call (default 30000); `threshold` is finite and between zero and one (default 0.5). An existing explicit model-attempt hard deadline also includes detection. No model runtime, service management, disk cache or dedicated administration surface is provided.

`TextRedactor.RedactAsync` posts one Content-Length-delimited JSON object `{text, threshold}`. A successful response must contain `entities: [{start, end, score, label}]`, `offset_unit: "utf8_bytes"`, matching `input_bytes` and nonnegative integer `input_tokens`. Offsets are half-open UTF-8 byte ranges with strict scalar boundaries. Scores are finite within zero and one; every entity is validated, then entities whose label is excluded are dropped. Every other nonempty category, including an unknown future category, is redacted. Overlapping ranges are merged; adjacent independent ranges keep separate keys. The service owns whole-text classification and any sliding windows. A size/token-limit rejection is not partial success, and the client does not silently truncate or split input.

HTTP 408, 429, 5xx, connection failures and timeouts are retryable. Other HTTP failures and malformed/invalid success responses fail directly. Service bodies and credential values are not copied into public detection errors. The client has no additional retry loop. The shared successful-detection LRU is bounded by 2048 entries and four million UTF-16 code units across source/result strings; its key includes resolved detector settings and exact text. The reverse map intentionally lasts for the process lifetime independently of cache eviction.

## Request, progress and replay integration

`ConfiguredModelRequests.CreatePreparedService` installs the semantic wrapper only for an enabled concrete model. It runs after concrete history projection/hydration and before serializer/transport preparation, covering configured Responses HTTP/SSE/WebSocket, Chat Completions and Anthropic requests. The shared request owner reaches normal turns, compact planning, detached BTW, automatic titles, ToolScript and CLI calls without changing their budgets. Setup's ad-hoc connection test retains its transient, single-attempt connection-test configuration; it does not adopt installed model redaction settings.

`TextRedactionProjection.RedactHistoryAsync` edits text slots in the request-owned history already produced by concrete preparation and image hydration. It does not clone hydrated message/part trees again: unsupported-image, deduplication and transmitted-dimension side tables depend on those part identities. Canonical history remains outside this mutable ownership. The projection selects instructions, ordinary `text`/`system` and supported legacy text content, historical function-argument string values, formatted tool output text and tool/schema descriptions. JSON object keys, function names, call IDs, enums, schema example/default values and schema keywords are not substituted. Only description fields reached through schema keywords are scanned. Raw historical argument text has serializer precedence: valid JSON is parsed and its string values transformed, then both canonical args and raw JSON are kept consistent. Malformed historical raw argument text remains on its existing error/replay path, with its text detected. Tool outputs are formatted through the existing text formatter before detection; canonical business results are not rewritten.

Cumulative streaming snapshots restore ordinary text while holding a trailing incomplete placeholder. Thinking snapshots remain untouched. Tool-argument progress is published as restored JSON once a complete JSON value is available; incomplete argument JSON is withheld. Completed commentary callbacks and final results use the same canonical restoration before persistence, display and local tool execution. Valid raw argument JSON is synchronized with the restored object, so escaping quotes, backslashes and line breaks does not corrupt JSON. Invalid argument errors retain their existing non-executable status.

The wrapper returns restored committed rows to canonical consumers but keeps provider-form rows in the Responses attempt. Its append finalizer substitutes the corresponding provider-form assistant parts before WS fingerprint extension; valid raw argument JSON uses the same normalized structured representation as the next request. It never detects or guesses text during synchronous finalization. A changed canonical append discards the chain rather than caching an unrecognized replay. The next request detects its own request copy before WS suffix selection. Existing reconnect, hosted-search discard, prefix persistence and Stop semantics remain owned by Responses and the turn host.

The neutral journal manifest still contains local original input; successful journal results contain restored canonical output. Attempt digests and raw transport diagnostics observe provider-form requests/output. This feature does not redact local storage or change raw diagnostic retention.

## Evidence

- `TextRedactionTests` (with `.Keys` and `.OneShot`) covers HMAC placeholder shape and stability across redactor instances and a reopened instance key, different keys, collision termination, unavailable-key failure without detection or send, `excludeLabels` defaults/inheritance/validation, secret markers overlapping detected ranges, an installed host with a referenced detector key and stage-S markers, missing-reference scoping and the `set_config` restriction, plus inheritance/disablement, validated structured-save preservation, Unicode byte offsets, stable/reversible keys, bounded successful-detection caching, future labels, invalid offsets, failure budgets, Stop, unsent journal attempts, provider health, shared detection/provider retries and cross-Session ToolScript one-shot restoration.
- `TextRedactionProtocolsTests` uses local HTTP detector/provider fixtures for ordinary inputs, descriptions versus schema structure, raw argument precedence, immutable history, extra-field/header/thinking pass-through, structured restoration and Anthropic/Completions progress.
- `TextRedactionImageTests` exercises the normal owner through all four transports with user/tool image references: text-only omission, duplicate-image suppression, resized-image labels and unchanged canonical input.
- `ResponsesPrefixCommitTests.TextRedaction` uses real SSE and WebSocket peers with the normal persistent turn/tool loop: fragmented placeholders, restored early commentary, quoted/multiline tool arguments at execution, thinking retention, tool continuation and subsequent WS suffix reuse.
