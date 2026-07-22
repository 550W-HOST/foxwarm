# Unit: WebUI editor

Files: packages/webui/src/components/SimpleCodeEditor.tsx, packages/webui/src/components/DiffPreview.tsx, packages/webui/src/yamlMonacoSupport.ts, packages/webui/src/yamlConfigSchemas.ts, packages/webui/src/modelsYamlCompletions.ts, packages/webui/src/workers/yaml.worker.ts, packages/webui/test/configEditor.test.mjs

## Purpose

Provides reusable code editing and diff visualization components for the WebUI. `SimpleCodeEditor` lazy-loads a Monaco/YAML support singleton for configuration editing, while `DiffPreview` renders side-by-side or unified diffs with syntax highlighting.

## Key exports

- `SimpleCodeEditor` — Monaco wrapper with explicit model URIs, focus requests, read-only/language/value synchronization, and advisory marker state.
- `loadYamlMonacoSupport` — lazy singleton that installs Monaco editor/YAML workers, registers static schemas, and owns current-document model completions.
- `MODELS_CONFIG_SCHEMA`, `APP_CONFIG_SCHEMA`, and their distinct in-memory model URIs.
- `parseModelsYamlSuggestions` and `createModelsYamlCompletionProvider` — derive model/target completions from unsaved YAML.
- `DiffPreview` — memoized unified/split diff visualization.

## Behavior

- Monaco, `monaco-yaml`, the generic editor worker, and the YAML language worker remain outside the initial application bundle and load on first editor use.
- The models and app-config editors use distinct stable model URIs and distinct embedded static schemas. Schema loading never calls a backend schema endpoint and remote schema requests are disabled.
- Static schemas document current fields, suggest known provider/channel values while permitting custom extensions, mark retained legacy spellings as deprecated, and intentionally allow unknown properties.
- Diagnostics, completion, and hover are advisory. Formatting is disabled so editor assistance does not rewrite configuration text, and backend validation remains the save authority.
- Models `default` completion includes concrete and virtual keys from the current unsaved document. Virtual `targets` completion includes concrete keys only. Parsing is debounced; invalid partial YAML retains the last valid local suggestions and never uploads editor text.
- `SimpleCodeEditor` preserves the latest value while its lazy imports resolve, updates marker-count test metadata, follows theme changes, and disposes the editor, model, listeners, and per-model completion state on unmount.
- `DiffPreview` computes line-level diffs and word-level refinements for adjacent remove/add pairs. Split mode synchronizes both scroll axes with a guarded handoff.

## Integration

- Setup owns the two stable YAML models and supplies a transient focus request when Chat opens model settings.
- `configEditor.test.mjs` covers static schema boundaries, custom/legacy provider-type behavior, concrete-versus-virtual suggestions, and last-valid retention. Setup browser tests exercise the real YAML worker and advisory markers.
- The former full-page WebUI file editor was removed with the custom workspace feature; Code remains the general browser editing integration.

## Design decisions

### D-editor-local-yaml-assistance

Models and app-config editing use static frontend-owned schemas and local unsaved-document completions. No backend schema API or per-keystroke document upload is introduced. Monaco diagnostics are advisory, remote schema fetches and automatic formatting stay disabled, and canonical backend validation decides whether Save succeeds.
