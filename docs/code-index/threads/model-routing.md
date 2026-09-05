# Thread: model routing

## Overview

This thread owns the cross-module contract for concrete and virtual model selection, prompt-cache-lineage routing, per-attempt failover, provider request rebuilding, response usability, model attribution, and setup/CLI exposure.

## Configuration and resolved graph

Concrete provider entries continue to use `providerType` plus provider connection fields and `models`. The preferred field remains `providerType`; persisted legacy `provider` is only a reader when `providerType` is absent.

A non-empty string value in the preferred `providers` map is alias shorthand. At provider expansion it becomes exactly one virtual `session-hash` entry targeting the trimmed string; it does not create a separate alias or routing mechanism. The legacy root `models` naturally uses the same entry reader, while generated examples use `providers`.

Two virtual `providerType` values are supported:

- `session-hash` — stable session-prefix routing.
- `failover` — ordered health-aware fallback.

A virtual entry uses `targets`, containing model lookup keys that resolve strictly to concrete leaves in the same models-config snapshot. Canonical identity is an actual expansion key, so slash-containing model IDs remain exact and a single-model bare alias and qualified key resolve to the same leaf. Version 1 rejects empty targets, unknown targets, self references, virtual-to-virtual references, and aliases that resolve to the same canonical concrete target. `session-hash` accepts one or more targets; `failover` requires at least two.

Virtual entries do not accept `models`, legacy `model`, `baseUrl`, `apiKey`, `requestCompression`, `extraFields`, `extraHeaders`, `webSearch`, `contextLimit`, `effort`, `historyReasoningField`, or `asyncCompact`. `session-hash` also rejects failover-only threshold/cooldown fields. Concrete entries reject virtual routing fields. Provider entries must be plain objects, and failover threshold/cooldown values are positive integers. Request connection and serialization fields always come from the selected concrete leaf.

Concrete provider/model entries may configure first-class `effort: { allowed, default }`. Omission allows `none`, `low`, `medium`, `high`, `xhigh`, and `max` with default `high`. Model-level fields inherit the provider values except that an explicit model `allowed` list replaces the provider list; the resolved default must be included. Virtual entries cannot configure effort and expose the ordered union of reachable concrete levels.

The resolved virtual model reports:

- the minimum reachable concrete `contextLimit`;
- async compaction enabled only when every reachable leaf allows it;
- canonical concrete target keys;
- failover defaults of five consecutive failures and a 600,000 ms cooldown;
- a deterministic configuration fingerprint covering strategy and the complete resolved leaf request configuration. Secret inputs and header/extra maps contribute through hashes and are not retained in virtual routing metadata.

## Request flow

1. `requestLlmOnce` resolves one models-config snapshot and one prompt-cache routing key for the entire outer request.
2. A concrete model uses its resolved entry directly. A virtual model selects one concrete target for the current attempt.
3. Every outer attempt rebuilds the selected leaf's URL, credentials, headers, payload, request compression, provider serializer, stream collector, and response parser. Historical model reasoning is compatibility-filtered against that attempt's canonical concrete destination, then Chat Completions emits it under that leaf's resolved `historyReasoningField`.
4. One optional provider-neutral requested effort is captured for the outer request. Each concrete attempt uses it when allowed by that leaf, otherwise it falls back to that leaf's configured default. An omitted request also uses each selected leaf's default.
5. A successful result records the concrete provider-qualified model ID. The session's selected model remains the virtual key.
6. Retry callbacks retain the compatibility `maxRetries` field, whose value is the total attempt limit. The default total attempt limit is six.

Virtual providers add no retry loop of their own. The one LLM outer loop remains the owner of attempts, delay, abort handling, diagnostics, and terminal `LlmRequestError` creation.

## Session-hash routing

`session-hash` uses SHA-256 highest-random-weight (rendezvous) hashing over the virtual model key, the resolved `Session.promptCacheKey` lineage value, and each canonical target key. The target with the greatest digest wins; a canonical target-key tie break keeps the result independent of configured target order.

