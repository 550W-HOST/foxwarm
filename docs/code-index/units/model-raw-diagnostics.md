# Unit: Bounded raw model interaction diagnostics

Files: `dotnet/Foxwarm/Models/ModelInteractionDiagnostics.cs`
Secondary files: `dotnet/Foxwarm/Models/ConfiguredModelRequests.cs`, `dotnet/Foxwarm/Models/ModelRequestOwner.cs`, `dotnet/Foxwarm/Models/OpenAIHttp.cs`, `dotnet/Foxwarm/Models/Anthropic/AnthropicMessagesService.cs`, `dotnet/Foxwarm/Models/Responses/WebSockets/ResponsesWsResource.cs`, `dotnet/Foxwarm/Sessions/SessionManager.cs`, `dotnet/Foxwarm/Sessions/SessionManager.Setup.cs`, `dotnet/Foxwarm/CliCommands.cs`

## Design decisions

### D-MODEL-RAW-DIAGNOSTICS: Retain the bounded debugging surface

Confirmed 2026-10-20: ordinary model execution retains redacted raw request/response/error/stream diagnostics alongside the semantic request journal. These files are best-effort debugging data, never active history, retry input or a second authoritative journal. The journal's neutral manifest and semantic payload digest do not replace provider payloads, headers or malformed stream evidence.

## Producer and retention contract

`SessionManager` supplies one diagnostics root to ordinary turns, detached BTW and ToolScript requests; transient Setup tests use the same producer. The model CLI supplies its selected data root. `ConfiguredModelRequests` connects prepared payload capture and the best-effort `DiagnosticChatService` outcome wrapper. HTTP collectors observe decoded raw chunks/SSE blocks plus status, response headers and unnormalized provider payload/error body; Responses WebSocket leases observe raw frames and provider response payloads. Anthropic JSON and SSE retain their distinct payload forms.

`Interaction` owns one request/response file pair for the logical request context. The request owner recreates it at the existing logical-identity reset boundaries: explicit selection recapture, concrete adoption that changes context, committed-history recapture and changed request-only context. Unchanged concrete retries retain the first prepared body; unchanged-context virtual routing records attempt selections and updates the current concrete request. Earlier logical pairs remain debugging evidence rather than being paired with a later context's response. Failed attempts accumulate their own wire/error/stream evidence in the response file; a later successful response retains those attempts. Terminal failure/Stop moves existing files to the existing date-error directory. No new diagnostic authority, background payload queue, scheduler or archive policy is introduced.

Recent files live under `state/logs/recent`. The producer serializes pruning/writes and applies the existing twenty-regular-file housekeeping before each write; nested directories and dated/archive owners are untouched. Dated archival is separately owned and excludes recent. Ordinary raw body and SSE-block captures each retain at most 5,242,880 UTF-16 code units and expose truncation. Hosted-image streams retain structural counts/event types instead of raw content when effective Responses image configuration is enabled or the prepared input replays a native image-generation call. Observed output also activates omission, including semantically escaped image-field names and an interrupted first event before its SSE delimiter; event-type cardinality is bounded.

Redaction omits image data URLs, Anthropic base64 image data, image-generation results and preview/Images-API base64 fields while preserving unrelated business `result` fields. Each physical attempt captures the exact token/header credential values used by its prepared request; later configuration changes cannot remove those values from its redactor. Both HTTP error collectors carry their existing 64 KiB cutoff into redaction, without changing provider errors or retry classification. JSON-escaped credentials and interrupted credential prefixes are redacted even in short malformed events; recoverable quoted text is decoded for matching, and undecodable escaped literals are narrowly omitted while unrelated malformed evidence remains. An unterminated JSON literal at the raw capture cutoff is omitted when it cannot be decoded safely. Diagnostics never emit exception details when their own writes fail.

All preparation, capture and write failures are diagnostic-only. They neither withhold a successful result nor change provider retry/health behavior. Accepted diagnostic work is awaited by its producer, with no independent persistence/shutdown authority. The exact Session save owner alone commits commentary prefixes and final history; see [model streaming](../threads/model-request-and-streaming.md).

## Stable methods and tests

- `ModelInteractionDiagnostics.Begin` / `Interaction.StartAttempt`: logical file ownership and immutable attempt credential capture.
- `Attempt.PreparedAsync`, `Response`, `ResponseBody`, `Chunk`, `Block`, `FinishedAsync`: real serializer/transport/outcome producers and best-effort redaction.
- `Interaction.MoveToErrorAsync`: terminal-call diagnostic relocation, not retry state.
- `ModelInteractionDiagnosticsTests`: normal manager production through a live configuration change, malformed-stream/compressed-error retries, raw WebSocket frames, hosted-image omission, raw capture bounds, request/response write failures, terminal relocation and recent housekeeping; bounded HTTP errors, malformed/interrupted escaped credentials, semantic image-field and incomplete-event omission, native replay with the tool disabled, effective purpose-filtered configuration and concrete/virtual logical-context pairing.
