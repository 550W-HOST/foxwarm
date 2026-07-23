# Unit: WebUI Setup view

Files: packages/webui/src/components/SetupView.tsx, packages/webui/src/setupModels.ts, packages/webui/test/setupModels.test.mjs, packages/webui/test/setupModels.e2e.mjs
Secondary files: packages/webui/package.json, packages/webui/src/yamlConfigSchemas.ts, packages/webui/src/components/SimpleCodeEditor.tsx

## Purpose

Authenticated setup/configuration UI for first-run model configuration and later model/channel updates. Models are presented only as raw YAML; the view also edits full app-config YAML, reloads managed channels after config save, and supports Weixin QR login. Structured model helpers remain for generated OOBE text, tests, and the retained backend request contract, not as a visible graphical editor.

## Export

- default `SetupView({ forced?, onClose?, onSetupChanged?, focusModelsRequest? })`.

## API contract

All requests append to `API_BASE_PATH` and use normal authenticated WebUI routes:

| Method/path | Use |
|---|---|
| `GET /setup/status` | OOBE flag, model diagnostics/raw YAML, full app-config YAML, and channel runtime status |
| `POST /setup/models` | Validate and save raw models YAML byte-for-byte |
| `POST /setup/config` | Validate/write full app config and call `reloadManagedChannels` |
| `POST /setup/weixin/login/start` | Start or replace a QR login session |
| `POST /setup/weixin/login/wait` | Check one login session; on success update channel config and reload |

The server retains structured `/setup/models` request handling and `/setup/models/test` compatibility for non-UI callers, but this view does not expose the former provider-card form or transient test controls.

## Behavior

- Models always render as a raw YAML editor. If the active file is missing or empty, Setup initializes editable text from a generated current-shape example rather than turning the packaged template into a write target.
- Raw model and app-config saves preserve user text after canonical backend validation. Comments, key order, quoting, custom fields, and formatting survive.
- The two editors use distinct model URIs and static frontend schemas. Suggestions/markers are advisory and never disable Save; canonical behavior is [D-editor-local-yaml-assistance](./webui-editor.md#d-editor-local-yaml-assistance).
- Both YAML editor wrappers use the exact responsive height `calc(min(600px, 80vh))`; the same wrapper height applies to Monaco and the plain-text fallback without widening the mobile layout.
- Model suggestions are derived from current unsaved YAML: defaults include concrete and virtual keys, while virtual targets include concrete keys only.
- App-config save reloads every managed channel and reports started results.
- Weixin start renders image/base64/pairing payloads; wait persists connected token/user/channel fields server-side.
- Forced mode is closable only after the active models file exists. WebUI itself makes the channel-availability check non-blocking.
- A positive `focusModelsRequest` scrolls to the Models section and focuses its Monaco editor.
- If lazy editor support loading or configuration rejects, the Models and app-config surfaces remain controlled plain-text editors, so OOBE can still be completed and canonical backend validation still owns Save. Internal worker health is not probed after initialization; Monaco remains editable if schema assistance later degrades.

## Integration

- Normal App owns singleton `system:setup`; a missing active models file forces this tab and rejects close.
- The active file is the data-directory models path; diagnostics and writes do not follow the removed generic override. Canonical path contract: [D-config-models-data-path](./src-config.md#d-config-models-data-path).
- Chat's model popup opens/activates this singleton and requests Models focus through App.
- Code's Setup custom editor mounts the same non-forced leaf view, accepts only the nonce-bound fixed Models-focus signal, and lets the extension own close/restore identity.
- `onSetupChanged` lets App refresh setup/OOBE status after successful model/config/login changes.

## Function index

- `SetupView` — loads status and renders checklist, raw models/config editors, channel status, and Weixin controls.
- `loadStatus` — refreshes diagnostics and hydrates raw editor text.
- `saveModels` / `saveConfig` — send raw YAML to backend-authoritative validators/writers.
- `startWeixinLogin` / `waitWeixinLogin` — manage pairing and persisted channel setup.
- `buildModelsYaml` / `makeDefaultProvider` in `setupModels.ts` — retained pure helpers used to generate initial raw YAML and verify the structured backend contract.

## Design decisions

### D-setup-raw-preservation

Raw models/app configuration is validated then written without parse-and-redump so comments, key order, quoting, and unknown fields survive.

### D-setup-model-oobe

OOBE is the absence of the active data-directory models configuration. The forced Setup tab remains until the server status clears that condition.

### D-setup-models-raw-only

The visible Models workflow is raw YAML only. Keep structured request parsing/helpers as a backend compatibility boundary, but do not expose the former graphical provider form or provider-test controls in Setup.

### D-setup-editor-height

The Models YAML and app-config YAML areas both use the exact CSS height `calc(min(600px, 80vh))`. Keep that contract for desktop, mobile, and the controlled plain-text fallback.

## Canonical ownership

Saving app/channel configuration invokes the canonical full managed-channel restart behavior: [D-channel-managed-reload](../modules/channels.md#d-channel-managed-reload).
