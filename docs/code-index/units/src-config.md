# Unit: src-config

Files: src/config.ts, src/configInstaller.ts, src/configFile.ts, src/configInstaller.test.ts, src/configHotApply.test.ts, src/configSectionSaves.test.ts, src/tools/configTools.ts, src/publicUrl.test.ts, src/compactionConfig.test.ts, src/setupConfig.ts, src/setupConfig.test.ts, src/modelsConfigSchema.test.ts, src/modelsConfigPath.test.ts, src/workerConfig.test.ts, src/imageGenerationConfig.test.ts
Secondary files: packages/shared/src/configSchemas.ts, templates/models.example.yaml, README.md, docs/virtual-models.md, docs/vector-memory.md, docs/executable-node-provider-protocol.md, docs/docker-worktree-node-provider.md

## Purpose

Owns application/model configuration types, path resolution, YAML readers/writers, provider/model expansion, and setup-form transformations. It supports selected environment path overrides for application infrastructure, but the active models file follows the data directory only. It does not migrate a `.env` file into YAML.

## Key exports

### Application configuration

- Channel (including `QQBotConfig`, the safe inline-image threshold and bounded
  QQ generic-file media limits), guest-agent,
  ASR, and `AppConfig` types.
- `readAppConfigFile`, `writeAppConfigFile`.
- `normalizePublicUrl`, `PUBLIC_BASE_URL` — optional top-level public HTTP(S) URL for Node bootstrap examples; no effect on HTTP bind or internal API origin.
- `safeAppConfigYamlError()` — converts an app-config YAML parse failure to a non-secret error with its 1-based line/column when available; Setup uses the same formatter.
- `ACCESS_CONFIG`, `ACCESS_RUNTIME`, `normalizeAccessConfig`, and `authenticateAccessBearer` / `authenticateAccessToken` — validated shared WebUI and inbound MCP identities with a Main-owned live snapshot, explicit surface declarations, and verified principal creation; the validator is shared with Setup. The implementation is owned by [src-access-config](./src-access-config.md).
- `ExecutableNodeProviderConfig`, `DockerWorktreeNodeProviderConfig`, normalized provider unions, `normalizeNodeProvidersConfig`, and `NODE_PROVIDERS_CONFIG` — strict startup definitions for trusted one-shot executable providers and resident Docker worktree providers.
- `normalizeCompactionConfig`, `COMPACT_KEEP_PERCENT`, and `COMPACT_THRESHOLD_PERCENT` — finite `(0, 1]` keep/trigger fractions with current defaults and the narrow legacy keep-key fallback.
- `normalizeProviderImageOutputFormat`, `PROVIDER_IMAGE_OUTPUT_FORMAT` — optimized provider-request output defaults to WebP; optional `llm.providerImageOutputFormat: jpeg` emits PNG when pixels are transparent.
- `getNormalizedChannelConfigs`, `getChannelConfigById`, `getChannelConfigsByType`, `getDefaultChannelConfigByType`, `getDefaultChannelIdByType`.
- Resolved path/server/context constants and agent/session path helpers.

### Model configuration

- `ProviderConfigEntry`, `ProviderConfigValue`, `ProviderModelListItem`, `ModelConfigEntry` (including canonical concrete identity, first-class model effort capabilities/default, and optional OpenAI Responses `webSearch` and hosted `imageGeneration` settings), `ModelsConfig`, and virtual routing config types/guards. A raw provider value may also be a non-empty string alias; raw `webSearch` and `imageGeneration` provider/model values accept a boolean or an options object, and resolved concrete entries contain normalized effort, web-search, and image-generation forms.
- `MODEL_EFFORTS`, `ModelEffort`, `DEFAULT_MODEL_EFFORT`, `normalizeModelEffortConfig`, and `getConcreteModelEffortConfig`.
- `expandModelsConfig`, `loadModelsConfig`, `loadModelsConfigFromObject`, `resolveModelConfig`.

### Setup configuration

