# Thread: model routing

## Overview

This thread owns routing graph validation, hash/health algorithms, concrete request rebuilding, attribution metadata and exact-owner adoption mechanics. [Models and requests](../behaviors/models-and-requests.md) owns the selected/attempted distinction, retry/adoption consequences and provider-sensitive history observations.

## Configuration and resolved graph

Concrete provider entries continue to use `providerType` plus provider connection fields and `models`. The preferred field remains `providerType`; persisted legacy `provider` is only a reader when `providerType` is absent. An unset or empty type uses the OpenAI protocol. Any other non-empty value must be one of the concrete or virtual types; unknown values are rejected during validation and never fall back to Anthropic.

A model object's optional `upstreamModelId` changes the outgoing model name without replacing its configured internal ID. Routing targets and ordinary attribution keep internal identity; native-history compatibility resolves declarations against those internal IDs, as defined by the [configuration unit](../units/model-configuration.md#native-history-compatibility); the resolved routing fingerprint includes the effective upstream value. Scope and normalization are owned by the [configuration unit](../units/model-configuration.md#contract-and-side-effects).

The concrete `openai-ws` type uses OpenAI Responses request/event semantics over
a provider WebSocket. It remains a concrete leaf for virtual routing; completed
connection state is scoped to that exact selected leaf and cannot cross a
failover or configuration boundary.

A non-empty string value in the preferred `providers` map is alias shorthand. At provider expansion it becomes exactly one virtual `session-hash` entry targeting the trimmed string; it does not create a separate alias or routing mechanism. The legacy root `models` naturally uses the same entry reader, while generated examples use `providers`.

Two virtual `providerType` values are supported:

- `session-hash` — stable session-prefix routing.
- `failover` — ordered health-aware fallback.

A virtual entry uses `targets`, containing model lookup keys that resolve strictly to concrete leaves in the same models-config snapshot. Canonical identity is an actual expansion key, so slash-containing model IDs remain exact and a single-model bare alias and qualified key resolve to the same leaf. Version 1 rejects empty targets, unknown targets, self references, virtual-to-virtual references, and aliases that resolve to the same canonical concrete target. `session-hash` accepts one or more targets; `failover` requires at least two.

Virtual entries do not accept `models`, legacy `model`, `baseUrl`, `apiKey`, `requestCompression`, `extraFields`, `extraHeaders`, `webSearch`, `imageGeneration`, `contextLimit`, `maxOutput`, `providerImageOutputFormat`, `effort`, `historyReasoningField`, `asyncCompact`, or `disallowEmptyResponse`. `session-hash` also rejects failover-only threshold/cooldown fields. Concrete entries reject virtual routing fields. Provider entries must be plain objects, and failover threshold/cooldown values are positive integers. Request connection and serialization fields always come from the selected concrete leaf.

