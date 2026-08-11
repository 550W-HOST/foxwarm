# Unit: Shared config schemas

Files: packages/shared/src/configSchemas.ts
Secondary files: packages/shared/src/index.ts, packages/shared/package.json, packages/webui/src/yamlConfigSchemas.ts, packages/vscode-web/foxwarm-fs/src/configSchemas.ts

## Purpose

Owns pure, public-safe Draft-07 schema objects for Foxwarm Models and App configuration so build-time browser consumers reuse one definition without exposing runtime configuration data. The application schema includes startup-only session/vector worker placement, the bounded session-worker idle setting, and the vector-maintenance boolean/object toggle.

## Key exports

- `MODELS_CONFIG_SCHEMA` — advisory models/provider/virtual-routing structure aligned with tolerant backend readers.
- `APP_CONFIG_SCHEMA` — advisory worker placement, bot, LLM, paths, channels (the five managed types including `qqbot`, plus QQ credential and bounded inbound-media limit key suggestions), and ASR structure.
- `KNOWN_PROVIDER_TYPES` — known concrete protocol and virtual-routing values while custom provider types remain permitted.

The package exports these through `@foxwarm/shared/configSchemas`; browser bundles may consume the same source directly at build time.

## Behavior

- Objects contain descriptions, types, current and retained legacy spellings, and permissive unknown-property behavior; they contain no configuration values or credentials. Concrete model/provider entries document optional OpenAI Responses `webSearch` boolean/object settings while virtual routing entries reject provider request settings. The app schema documents the same explicit boolean/object form for `vectorMaintenance`; the general shorthand contract is [D-config-feature-toggle-shorthand](./src-config.md#d-config-feature-toggle-shorthand).
- Models `default` remains optional, virtual strategy conditions honor current `providerType` precedence and legacy `provider`, and backend-tolerant headers remain permissive.
- No schema endpoint, remote reference, file association, editor model URI, or dynamic completion logic lives here.
- WebUI owns its in-memory URI/file-match wrappers and unsaved-document completion provider. Code's filesystem extension owns exact authoritative master-URI association and supplies serialized local content to Red Hat YAML.

## Tests and integration

- WebUI config-editor tests assert shared-import parity and validate representative current, legacy, custom, and backend-tolerant fixtures with Ajv.
- WebUI config-editor tests keep the managed channel type completion list in
  parity with backend adapters while retaining custom string types and QQ
  credential/inbound-media key suggestions.
- The Code filesystem extension tests exact positive/negative URI association and bundled schema content; optional official Code E2E proves diagnostics/completion without external schema fetches.
- Canonical cross-module behavior: [D-code-config-schema-assistance](../threads/code-integration.md#d-code-config-schema-assistance).