The request routing key is resolved once before the attempt loop. Normal sessions persist a random low-sensitivity UUID tied to stable conversation/cache-routing lineage. Forks, side requests, and compaction inherit it; only clear starts a new lineage. Consequently, successful compact rewrites remain on the same virtual leaf.

A low-level request without a usable key receives one request-scoped random key; retries do not generate another key.

## Failover health

Failover health is process memory, scoped by virtual model key, configuration fingerprint, and canonical concrete target. It is not session state and is not persisted. Restart and configuration changes reset the active route state. Each independent outer request captures the active fingerprint generation once; retries and outcomes continue against that request's local snapshot after another configuration becomes active, including reaching and terminating on its own final target. Detached requests cannot publish into the newer active state, while a later independent request that deliberately rolls back configuration activates a fresh generation.

Selection chooses the first configured target that is not cooling down. Outcomes are applied synchronously in completion order:

- a countable failure increments only the selected target's consecutive-failure streak;
- reaching `failureThreshold` cools a non-final target for `cooldownMs`;
- cooldown expiry removes the old streak before the target becomes eligible again;
- success resets only the successful target;
- a countable failure from the configured final target clears the route's health and terminates the current request, so the next independent request starts from the first target.

With defaults and two targets, attempts 1–5 may fail on A, the fifth failure cools A, and attempt 6 selects B.

## Failure and response usability

Failures that are retryable and count toward failover health:

- network, DNS, TLS, timeout, and stream failures;
- HTTP 408, 429, 5xx, and 529;
- HTTP 401, 403, and 404;
- model-not-found responses, including HTTP 400 bodies identified by nested structured error code/type or bounded model-specific text patterns;
- malformed or unusable successful responses.

HTTP 400, 413, and 422 are terminal and do not affect route health unless the body identifies model-not-found. Other HTTP statuses preserve the prior retry behavior but do not affect shared route health until explicitly classified.

Abort, stop, and cancellation terminate immediately and do not count as target health failures.

Across OpenAI Chat Completions, OpenAI Responses, Anthropic, Gemini, and compatible concrete providers, a successful model turn must contain non-whitespace assistant content, at least one tool call, or provider inline output such as a generated image. Thinking/reasoning alone is not content. A tool-call-only or inline-output-only response is valid. An empty, whitespace-only, or reasoning-only response is a retryable `response-error` and never creates fake model-visible `Error:` history.

## Surfaces and attribution