The three model settings `contextLimit`, `maxOutput`, and `providerImageOutputFormat` resolve once per concrete leaf from model → provider → root `defaults` → startup-owned legacy app `llm` → built-in defaults. The root defaults object accepts only these three fields. Effective limits and image formats participate in the existing leaf fingerprint, while virtual entries expose only their derived safe context limit. Canonical configuration ownership is [src-config](../units/src-config.md#model-resolution).

The [configuration unit](../units/model-configuration.md#contract-and-side-effects) owns `asyncCompact` and `disallowEmptyResponse` provider/model precedence. Virtual async eligibility uses the resolved leaves; each attempted leaf supplies its own empty-response policy.

Concrete provider/model entries may configure first-class `effort: { allowed, default }`. Omission allows `none`, `low`, `medium`, `high`, `xhigh`, and `max` with default `high`. Model-level fields inherit the provider values except that an explicit model `allowed` list replaces the provider list; the resolved default must be included. Virtual entries cannot configure effort and expose the ordered union of reachable concrete levels.

The resolved virtual model reports:

- the minimum reachable concrete `contextLimit`;
- async compaction enabled only when every reachable leaf allows it;
- canonical concrete target keys;
- failover defaults of five consecutive failures and a 600,000 ms cooldown;
- a deterministic configuration fingerprint covering strategy and the complete resolved leaf request configuration. Secret inputs and header/extra maps contribute through hashes and are not retained in virtual routing metadata.

## Request flow

1. `requestLlmOnce` resolves one models-config snapshot and one logical prompt-cache routing key for the outer request. A normal exact-owner request may replace its selection snapshot only at the explicit model-change boundary below; the logical cache lineage stays unchanged. Virtual selection and request-journal lineage use that unchanged key; a selected `openai-ws` leaf derives its provider-facing key only inside the final concrete plan under [D-model-routing-openai-ws-prompt-cache-key](#d-model-routing-openai-ws-prompt-cache-key).
2. A concrete model uses its resolved entry directly. A virtual model selects one concrete target for the current attempt.
3. Every outer attempt rebuilds the selected leaf's URL, credentials, headers, payload (including its effective output-token limit), request compression, provider serializer, stream collector, and response parser. Image hydration optimizes an attempt-local clone using that leaf's effective input-image format and the existing format-specific derived cache; canonical original blobs remain unchanged. Historical model reasoning is compatibility-filtered against that attempt's canonical concrete destination, then Chat Completions emits it under that leaf's resolved `historyReasoningField`.
   For `openai-ws`, the rebuilt complete plan is matched against process-local completed chains only after this boundary; a match changes only the transport wire suffix, not the semantic request or journal.
4. One optional provider-neutral requested effort is captured with the selected model; only an explicit owner model change captures a replacement pair. Each concrete attempt uses it when allowed by that leaf, otherwise it falls back to that leaf's configured default. An omitted request also uses each selected leaf's default.
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

The [response-usability behavior](../behaviors/models-and-requests.md#routing-and-retry-change-the-attempted-request-not-the-saved-selection) distinguishes accepted empty completion from provider failure. `disallowEmptyResponse` is a concrete provider/model fingerprinted field with model overrides and default `false`; when enabled, the common response classifier returns retryable `response-error` for empty/whitespace/reasoning-only output. Tool calls and successful hosted images remain usable content.

## Surfaces and attribution

- Session and WebUI model selection continue to expose the configured virtual key. Public session projections expose raw current/child effort overrides separately from their derived effective values, allowed sets, and concrete defaults; virtual defaults are represented as per-leaf rather than inventing one route-level default.
- `ChatResult.modelId` and assistant `__meta.modelId` identify the canonical concrete leaf that actually succeeded. When the resolved route is virtual, successful results/messages additionally carry that resolved configuration key as optional `virtualModelKey`; concrete, user, tool, synthetic, failed, and legacy messages omit it. Logs and retry diagnostics continue to identify both the attempted concrete leaf and virtual route where applicable.
- WebUI Setup presents Models as raw YAML only. Its local static schema accepts provider objects or non-whitespace alias strings, and current-document suggestions include string-alias keys for model/default values but exclude them from concrete `targets`. Save uses the canonical config validator and remains byte-preserving after validation.
- Structured setup input accepts virtual targets and failover settings; setup diagnostics expose `isVirtual`, `targets`, `failureThreshold`, and `cooldownMs`. The model-list API also exposes the allowlisted provider key, internal configured model ID, provider type, virtual status, resolved targets, effective context limit, ordered allowed efforts, and a concrete default or `null` for virtual per-leaf defaulting, without connection URLs, leaf credentials, headers, or other provider configuration. The browser uses the explicit identity fields for duplicate-ID trigger qualification and uses virtual strategy/targets only as configured routing summaries, never as a claim about the dynamically selected leaf or current health.
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

**Derived design; proposed and approved for [virtual selection versus concrete execution](../behaviors/models-and-requests.md#selection-is-not-execution-identity).** Concrete-only targets keep health, effort and attribution unambiguous. Leaf validation is the chosen graph design, not a provider-protocol requirement; recursive routing would need a new product choice rather than an incidental resolver change.

Version 1 virtual targets are strict concrete leaves. Canonical identity is the actual qualified expansion key, not a reconstruction from the raw model ID. Reject nesting and canonical duplicates rather than defining recursive health, attribution, or cycle semantics implicitly.

[2026-08-18] A non-empty provider string is only syntax sugar for `{ providerType: 'session-hash', targets: [trimmedString] }` at the canonical provider-expansion boundary. The alias key remains a normal virtual model key and inherits all existing single-target session-hash resolution, validation, fingerprint, effort, context, compaction, display, default-selection, and attribution behavior. Empty targets, unknown/self targets, virtual-to-virtual nesting, and canonical duplicates remain rejected by the existing leaf-only graph rules; no recursive alias or second runtime alias mechanism is introduced.

### D-model-routing-prefix-hash

**Derived routing design; SHA-256 rendezvous hashing was proposed and approved for [stable prefix lineage](./session-lifecycle.md#d-lifecycle-prefix-lineage) and [virtual selection](../behaviors/models-and-requests.md#selection-is-not-execution-identity).** Rendezvous hashing supplies stable target affinity without depending on target order. Its approval is scoped to this affinity algorithm and its real routing consumer, not unrelated artifact fingerprinting.

Session hashing uses stable SHA-256 rendezvous hashing namespaced by the virtual key and driven by prompt-cache prefix lineage. Target ordering does not affect hash selection.

### D-model-routing-openai-ws-prompt-cache-key

**Mixed provenance: directly selected request-scope separation, with engineering-selected encoding.** Session-based hashing, shared awaited-compaction scope, the plain separator and BTW suffix were explicitly chosen. SHA-256 encoding and the background compact suffix implement that choice. It serves collision-free independent request scopes without changing [persisted prefix lineage](./session-lifecycle.md#d-lifecycle-prefix-lineage) or claiming a universal provider concurrency restriction.

[2026-09-13] Only a selected concrete `openai-ws` request derives its provider-facing `prompt_cache_key` from Session identity. Normal turns and synchronous/awaited compact planning use lowercase-hex `SHA256(session.id)`. Actual background compact planning uses `SHA256(session.id + '--compact-plan')`, and BTW uses `SHA256(session.id + '--btw')`; the separator is the literal two-character string `--`. Retries recompute the same value. A request without a Session ID keeps the existing request-stable low-level fallback rather than hashing a shared default.

Derivation occurs after virtual/concrete selection inside the complete request-plan boundary. The same effective value supplies the normal body field and `${SESSION_CACHE_KEY}` expansion in provider `extraFields`/`extraHeaders`, while established explicit override ordering remains unchanged. Persisted `Session.promptCacheKey`, fork/clear/compaction lineage, virtual session-hash selection, request-journal logical lineage metadata, and every non-WebSocket provider path keep their existing semantics; the attempt semantic payload naturally records the concrete wire plan.

### D-model-routing-outer-attempts

**Derived design; selected to keep one bounded request budget under [routing/retry behavior](../behaviors/models-and-requests.md#routing-and-retry-change-the-attempted-request-not-the-saved-selection).** Each physical attempt consumes that shared budget. The current default and legacy field name are configuration/compatibility details, not reasons to add retry loops inside virtual providers.

[Retry behavior](../behaviors/models-and-requests.md#routing-and-retry-change-the-attempted-request-not-the-saved-selection) has one bounded physical-attempt budget. The LLM outer loop selects/rebuilds each concrete plan; virtual providers contain no retry loop. Compatibility surfaces retain `maxRetries` for the total-attempt count, currently six by default.

### D-model-routing-effort

**Selected cross-provider setting design; proposed and approved.** It serves [explicit model/effort selection](../behaviors/sessions-and-agents.md#prospective-model-and-effort-are-a-pair) without multiplying model entries. Provider mappings implement that choice under their wire contracts; raw unset/default and explicit `none` must remain distinct across persistence and UI.

[2026-08-11] Model effort is one provider-neutral request setting with canonical values `none`, `low`, `medium`, `high`, `xhigh`, and `max`. Concrete provider/model configuration owns `{ allowed, default }`; omission allows all values and defaults to `high`. A model-level allowed list replaces the provider list, while a virtual model derives the ordered union of its concrete leaves and cannot define its own request override.

The requested effort is captured once per selected-model snapshot; explicit owner model changes follow [D-model-routing-live-session-selection](#d-model-routing-live-session-selection). Each physical attempt uses it only when the selected concrete leaf allows it, otherwise that leaf's default is used; omission also uses the leaf default. OpenAI Responses maps to `reasoning.effort`, OpenAI Chat Completions to `reasoning_effort`, and Anthropic-format providers to `output_config.effort`. `none` uses OpenAI's native value and disables Anthropic thinking while omitting Anthropic output effort. First-class mapping is applied after expanded `extraFields` without mutating configuration, so it is authoritative over known effort paths while preserving unrelated custom fields. The former global numeric thinking budget is removed.

[2026-08-11] A Session may persist optional raw `effort` and `childEffortDefault` overrides. Absence remains canonical unset/default and is never materialized from a concrete model's configured default; `none` is an explicit stored value. Current and prospective-child model/effort settings are normalized atomically from one models-config snapshot. Explicit effort must belong to the selected concrete allowed set or virtual union; a model-only change preserves a compatible stored effort and clears an incompatible one in the same persistence transaction. Existing persisted effort that becomes unsupported after configuration changes remains readable and request-time fallback stays leaf-local until a later settings mutation canonicalizes it.

[2026-08-11, updated 2026-08-25] Public effort controls extend the existing model surfaces instead of creating a model-by-effort matrix or parallel APIs/tools. Commands and HTTP settings accept model and effort together, distinguish omission from explicit unset/default, and return canonical post-update state. The existing child-settings tool clears effort only through property-presence `effort:"default"|"unset"`; legacy `clear:true` remains model-only, rejects a simultaneous supplied model, and may accompany an independent effort update. The compact Chat selector shows current and future-child effort controls beside the existing model rows; options are limited to the selected/effective model's allowed set, while trigger/status text shows derived effective values without storing defaults. Virtual unset is displayed as per-leaf defaulting, and stale raw overrides remain visibly selected but disabled with the backend-authoritative effective fallback until the user chooses a valid recovery value. Model-list capability payloads expose a concrete default or `null` for virtual per-leaf defaulting. Model-facing Session creation requires the explicit optional object `forceModel: { modelId?, effort? }`: omission and `{}` preserve inheritance/default behavior, `modelId` uses configured-model normalization, effort-only forcing applies atomically to the inherited/resolved model, and the removed top-level `model`/`effort` keys have no compatibility reader. Shared `/status`/`session(status)` output reports raw and effective current/child effort.

### D-model-routing-live-session-selection

**Derived implementation of directly requested [live adoption behavior](../behaviors/models-and-requests.md#switching-takes-effect-at-an-adoption-boundary).** Capturing an effective baseline and adopting it at the next attempt makes the change visible without fabricating a setter event or resetting retries. The metadata and owner ordering below are mechanisms, not another configuration authority.

[2026-10-16] [Selection adoption behavior](../behaviors/models-and-requests.md#switching-takes-effect-at-an-adoption-boundary) owns effective-change notices, coalescing, missing-key fallback and in-flight limits. This anchor retains exact-owner persistence and retry/Worker ordering; setters themselves do not enqueue notices or start work.

The exact owner appends one timestamped `foxwarm-system` notice with `kind="session-settings-changed"` through its existing canonical append boundary, then rebuilds committed provider context before compatibility filtering/hydration/send. Automatic failover to a different concrete leaf therefore informs that next physical attempt. Missing requested Session keys use the existing global-default resolver and report the requested key, actual model, and fallback reason; the same missing key and actual model do not warn on every retry/turn. Notices do not retain pending setter actors, so deferred changes and automatic routing/fallback never impersonate an earlier user action. Historical notices are left unchanged.

Authoritative `Session.meta.lastEffectiveRequest` stores only adopted canonical model, Node, actual request effort, and an optional missing requested key. It is separate from conditional-memory markers, assistant success attribution, and raw settings. Normal metadata persistence/load and compaction preserve it; fork/child creation starts fresh metadata. A regular first attempt silently establishes an unknown baseline. First-use missing-key fallback still warns, without invented old values. Effective old/new effort comes from the corresponding adopted attempts, never a later raw override or a synthetic `default`. The baseline describes adopted request configuration, not proof of network delivery. No Archive backfill, event queue, delivery transaction, or new rollback protocol is added. BTW/compact/detached/low-level calls cannot write this normal-owned baseline.

A normal authoritative `chat` still reads the exact owner's explicit raw model after established retry preparation. A changed raw selection replaces the models-config snapshot, route/generation and normalized requested effort even if it resolves to the same leaf and emits no notice. Ordinary configuration reloads and effort-only edits do not rewrite the captured snapshot for an unchanged selection request. Effective notices reuse the existing committed-history/journal/stream reconstruction boundary without resetting the remaining physical-attempt budget, committed output, or prompt-cache lineage. Conditional model memory and concrete/virtual attribution retain their existing boundaries.

Worker selection settings keep the existing serialized owner lane cooperatively at runner ingestion safe points: ingest the accepted mailbox prefix first, then execute a finite snapshot of pending selection settings. Pending `runPending` invocations remain transparent placeholders with execution/RPC completion after the active turn. History/admin and non-selection settings remain ordering barriers, and mixed patches retain one normalization/mutation. Validation errors fail their own settings call; owner persistence/resynchronization retains its existing boundary. Worker self-Node selection persists only its exact owner; notices are generated at the next normal request adoption, not by the setter.

### D-model-routing-failover-health

**Engineering design for the selected [single outer retry loop](#d-model-routing-outer-attempts).** Generation-scoped health prevents completion from an older request/configuration from steering a newer one. Process-local counters and cooldown machinery implement that goal; they do not introduce durable routing history or a second authority.

Failover health is process-local, configuration-fingerprinted, generation-scoped, and completion-ordered. Activation happens once per independent outer request; detached retries retain local failover semantics but cannot reactivate or mutate a newer configuration. Success resets one target, cooldown expiry starts a fresh streak, and final-target failure always ends that request while only an active generation resets global route state.

### D-model-routing-usable-response

[2026-09-12, updated 2026-10-28] Provider success no longer requires content by default: a completed response without non-whitespace assistant content and without a tool call is accepted across all provider protocols, and the empty completion ends the turn without fake `Error:` history. The concrete provider/model field `disallowEmptyResponse` restores the previous strict contract, making empty, whitespace-only, or reasoning-only responses retryable `response-error`s. A successful hosted generated image counts as real content, so a text-free image turn is accepted rather than retried as empty. The field inherits from provider to model with explicit model overrides, is rejected on virtual entries, participates in the route fingerprint, and is removed when structured setup converts a concrete provider into a virtual entry.

### D-model-routing-concrete-attribution

**Governing attribution constraint; directly selected.** It makes [selection versus execution](../behaviors/models-and-requests.md#selection-is-not-execution-identity) observable and supplies evidence for usage, replay and diagnostics. Persisted IDs name actual completed attempts; upstream aliases and later mutable settings cannot stand in for them.

Configured selection surfaces retain the virtual key. Successful results and provider-generated assistant history record the canonical concrete Foxwarm leaf that actually succeeded in the existing `modelId`; when and only when the resolved route was virtual, they also record its resolved models-config key as optional `virtualModelKey`. Resolve that key at routing time rather than inferring it later from mutable session selection. Do not substitute upstream vendor-reported model aliases, duplicate the concrete identity under a new field, or annotate user, tool, synthetic, failed, or legacy messages.

### D-model-routing-history-reasoning-compatibility

**Selected projection design; later declared model/provider compatibility was proposed and approved.** It serves [conversation-preserving model switching](../behaviors/models-and-requests.md#switching-preserves-conversation-but-filters-provider-sensitive-history) under [truthful source attribution](#d-model-routing-concrete-attribution). Attempt-local filtering implements provider admission without rewriting canonical history; the compatibility declaration is not configuration inheritance or cross-protocol conversion.

[2026-08-11, updated 2026-10-28] Provider-generated historical reasoning artifacts are sent when the historical model message has no concrete source identity (legacy/unknown) or its persisted canonical concrete `modelId` is compatible with the selected concrete destination under the request-captured catalog [projection](../units/model-configuration.md#native-history-compatibility). Without declarations this retains exact-ID behavior. An incompatible source removes thinking text, redacted thinking data, reasoning summaries/encrypted content/signatures, and message-scoped opaque provider fields from an attempt-local clone while preserving ordinary text, system content, images, tool calls, tool results, and their ordering. A model message left with reasoning alone is omitted from that attempt payload.

The comparison is per physical attempt and never uses the configured virtual key, session selection, provider type, upstream aliases, or inferred legacy identity. Canonical session history remains unchanged, and internal message metadata is not serialized to providers. Ordered OpenAI Responses hosted output items and URL annotations use the same captured compatibility rule: an incompatible destination drops only those provider-specific artifacts while retaining ordinary assistant text and tool history.

For a history-compatible Chat Completions message, the destination leaf's current `historyReasoningField` selects exactly one wire key, `reasoning_content` by default or `reasoning` when configured. The field name is provider configuration rather than persisted message metadata, is not inferred from response spelling, and changes the route configuration fingerprint. Canonical configuration ownership: [D-config-chat-history-reasoning-field](../units/src-config.md#d-config-chat-history-reasoning-field).