- `configInstaller.install(target, candidate, authorize?)` — serialized Main-owned installation for Setup and `set_config`; reports saved, applied, not-applied, and restart-required settings.
- `replaceConfigFile` — same-directory mode-0600 temporary write, sync, and atomic replacement shared by all three configuration targets.
- `validateModelsConfigYaml`, `writeRawModelsConfig`.
- `readRawAppConfigFile`, `validateAppConfigYaml`, `writeRawAppConfig`.
- `buildAppConfigWithChannelsYaml` / `writeAppConfigWithChannels` — replace only the top-level channels section without redumping the surrounding text.
- `buildModelsConfigFromSetupForm` — preserve provider overrides while updating model lists/default.
- `dumpSetupYaml`, raw-text helpers, and provider setup draft type.

## Path resolution

- Program root: `BASE_DIR`.
- Data root precedence: `FOXWARM_DATA_DIR`, then the checkout's `data_dir` pointer file, then `BASE_DIR`.
- App config path: `FOXWARM_CONFIG_PATH` or compatibility `CONFIG_PATH`, otherwise `<data-root>/state/config.yaml`.
- Models path: always `<data-root>/state/models.yaml`. Neither app config nor the generic `MODELS_CONFIG_PATH` environment variable overrides it. When the active file is absent, the packaged template is a read-only runtime fallback.
- MCP path: `MCP_CONFIG_PATH`, then `paths.mcpConfigPath`, then `<state>/mcp.json`.
- Agent, skill, and MCP paths may also be selected through their documented app-config fields.
- The archive moved-ID reservation ledger is explicit durable state at `<data-root>/state/session-id-reservations.jsonl`.
- The temporary crash-recovery journal for one in-progress identity move is `<data-root>/state/session-id-move-pending.json`.
- When `sessionWorkers` is enabled, ownership/mailbox coordination uses `<data-root>/state/session-runtime.sqlite`; full semantic session state remains in the authoritative per-session JSON files under `<data-root>/state/sessions/`. Default-disabled startup does not open the Session-worker runtime database, independently of `dbWorkers` placement.

Worker placement is startup configuration:

