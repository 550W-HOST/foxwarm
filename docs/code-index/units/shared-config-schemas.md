# Unit: Shared config schemas

Files: packages/shared/src/configSchemas.ts
Secondary files: packages/shared/src/index.ts, packages/shared/package.json, packages/webui/src/yamlConfigSchemas.ts, packages/vscode-web/foxwarm-fs/src/configSchemas.ts

## Purpose

Owns pure, public-safe Draft-07 schema objects for Foxwarm Models and App configuration so build-time browser consumers reuse one definition without exposing runtime configuration data. The application schema includes optional Vector connection/enablement, startup-only session/vector worker placement, trusted executable and Docker-worktree Node-provider definitions, the bounded session-worker idle setting, and the vector-maintenance boolean/object toggle.

## Key exports

- `MODELS_CONFIG_SCHEMA` — advisory models/provider/virtual-routing structure aligned with tolerant backend readers, including non-whitespace provider string aliases, provider/model `{ allowed, default }` effort configuration, and the Chat Completions-only `historyReasoningField` enum.
- `APP_CONFIG_SCHEMA` — advisory worker placement, trusted executable and Docker-worktree Node providers, bot, LLM (including `compactKeepPercent`, `compactThresholdPercent`, and the `32768` `maxOutput` default), paths, type-aware channels (the five managed types including `qqbot`), and ASR structure.
- `KNOWN_PROVIDER_TYPES` — known concrete protocol and virtual-routing values while custom provider types remain permitted.

The package exports these through `@foxwarm/shared/configSchemas`; browser bundles may consume the same source directly at build time.

## Behavior

- Objects contain descriptions, types, current and retained legacy spellings where intentionally exposed, and permissive unknown-property behavior; they contain no configuration values or credentials. Concrete model/provider entries document first-class effort capabilities/default and optional OpenAI Responses `webSearch` and hosted `imageGeneration` boolean/object settings while virtual routing entries reject provider request settings. The app schema exposes the current compaction keep and threshold percentages but not legacy `compactPercent`; it also documents `vector:false` or an object with `enabled`/absolute API-root `baseUrl` plus default-off `lexicalIndex` and `hybridSearch` booleans, the default-false restart-required `handoffConfirmation` boolean, marks `llm.ollamaBaseUrl` legacy, retains the explicit boolean/object form for `vectorMaintenance`, and defines strict executable plus Docker-worktree Node-provider variants with bounded trusted fields. The removed `llm.thinkingBudget` key is no longer suggested. The general shorthand contract is [D-config-feature-toggle-shorthand](./src-config.md#d-config-feature-toggle-shorthand).
- Models `default` remains optional, each provider value accepts either the normal object form or a non-whitespace single-target alias string, virtual strategy conditions honor current `providerType` precedence and legacy `provider`, and backend-tolerant headers remain permissive.
- Channel entries keep common properties at the base and add only the current managed type's platform properties through permissive Draft-07 conditions. The explicit trimmed `type` wins; a missing or whitespace-only type on a canonical `telegram`, `matrix`, `wework`, `weixin`, or `qqbot` key uses the same key fallback as runtime normalization. Missing/unknown custom types and existing foreign fields remain editable because entry objects still allow additional properties; these branches guide completion and applicable value diagnostics rather than making the object union strict.
- No schema endpoint, remote reference, file association, editor model URI, or dynamic completion logic lives here.
- WebUI owns its in-memory URI/file-match wrappers and unsaved-document completion provider. Code's filesystem extension owns exact authoritative master-URI association and supplies serialized local content to Red Hat YAML.

## Tests and integration

- WebUI config-editor tests assert shared-import parity and validate representative current, legacy, custom, and backend-tolerant fixtures with Ajv, including exact executable and Docker-worktree Node-provider variant constraints.
- WebUI config-editor tests keep managed channel branches in parity with backend adapters while retaining custom string types. The real Monaco/YAML-worker browser test proves two differently typed instances do not mix platform-property suggestions, explicit type overrides the map key, canonical missing/empty-type fallback works, and unknown types retain common/custom editing.
- The Code filesystem extension tests exact positive/negative URI association and bundled schema content, including provider string-alias support and both Node-provider variants; optional official Code E2E proves diagnostics/completion without external schema fetches.
- Canonical cross-module behavior: [D-code-config-schema-assistance](../threads/code-integration.md#d-code-config-schema-assistance).
