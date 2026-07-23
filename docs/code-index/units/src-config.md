# Unit: src-config

Files: src/config.ts, src/setupConfig.ts, src/setupConfig.test.ts, src/modelsConfigSchema.test.ts, src/modelsConfigPath.test.ts
Secondary files: templates/models.example.yaml, README.md

## Purpose

Owns application/model configuration types, path resolution, YAML readers/writers, provider/model expansion, and setup-form transformations. It supports selected environment path overrides for application infrastructure, but the active models file follows the data directory only. It does not migrate a `.env` file into YAML.

## Key exports

### Application configuration

- Channel, guest-agent, ASR, and `AppConfig` types.
- `readAppConfigFile`, `writeAppConfigFile`.
- `getNormalizedChannelConfigs`, `getChannelConfigById`, `getChannelConfigsByType`, `getDefaultChannelConfigByType`, `getDefaultChannelIdByType`.
- Resolved path/server/context constants and agent/session path helpers.

### Model configuration

- `ProviderConfigEntry`, `ProviderModelListItem`, `ModelConfigEntry` (including canonical concrete identity), `ModelsConfig`, and virtual routing config types/guards.
- `expandModelsConfig`, `loadModelsConfig`, `loadModelsConfigFromObject`, `resolveModelConfig`.

### Setup configuration

- `validateModelsConfigYaml`, `writeRawModelsConfig`.
- `readRawAppConfigFile`, `validateAppConfigYaml`, `writeRawAppConfig`.
- `writeAppConfigWithChannels` — replace only the top-level channels section.
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

These are selected runtime overrides, not an environment-to-YAML migration.

## Current defaults

| Setting | Default |
|---|---|
| HTTP port | `3001` |
| WebUI / trigger | enabled unless explicitly `false` |
| TUI | disabled unless configured or `--tui` is present |
| context limit | `122880` |
| recent compact keep fraction (`compactPercent`) | `0.3` |
| block eligibility / force tokens | `3000` / `5000` |
| block candidate / force-coverage fraction | `0.4` / `0.2` |
| raw required replacement fraction | `0.2` |
| max output / thinking budget | `16384` / `10000` |
| Ollama base URL | loopback port `11434` |

## Model resolution

- Preferred root is `providers`; legacy root `models` remains a reader.
- Preferred provider field is `models`; legacy `model` remains a reader.
- `providerType` is current; `provider` is a legacy reader.
- A single-model provider gets both provider-key and provider/model lookup entries; multi-model providers use provider/model keys.
- Provider defaults are applied before model-level overrides. Header overrides merge one level by key. Nested plain objects under `extraFields` merge recursively. `contextLimit` overrides directly.
- `openai`, `openai-responses`, and `openai-completions` receive OpenAI defaults; `anthropic` receives Anthropic defaults; custom types must provide their own base URL/protocol-compatible settings.
- Invalid provider objects, model lists, and cross-strategy fields fail with provider-qualified validation errors.
- `session-hash` and `failover` entries resolve strict concrete lookup keys, safe context/async-compact values, and a stable full-leaf configuration fingerprint. Their schema and semantics are canonical in [model routing](../threads/model-routing.md).

## Persistence behavior

- App YAML missing at read time yields an empty config.
- Setup writes validate by parsing through the same current config readers before replacing files.
- Structured setup accepts virtual target/failover fields; raw virtual YAML remains byte-preserving after validation.
- `writeAppConfigWithChannels` preserves surrounding raw YAML text/comments when possible.
- Template models config is a read fallback only and logs once; it is not silently copied into mutable state.
- Code's fixed workspace-root response consumes the exported `BASE_DIR` and resolved `DATA_ROOT_DIR`; it does not introduce a second data-root resolver. See [D-code-master-workspace-roots](../threads/code-integration.md#d-code-master-workspace-roots).

## Compatibility

- `CONFIG_PATH`, model-root `models`, provider `model`, and provider `provider` are documented readers. The removed app-config `paths.modelsConfigPath` and generic `MODELS_CONFIG_PATH` override are not readers.
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