- Session and WebUI model selection continue to expose the configured virtual key. Public session projections expose raw current/child effort overrides separately from their derived effective values, allowed sets, and concrete defaults; virtual defaults are represented as per-leaf rather than inventing one route-level default.
- `ChatResult.modelId` and assistant `__meta.modelId` identify the canonical concrete leaf that actually succeeded. When the resolved route is virtual, successful results/messages additionally carry that resolved configuration key as optional `virtualModelKey`; concrete, user, tool, synthetic, failed, and legacy messages omit it. Logs and retry diagnostics continue to identify both the attempted concrete leaf and virtual route where applicable.
- WebUI Setup presents Models as raw YAML only. Its local static schema accepts provider objects or non-whitespace alias strings, and current-document suggestions include string-alias keys for model/default values but exclude them from concrete `targets`. Save uses the canonical config validator and remains byte-preserving after validation.
- Structured setup input accepts virtual targets and failover settings; setup diagnostics expose `isVirtual`, `targets`, `failureThreshold`, and `cooldownMs`. The model-list API also exposes provider type, virtual status, resolved targets, effective context limit, ordered allowed efforts, and a concrete default or `null` for virtual per-leaf defaulting, without leaf credentials.
- `/model`, `/session child-model`, the existing model/child-model WebUI endpoints, and the compact Chat selector update model-plus-effort pairs through one SessionRuntime settings mutation. Property presence distinguishes omitted fields from explicit unset/default, and `none` remains an explicit value.
- Model-facing `create_child_session` and `create_session` schemas expose optional strict `forceModel: { modelId?, effort? }` for visibly intentional current-session overrides. Omission or `{}` keeps existing inheritance/default behavior, while removed top-level keys are rejected. `set_session_child_model` sets or clears future-child model and effort defaults without introducing another overlapping settings tool. Shared session status reports raw/effective current and child effort.
- The one-shot model CLI lists and accepts virtual keys while reusing production routing.
- Raw model readers that need concrete credentials, such as the bundled web-search helper, skip virtual entries and inspect concrete providers only.
- The active models file follows [D-config-models-data-path](../units/src-config.md#d-config-models-data-path); the packaged template is only a missing-file read fallback.

## Modules and units

- [LLM module](../modules/llm.md)
- [src-config](../units/src-config.md)
- [src-model-routing](../units/src-model-routing.md)
- [src-llm](../units/src-llm.md)
- [src-channels-webui](../units/src-channels-webui.md)
- [model-cli](../units/model-cli.md)
- [src-skills](../units/src-skills.md)
- Prefix lifecycle: [D-lifecycle-prefix-lineage](./session-lifecycle.md#d-lifecycle-prefix-lineage)
- Retry presentation: [D-pipeline-display-only-retries](./message-processing-pipeline.md#d-pipeline-display-only-retries)

## Design decisions

### D-model-routing-provider-type

Virtual routing remains a `providerType` contract. `session-hash` and `failover` are the two current values; the schema does not introduce a replacement `type` field. Concrete legacy `provider` remains a fallback reader only.

### D-model-routing-leaf-only

Version 1 virtual targets are strict concrete leaves. Canonical identity is the actual qualified expansion key, not a reconstruction from the raw model ID. Reject nesting and canonical duplicates rather than defining recursive health, attribution, or cycle semantics implicitly.

[2026-08-18] A non-empty provider string is only syntax sugar for `{ providerType: 'session-hash', targets: [trimmedString] }` at the canonical provider-expansion boundary. The alias key remains a normal virtual model key and inherits all existing single-target session-hash resolution, validation, fingerprint, effort, context, compaction, display, default-selection, and attribution behavior. Empty targets, unknown/self targets, virtual-to-virtual nesting, and canonical duplicates remain rejected by the existing leaf-only graph rules; no recursive alias or second runtime alias mechanism is introduced.

### D-model-routing-prefix-hash

Session hashing uses stable SHA-256 rendezvous hashing namespaced by the virtual key and driven by prompt-cache prefix lineage. Target ordering does not affect hash selection.

### D-model-routing-outer-attempts

There is one outer LLM attempt loop, with six total attempts by default. Each virtual attempt selects a leaf and rebuilds the complete concrete request; virtual providers do not contain another retry loop. Compatibility surfaces retain the historical `maxRetries` field name even though it means total attempts.

### D-model-routing-effort

[2026-08-11] Model effort is one provider-neutral request setting with canonical values `none`, `low`, `medium`, `high`, `xhigh`, and `max`. Concrete provider/model configuration owns `{ allowed, default }`; omission allows all values and defaults to `high`. A model-level allowed list replaces the provider list, while a virtual model derives the ordered union of its concrete leaves and cannot define its own request override.

The requested effort is captured once per outer request. Each physical attempt uses it only when the selected concrete leaf allows it, otherwise that leaf's default is used; omission also uses the leaf default. OpenAI Responses maps to `reasoning.effort`, OpenAI Chat Completions to `reasoning_effort`, and Anthropic-format providers to `output_config.effort`. `none` uses OpenAI's native value, disables Anthropic thinking, and maps to Gemini's portable zero thinking budget. Non-zero Gemini effort leaves the selected model's native policy unchanged because model generations expose incompatible budget/level controls. First-class mapping is applied after expanded `extraFields` without mutating configuration, so it is authoritative over known effort paths while preserving unrelated custom fields. The former global numeric thinking budget is removed.

[2026-08-11] A Session may persist optional raw `effort` and `childEffortDefault` overrides. Absence remains canonical unset/default and is never materialized from a concrete model's configured default; `none` is an explicit stored value. Current and prospective-child model/effort settings are normalized atomically from one models-config snapshot. Explicit effort must belong to the selected concrete allowed set or virtual union; a model-only change preserves a compatible stored effort and clears an incompatible one in the same persistence transaction. Existing persisted effort that becomes unsupported after configuration changes remains readable and request-time fallback stays leaf-local until a later settings mutation canonicalizes it.

[2026-08-11, updated 2026-08-25] Public effort controls extend the existing model surfaces instead of creating a model-by-effort matrix or parallel APIs/tools. Commands and HTTP settings accept model and effort together, distinguish omission from explicit unset/default, and return canonical post-update state. The existing child-settings tool clears effort only through property-presence `effort:"default"|"unset"`; legacy `clear:true` remains model-only, rejects a simultaneous supplied model, and may accompany an independent effort update. The compact Chat selector shows current and future-child effort controls beside the existing model rows; options are limited to the selected/effective model's allowed set, while trigger/status text shows derived effective values without storing defaults. Virtual unset is displayed as per-leaf defaulting, and stale raw overrides remain visibly selected but disabled with the backend-authoritative effective fallback until the user chooses a valid recovery value. Model-list capability payloads expose a concrete default or `null` for virtual per-leaf defaulting. Model-facing Session creation requires the explicit optional object `forceModel: { modelId?, effort? }`: omission and `{}` preserve inheritance/default behavior, `modelId` uses configured-model normalization, effort-only forcing applies atomically to the inherited/resolved model, and the removed top-level `model`/`effort` keys have no compatibility reader. Shared `/status`/`session(status)` output reports raw and effective current/child effort.

### D-model-routing-failover-health

Failover health is process-local, configuration-fingerprinted, generation-scoped, and completion-ordered. Activation happens once per independent outer request; detached retries retain local failover semantics but cannot reactivate or mutate a newer configuration. Success resets one target, cooldown expiry starts a fresh streak, and final-target failure always ends that request while only an active generation resets global route state.

### D-model-routing-usable-response

A provider success requires non-whitespace assistant content, a tool call, or provider inline output such as a generated image. Reasoning-only and empty responses are retryable response failures across all provider protocols.

### D-model-routing-concrete-attribution

Configured selection surfaces retain the virtual key. Successful results and provider-generated assistant history record the canonical concrete Foxwarm leaf that actually succeeded in the existing `modelId`; when and only when the resolved route was virtual, they also record its resolved models-config key as optional `virtualModelKey`. Resolve that key at routing time rather than inferring it later from mutable session selection. Do not substitute upstream vendor-reported model aliases, duplicate the concrete identity under a new field, or annotate user, tool, synthetic, failed, or legacy messages.

### D-model-routing-history-reasoning-compatibility

[2026-08-11] Provider-generated historical reasoning artifacts are sent only when the historical model message has no concrete source identity (legacy/unknown) or its persisted canonical concrete `modelId` exactly matches the selected concrete destination for that physical attempt. A proven exact mismatch removes thinking text, reasoning summaries/encrypted content/signatures, and message-scoped opaque provider fields from an attempt-local clone while preserving ordinary text, system content, images, tool calls, tool results, and their ordering. A model message left with reasoning alone is omitted from that attempt payload.

The comparison is per physical attempt and never uses the configured virtual key, session selection, provider type, upstream aliases, or inferred legacy identity. Canonical session history remains unchanged, and internal message metadata is not serialized to providers. Ordered OpenAI Responses hosted output items and URL annotations use the same exact concrete-model rule: a known different destination drops only those provider-specific artifacts while retaining ordinary assistant text and tool history.

For a compatible same-concrete-model Chat Completions message, the destination leaf's current `historyReasoningField` selects exactly one wire key, `reasoning_content` by default or `reasoning` when configured. The field name is provider configuration rather than persisted message metadata, is not inferred from response spelling, and changes the route configuration fingerprint. Canonical configuration ownership: [D-config-chat-history-reasoning-field](../units/src-config.md#d-config-chat-history-reasoning-field).
