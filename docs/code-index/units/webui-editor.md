# Unit: WebUI editor

Files: packages/webui/src/components/SimpleCodeEditor.tsx, packages/webui/src/components/DiffPreview.tsx, packages/webui/src/yamlMonacoSupport.ts, packages/webui/src/yamlConfigSchemas.ts, packages/webui/src/modelsYamlCompletions.ts, packages/webui/src/workers/yaml.worker.ts, packages/webui/test/configEditor.test.mjs
Secondary files: packages/shared/src/configSchemas.ts

## Purpose

Provides reusable code editing and diff visualization components for the WebUI. `SimpleCodeEditor` lazy-loads a Monaco/YAML support singleton for configuration editing, while `DiffPreview` renders side-by-side or unified diffs with syntax highlighting.

## Key exports

- `SimpleCodeEditor` — Monaco wrapper with explicit model URIs, focus requests, read-only/language/value synchronization, and advisory marker state.
- `loadYamlMonacoSupport` — lazy singleton that installs Monaco editor/YAML workers, registers static schemas, and owns current-document model completions.
- Shared `MODELS_CONFIG_SCHEMA` / `APP_CONFIG_SCHEMA` objects plus WebUI-local distinct in-memory model URIs and file-match wrappers.
- `parseModelsYamlSuggestions` and `createModelsYamlCompletionProvider` — derive model/target completions from unsaved YAML.
- `DiffPreview` — memoized unified/split diff visualization.

## Behavior

- Monaco, `monaco-yaml`, the generic editor worker, and the YAML language worker remain outside the initial application bundle and load on first editor use.
- The models and app-config editors use distinct stable model URIs and shared static schema objects; only model URI/file-match wrappers remain WebUI-local. Schema loading never calls a backend schema endpoint and remote schema requests are disabled.
- Static schemas document current fields, suggest known provider/channel values while permitting custom extensions, mark retained legacy spellings as deprecated, and intentionally allow unknown properties.
- Diagnostics, completion, and hover are advisory. Formatting is disabled so editor assistance does not rewrite configuration text, and backend validation remains the save authority.
- The models root `default` is optional like the backend loader. Virtual conditionals honor current `providerType` precedence and apply the same target/forbidden-field diagnostics when only legacy `provider` selects a strategy. `extraHeaders` values remain backend-tolerant.
- Models `default` completion includes concrete and virtual keys from the current unsaved document. Virtual `targets` completion includes concrete keys only. Background parsing is debounced; an explicit completion request reads the current valid document immediately, while invalid partial YAML retains the last valid local suggestions and never uploads editor text. YAML completion words include ordinary scalar punctuation such as dots, hyphens, and slashes, so accepting either schema-driven or local suggestions replaces the current scalar token instead of appending to it.
- `SimpleCodeEditor` preserves the latest value while its lazy imports resolve, updates marker-count test metadata, follows theme changes, and disposes the editor, model, listeners, and per-model completion state on unmount. Parent-driven value replacement applies the new text and Monaco's complete selections as one editor operation, retaining each anchor/active direction. On Monaco's textarea input path, a non-composing text input is routed through Monaco's normal type command when the visible RTL selection is non-empty but the native textarea selection is incorrectly collapsed, so the first key replaces the visible selection.
- A rejection while lazy Monaco/YAML modules load or while YAML support is configured degrades to a controlled plain-text textarea with a concise product-facing notice. Editing, read-only state, focus requests, and backend Save remain available; the rejected singleton promise is cleared so a later mount can retry. There is intentionally no hidden readiness probe or worker-restart protocol after initialization: if a worker later fails internally, Monaco stays editable, schema intelligence may degrade, and the user can reload while backend validation remains authoritative.
- `monaco-editor` is pinned to `0.54.0`: the real-worker marker E2E fails on `0.55.1` because `monaco-yaml@5.5.1` / `monaco-worker-manager@2.0.1` does not initialize its YAML foreign worker under that changed worker protocol, falling back to a generic worker without `doValidation`. The package-version contract test prevents an unexplained upgrade; the browser E2E proves the actual YAML worker.
- `DiffPreview` computes line-level diffs and word-level refinements for adjacent remove/add pairs. Split mode synchronizes both scroll axes with a guarded handoff.

## Integration

- Setup owns the two stable YAML models and supplies a transient focus request when Chat opens model settings.
- `configEditor.test.mjs` validates shared-import parity, current/legacy/custom/backend-tolerant fixtures with Ajv, schema boundaries, suggestions, last-valid retention, the Setup height contract, and the worker-compatible Monaco pin. Setup browser tests exercise production schema/completion behavior, forward and reverse selection replacement in both editors (including parent-driven value reset), and the savable controlled-textarea fallback.
- The former full-page WebUI file editor was removed with the custom workspace feature; Code remains the general browser editing integration.

## Design decisions

### D-editor-local-yaml-assistance

Models and app-config editing use static frontend-owned schemas and local unsaved-document completions. No backend schema API or per-keystroke document upload is introduced. Monaco diagnostics are advisory, remote schema fetches and automatic formatting stay disabled, and canonical backend validation decides whether Save succeeds.

Completion acceptance replaces the current YAML scalar token, including punctuated model/provider prefixes such as `gpt-5.6` or `openai-`; it must not append the full suggestion after that prefix.

### D-editor-controlled-selection

Controlled parent value updates must preserve Monaco's complete selection state, including reverse anchor/active direction, and update text plus selection atomically. Monaco's textarea input path can still expose a collapsed native selection behind a non-empty visible RTL selection; detect that concrete mismatch at text input and route the insertion through Monaco's normal type command rather than consuming the first key. Do not reduce a selection to its active cursor during synchronization: the first subsequent typed key must replace forward, right-to-left, and bottom-to-top selections consistently in both Models and Config. The plain-text fallback retains native controlled-textarea behavior.
