# Behavior: models and requests

For developers and Agents changing model selection, provider requests, or request attribution. This page describes the current TypeScript request path; sharing a model name or protocol with another runtime does not establish behavioral parity. [Messages and turns](messages-and-turns.md) owns input/turn/request boundaries, [conversation and history](conversation-and-history.md) owns what context contains, and [execution and waiting](execution-and-waiting.md) owns turn controls.

## Selection is not execution identity

| Identity | What a human or runtime Agent can infer |
| --- | --- |
| Selected model key | The Session's requested configuration entry, possibly a virtual route. It is not necessarily the concrete model used by any particular attempt. |
| Concrete model ID | Foxwarm's canonical provider-qualified leaf identity. Successful assistant history records the leaf that produced it, not an upstream vendor's returned alias. |
| Virtual model key | Optional attribution alongside the concrete ID when that successful request used a virtual entry. The Session can keep selecting the route while its attempts use different leaves. |
| Logical request ID and attempt | Correlate canonical request inputs, observed attempts, streams, and successful history. They are not an external provider idempotency key or proof of network delivery. |
| Turn ID | Ephemeral correlation across provider/tool work in one turn invocation. It is not a Session identity, reply address, or durable recovery instruction. |
| Prompt-cache lineage | Stable routing/cache-prefix identity, shared through forks and compaction as specified by [prefix lineage](../threads/session-lifecycle.md#d-lifecycle-prefix-lineage). It is not the logical request ID. |

For example, selecting `route` and receiving `provider-a/model-x` does not replace the Session's selection with that leaf. A later failover result may attribute `provider-b/model-y` while the picker still shows `route`. Usage details must use recorded attribution, not the picker's current value.

A single-model concrete provider can have both a bare lookup key and a qualified key for the same leaf. A string alias is a one-target virtual route, not an additional provider implementation. Missing persisted Session keys resolve through the global default; failure to resolve any usable entry is a configuration error, not permission to choose an arbitrary provider. Expansion, validation, and exact identity rules remain in [model resolution](../units/src-config.md#model-resolution).

## Routing and retry change the attempted request, not the saved selection

`session-hash` chooses a stable leaf from the virtual key, canonical targets, and prompt-cache lineage. Reordering targets alone does not change selection. Clear starts a new lineage; successful compaction does not. This is stable routing, not a guarantee of upstream prompt-cache reuse. A selected `openai-ws` leaf has its own provider-facing cache-key derivation without changing that logical lineage.

`failover` considers ordered targets and their process-local health. Independent requests in the same process share health for the same active route configuration, so one Session's failures can influence another Session's next selection there; separate Session-worker processes do not share this map. Health is not persisted: restart or a new configuration generation resets it. A request already using an older generation retains its own route snapshot and cannot publish failures into a newer generation.

There is one outer attempt budget, six total attempts by default, not six retries plus an initial request and not a second loop inside a virtual provider. With the default two-target failover settings, five countable failures can cool the first target and allow the sixth attempt to use the second. A countable failure on the configured final target terminates that request and resets active route health for the next independent request. The exact health thresholds, cooldowns, and classification table belong to [model routing](../threads/model-routing.md#failover-health).

| Observation | Consequence and boundary |
| --- | --- |
| Network/stream failure, rate limit, server error, classified auth/model-not-found failure, or unusable response | Can retry and affect failover health under the routing classifier. Every attempt rebuilds the chosen leaf's protocol, credentials, payload, image preparation, and parser. |
| Ordinary invalid-request or oversized-input response | Normally terminal rather than a reason to rotate providers; model-not-found classification is a specific exception. |
| Stop/caller cancellation | Ends the request without counting as bad provider health. A progress watchdog timeout is a different, attempt-local failure. |
| Local preparation or strict owner-persistence failure | Prevents send and propagates outside provider retry/health classification. Changing provider is not a repair for unreadable local image bytes or failed context persistence. |
| Completed empty, whitespace-only, or reasoning-only response | Accepted as a normal end by default. `disallowEmptyResponse` on the concrete provider instead makes it retryable. A tool-call-only response or successful generated image is usable content. |
| Provider failure notice in Chat | Display-only diagnostic, not assistant error text fed into the next request, compaction, or embeddings. |

A progressing stream need not finish within a fixed short total duration. Watchdogs distinguish first useful progress and later inactivity; pings or arbitrary transport bytes do not necessarily count. [Request behavior](../units/src-llm.md#request-behavior) owns protocol-specific timeout and stop-reason rules. A request that failed locally after an upstream operation may have consumed provider resources; neither retry diagnostics nor persisted usage is a complete billing ledger.

## Switching takes effect at an adoption boundary

Saving settings and adopting request configuration are separate actions. Model/Node setters do not wake an idle or waiting Session and do not insert speculative switch notices. Normal authoritative attempts compare the canonical concrete model and Node actually adopted with the preceding adopted configuration, before preparing the provider-visible history. This informs the next attempt about effective changes, including automatic failover and missing-key fallback, without narrating every UI edit.

| Action while work exists | What changes |
| --- | --- |
| Select another model while an attempt is in flight | Saves the setting; it does not retarget or abort the already-dispatched attempt. A later normal request uses current selection. If the current request retries, its owner safe point can adopt an explicit changed model selection. |
| Change A → B → A without an intervening attempt | No extra effective-change notice. The adopted configuration is still A. |
| Switch alias keys that resolve to the same leaf | Raw selection/routing policy can change, but no false concrete-model switch notice is emitted. |
| Failover changes concrete leaf between attempts | The next normal attempt receives the effective-change notice before send. The remaining physical-attempt budget is unchanged. |
| Remove the Session's selected key from model configuration | On later model resolution, normal adoption reports the missing key and actual global-default fallback. This does not replace an unchanged in-flight snapshot. The same missing-key/actual-model pair does not warn on every retry or turn. |
| Change effort only, or edit model configuration without changing the captured raw selection | Does not rewrite an already-captured request snapshot. Later independent requests see the new configuration/settings. Effort-only changes do not create model-switch notices. |
| Change future-child model/effort defaults | Affects later child creation, not existing children or the current request. It does not preselect a speculative virtual leaf. |

An unknown first baseline is normally established silently; a first-use missing-key fallback still warns. The persisted baseline records adopted configuration, not confirmed transmission or a successful answer. Side requests, compact planning, and low-level requests do not write the normal-turn baseline. The exact-owner and Worker safe-point contract is [live selection](../threads/model-routing.md#d-model-routing-live-session-selection).

Normal retry preparation occurs after backoff and can ingest a finite prefix of queued input and apply ready compaction. A changed committed context starts a new logical/journal/stream identity while retaining the same remaining physical-attempt budget and cache lineage. Unchanged context retains identity. This is not an unrestricted reread of all mutable settings before every attempt; [retry input ownership](../threads/message-processing-pipeline.md#d-pipeline-retry-input-safe-point) defines the safe point.

Effort is a requested provider-neutral value, not a promise that every leaf supports it. Each concrete attempt uses that value when allowed, otherwise its own configured default. Unset means per-leaf defaulting; `none` is an explicit value. A model-only settings change preserves a compatible raw effort and clears an incompatible one atomically. Config drift can leave an old stored override readable while request-time fallback remains leaf-local. Creation/inheritance details remain in [model and effort inheritance](../threads/session-lifecycle.md#d-lifecycle-model-effort-inheritance).

## Switching preserves conversation but filters provider-sensitive history

Changing models does not clear conversation, rewrite old attribution, or remove ordinary text and tool exchanges. Request preparation uses an attempt-local clone. When a historical assistant message has a known concrete source different from the attempted destination, the clone drops model-specific reasoning/signatures, opaque provider fields, and incompatible hosted-output replay metadata while preserving ordinary content and tool order. A message containing only the removed artifacts can disappear from that payload. Canonical history remains intact.

The comparison is exact concrete identity, not provider type, virtual route, or an upstream model alias. Legacy messages with unknown identity are not assigned a guessed source. Same-leaf Chat Completions replay uses the destination's current configured reasoning field. Image preparation/replay follows the separate [attachment representations](files-images-and-attachments.md#original-image-provider-input-and-browser-preview-are-not-the-same-object). Conditional memory can also vary with the concrete destination, so a failover may change the effective system prompt as well as request serialization. See [history compatibility](../threads/model-routing.md#d-model-routing-history-reasoning-compatibility) and [conditional memory snapshots](../threads/conditional-memory-snapshots.md).

## Usage and request records describe evidence, not estimates

Successful provider-generated history carries concrete attribution, optional virtual route, and request/attempt identity. Reported usage is optional: a usable response without usage still succeeds. Reasoning tokens, when supplied by the protocol, are a component of output tokens, not another amount to add to the total. Missing usage does not mean zero; text length is not a substitute. Accounting rules are owned by [provider usage components](../threads/message-processing-pipeline.md#d-pipeline-provider-usage-components).

Responses can durably commit completed commentary before the full response finishes. A successful completion supplies the request's complete usage once rather than charging every streamed segment separately. Provisional text is not committed history merely because it appeared on screen. Grouped UI statistics retain all contributing routes and request timing evidence instead of assigning the group to the current model; [Timeline usage](../units/webui-timeline-usage-timing.md) owns presentation and incomplete attribution.

The [canonical request journal](../threads/llm-request-journal.md) records inputs before send and attempt starts/results, not raw authenticated wire traffic. A recorded attempt start can precede cancellation and does not prove dispatch. Committed commentary, retry input, compaction, or an adopted selection notice can require a new logical manifest from current history; physical retry limits still apply. Journal reconstruction of legacy requests reports missing facts rather than inventing past prompts from current settings. A post-response result-record failure must not retry an otherwise successful provider generation.

## Change entry points

- Routing/selection: [model routing](../threads/model-routing.md), `src/modelRouting.ts`, `src/llm.ts`, and `src/session/effectiveSelection.ts`.
- Saved versus active configuration: [configuration and activation](configuration-and-activation.md).
- Request journaling and recovery: [request journal](../threads/llm-request-journal.md) and [persistence and recovery](persistence-and-recovery.md).
- Regression entry points: `src/llmVirtualRouting.test.ts`, `src/sessionSelectionRetry.test.ts`, `src/sessionEffectiveSelection.test.ts`, `src/llmVirtualMessageMeta.test.ts`, and `src/llmRequestJournal.test.ts`. These cover distinct evidence boundaries, not a required blanket suite for every wording change.