- `vector` is a connection/feature object, not a general boolean shorthand. Omission or `false` disables Vector; an object opts in unless `enabled:false`. Enabled Vector requires a nonempty absolute HTTP(S) `baseUrl` without credentials, query, or fragment components that already includes its OpenAI-compatible API root; runtime appends only `/embeddings`. `vector.lexicalIndex` is a narrow startup boolean and defaults false. `vector.hybridSearch` also defaults false and normalizes false unless Vector and lexical indexing are both enabled.
- `sessionWorkers` is experimental and accepts a boolean or object. Omission/`false` keeps the default in-process session runtime. `true` enables default worker settings. An object enables workers unless `enabled:false`; `idleSeconds` defaults to 60 and accepts numeric YAML integers from 1 through 86,400 (boolean and string coercion is rejected).
- `dbWorkers` is boolean, defaults to `true`, and currently moves only an enabled LanceDB/vector owner into a child process. It has no effect while Vector is disabled.
- `handoffConfirmation` is a top-level startup boolean, defaults to `false`, and controls only the structured `handoffRecall` / `handoffConfirmation` review for `send_to_session` / `create_child_session`; cancellation controls are independent. Changing it requires restart.
- `access.identities` is a strict shared identity map that supported configuration saves hot-apply. Each identity declares a token and one or both of `surfaces.webui.sessions` and `surfaces.mcp: {}`. A configured `mcp` surface enables authentication at `/mcp` on an existing Main HTTP listener; a configured `webui` surface grants only the listed Session chat/history/live/upload scope. The instance token remains a WebUI/HTTP superuser token and does not imply MCP access. See [src-access-config](./src-access-config.md) and [D-mcp-inbound-http-transport](./src-mcp-inbound-http.md#d-mcp-inbound-http-transport).
- `vectorMaintenance` accepts `false`, `true`, or an options object; the normalized default is enabled with positive-integer `retentionHours` defaulting to `24`. Its exact-owner execution contract is canonical in [D-vector-owner-maintenance](src-vector.md#d-vector-owner-maintenance).
- Worker placement changes require a process restart. Managed channel hot reload does not change process topology.
- `nodeProviders` is a startup-only map keyed by bounded provider ID. `type: executable` accepts a fixed command/arguments and bounded request timeout. `type: docker-worktree` accepts a fixed Docker launcher/image, canonical allowed roots, allowed network modes, optional state location, and bounded resource defaults. Both variants reject unknown fields and require restart.
- Disabling/draining Session workers does not erase durable Worker lineage. Current-code `sessionWorkers:false` remains supported; after a nonzero cursor, pre-Session-worker code is unsupported as a writer and no lineage-retirement tooling is required. See [D-process-topology-session-worker-downgrade](../threads/process-topology-and-rpc.md#d-process-topology-session-worker-downgrade).

These are selected runtime overrides, not an environment-to-YAML migration.

## Current defaults

| Setting | Default |
|---|---|
| HTTP port | `3001` |
| WebUI / trigger | enabled unless explicitly `false` |
| TUI | disabled unless configured or `--tui` is present |
| context limit | `122880` |
| recent compact keep fraction (`compactKeepPercent`) | `0.3` |
| automatic compact threshold fraction (`compactThresholdPercent`) | `0.85` |
| block eligibility / force tokens | `3000` / `5000` |
| block candidate / force-coverage fraction | `0.4` / `0.2` |
| raw required replacement fraction | `0.2` |
| max output | `32768` |
| model effort | all six levels allowed / `high` default |
| Vector / API base URL | disabled / none |
| Dark Vector lexical indexing lane | disabled |
| Persistent lexical+dense hybrid reads | disabled |
| Session workers / idle release | disabled / `60` seconds |
| Vector database worker | enabled |
| Inter-agent handoff confirmation | disabled |
| Vector maintenance / version retention | enabled / `24` hours |
| Node providers / executable request timeout | none / `90` seconds |

## Model resolution

- Preferred root is `providers`; legacy root `models` remains a reader.
- Preferred provider field is `models`; legacy `model` remains a reader.
- `providerType` is current; `provider` is a legacy reader.
- A single-model provider gets both provider-key and provider/model lookup entries; multi-model providers use provider/model keys.
- Provider defaults are applied before model-level overrides. Header overrides merge one level by key. Nested plain objects under `extraFields` merge recursively. `contextLimit` overrides directly, `webSearch` and `imageGeneration` settings merge from provider to concrete model override, and Chat Completions `historyReasoningField` inherits or overrides as one normalized enum. Each `imageGeneration` side is normalized before merging, and the merged configuration is checked again for field combinations that only become contradictory through inheritance, so a provider background and a model output format cannot combine into an unsupported request.
- Provider-scoped `disallowEmptyResponse` inherits from the provider entry to each concrete model entry, is rejected on virtual entries, participates in the route fingerprint, and controls whether empty/reasoning-only completions are retryable failures.
- `keepReasoningOnError` is a strict provider/concrete-model boolean with model override and effective default `false`. It is rejected on virtual providers, preserved through concrete Setup forms and raw YAML/schema editing, and included in virtual leaf fingerprints. Only normal Responses streams consume it; see [D-streaming-keep-reasoning-on-error](../threads/streaming-pipeline.md#d-streaming-keep-reasoning-on-error).
- First-class `effort` uses `{ allowed, default }`. Omission allows `none`, `low`, `medium`, `high`, `xhigh`, and `max` with `high` as the default. A model-level `allowed` list replaces the provider list; omitted model fields inherit provider values, and the resulting default must be allowed. Virtual entries cannot configure effort directly and expose the canonical union of reachable concrete levels.
- `openai`, `openai-responses`, `openai-ws`, and `openai-completions` receive OpenAI defaults; `anthropic` receives Anthropic defaults; custom types must provide their own base URL/protocol-compatible settings. `openai-ws` rejects request compression because compression is an HTTP-body setting.
- Invalid provider objects, model lists, and cross-strategy fields fail with provider-qualified validation errors.
- A non-empty provider string is normalized at expansion to one `session-hash` target and then follows the canonical leaf-only virtual routing contract; it is not retained as a separate runtime alias type.
- `session-hash` and `failover` entries resolve strict concrete lookup keys, safe context/async-compact values, and a stable full-leaf configuration fingerprint. Their schema and semantics are canonical in [model routing](../threads/model-routing.md).

## Persistence behavior

- App YAML missing at read time yields an empty config.
- App config validation normalizes both executable and Docker worktree Node providers through the same runtime/setup path; launcher/image/roots/resources remain trusted host configuration and are never model-facing mutation fields.
- Runtime startup and Setup validate `url` as an absolute HTTP(S) address without credentials, query, or fragment, trim outer whitespace/trailing slash, and preserve an optional deployment path. Missing `url` retains placeholder-based Node instructions. Shared JSON schema exposes the field to config editors.
- Setup and `set_config` validate through the same current config readers and preserve submitted bytes with atomic replacement. See [D-config-live-install](#d-config-live-install).
- Structured setup accepts virtual target/failover fields; Models Setup remains a raw-YAML surface for string aliases, and raw virtual/alias YAML remains byte-preserving after validation. When retained structured setup changes a concrete provider into a virtual entry, provider-only fields including `effort`, `webSearch`, and `imageGeneration` are removed before the result is reparsed.
- `writeAppConfigWithChannels` preserves surrounding raw YAML text/comments when possible.
- Template models config is a read fallback only and logs once; it is not silently copied into mutable state.
- Code's fixed workspace-root response consumes exported `BASE_DIR`, resolved `DATA_ROOT_DIR`, `APP_CONFIG_PATH`, and `DEFAULT_MODELS_CONFIG_PATH`; it does not introduce a second path resolver. See [D-code-master-workspace-roots](../threads/code-integration.md#d-code-master-workspace-roots) and [D-code-config-schema-assistance](../threads/code-integration.md#d-code-config-schema-assistance).

## Compatibility

- `CONFIG_PATH`, model-root `models`, provider `model`, provider `provider`, legacy `llm.ollamaBaseUrl`, and legacy `llm.compactPercent` are documented readers. Legacy `compactPercent` supplies the compact keep fraction only when current `llm.compactKeepPercent` is absent; current configuration and schemas expose only `compactKeepPercent`. Legacy Ollama roots normalize to a Vector API root ending in `/v1` only when top-level `vector` is absent. The removed app-config `paths.modelsConfigPath` and generic `MODELS_CONFIG_PATH` override are not readers.
- Pre-Session-worker code may read and rewrite a never-enabled/cursor-0 Session, after which the current legacy reader restores cursor `0`. A nonzero Worker lineage is not backward-compatible with old saves because they remove the authoritative JSON cursor while SQLite retains its acknowledgement; current code deliberately fails that SQLite-ahead condition closed.
- `TRIGGER_PORT`, `WEBUI_PORT`, and `WORKSPACE_DIR` remain exported compatibility aliases.
- New writes use current YAML shapes; no `.env` migration contract exists.

## Design decisions

### D-config-one-resolution-path

Server, setup, and one-shot model CLI use the same config/path/model resolution code. A UI or CLI writer validates through current readers instead of maintaining a second schema.

### D-config-selected-env-overrides

Environment support is limited to explicit path/data-root overrides. It does not imply general `.env` import or automatic migration into YAML.

### D-config-read-old-write-current

Persisted external configuration keeps narrow legacy readers while generated setup output uses current `providers`/`models` fields.

### D-config-models-data-path

The mutable models configuration has one active location: `<data-root>/state/models.yaml`. Runtime reads, Setup diagnostics/OOBE, raw and structured Setup writes, and normal model resolution all use that path. The packaged example may be read only when the active file is missing; it is never the write target. The former `paths.modelsConfigPath` and generic `MODELS_CONFIG_PATH` override remain removed rather than becoming compatibility readers.

### D-config-feature-toggle-shorthand

[2026-08-11] User-approved feature toggles with explicitly designated tuning fields may accept `true`, `false`, or an options object. `true` enables the feature with defaults, `false` disables it, and an object opts in unless it explicitly sets `enabled:false`; normalizers run before inheritance, merge, or runtime use. Model-level `webSearch` and `imageGeneration` booleans override only the inherited enabled state while retaining inherited tuning, and an object without `enabled` opts in while merging its tuning. This shorthand is not generalized to connection or credential objects.

[2026-09-19] Hosted image generation is a normalized provider/model toggle with `model`, `action`, `size`, `quality`, `background`, `output_format`, and `output_compression` tuning. Validation rejects unknown enum values, a non-integer or out-of-range compression, an empty model string, and the contradictory `output_format: jpeg` with `background: transparent` combination. Each side is normalized on its own and the merged configuration is validated again, so a combination that only becomes contradictory through provider-to-model inheritance fails resolution instead of sending an unsupported request, while a legitimate model override that resolves the combination still wins. The normalized form participates in concrete and virtual routing fingerprints and is rejected on virtual provider entries, while the raw value stays byte-preserving for Models Setup. The runtime rejects an effective enabled config on a protocol that cannot carry the hosted tool.

`vector` therefore deliberately does not accept `true`: it is a connection object requiring `baseUrl`, with only `false` as the disable shorthand.

### D-config-default-max-output

[2026-08-18] `llm.maxOutput` remains the single application-level provider output-token override and defaults to `32768` when omitted. The default applies as `max_output_tokens` for OpenAI Responses requests and `max_tokens` for OpenAI Chat Completions and Anthropic-compatible requests; provider/model `extraFields` retain their existing later override position.

### D-config-provider-image-output

[2026-09-19] `llm.providerImageOutputFormat` is one optional application-level provider-request image output setting: `webp` by default, or `jpeg` for opaque images with PNG selected on actual transparency. JPEG mode converts incoming WebP even below size/dimension thresholds so an endpoint lacking WebP support never receives it as ordinary vision input. It does not change hosted image-generation tool settings, original canonical blobs, provider/model inheritance, or the fixed optimization thresholds. The selected format participates in the derived-cache policy key.

### D-config-chat-history-reasoning-field

[2026-08-31] A concrete `openai-completions` provider may select `historyReasoningField: reasoning_content | reasoning`, with omission defaulting to `reasoning_content`; a model object may override the provider value. Other concrete protocols reject the field and virtual providers forbid it. The resolved concrete value participates directly in route fingerprints so a request always serializes from its current destination configuration rather than persisted per-message field-name metadata.

### D-config-handoff-confirmation

[2026-09-04] Top-level `handoffConfirmation` accepts only a boolean and defaults to `false`. It is resolved once at startup and requires restart to change. `true` enables the exact inter-agent `handoffRecall` / `handoffConfirmation` contract and its schema/reminder guidance; omission or `false` disables only that review requirement. Model tool-call cancellation controls remain enabled in both modes.

### D-config-live-install

[2026-10-10] WebUI Setup and the hidden discoverable Main-management `set_config({ target, filePath })` share the serialized Main-owned configuration installer. Targets are `config`, `models`, and `tool-rules`; the tool reads one complete master-side regular-file candidate under the current setter and `node:master/read` permissions, then repeats those permissions at installation admission. Invalid candidates do not change files or live snapshots. All targets use a synced same-directory temporary file and atomic replacement, preserving raw bytes rather than parsing and redumping them. Section-only Channels, Weixin login, and structured Models edits run their complete read/merge/build inside the same installation queue, after prior saves finish applying. Structured Models updates retain providers not named in the submitted form. The queued merge preserves the latest unrelated app settings, channels, providers, and custom fields; raw full-document saves retain complete replacement semantics. Structured Models compatibility generates YAML and uses this same validation/install path. Policy limits remain policy-specific; there is no new app/models limit borrowed from tool rules.

App saves publish `access.identities` and reload managed channels. Models continue to resolve from the active file on later requests, and the current Setup page retains its existing picker refresh. Other app fields remain startup-owned: results compare them against startup configuration and continue to report pending restart settings across repeated saves. If Main has no HTTP listener, enabling an MCP identity is saved but reported as requiring restart. No file watcher, new service orchestrator, or cross-window model-cache synchronization is introduced.

Real Setup HTTP regressions hold a local Weixin getupdates response during actual managed-channel stop, then queue Config/Channels, raw/structured Models, and QR-login channel saves. They verify the later section edit retains the preceding save's token, URL, raw surrounding text, unrelated channels/providers, and extension fields without changing queue internals.

The result distinguishes `saved`, `applied`, `notApplied`, and `restartRequired`. Access snapshot publication and affected-transport fencing happen before asynchronous cleanup; connection cleanup or managed-channel failures after replacement are reported as saved with incomplete application, not as a successful rollback. Tool output does not echo YAML or secret-bearing validation details. Setup retains its administrator-only response fields and uses concise save/restart feedback.

## Canonical ownership

Worker placement defaults and local/child parity are canonical in [process topology and RPC](../threads/process-topology-and-rpc.md#design-decisions).
