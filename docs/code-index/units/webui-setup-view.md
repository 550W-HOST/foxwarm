# Unit: WebUI Setup view

Files: packages/webui/src/components/SetupView.tsx, packages/webui/src/setupModels.ts, packages/webui/test/setupModels.test.mjs, packages/webui/test/setupModels.e2e.mjs
Secondary files: packages/webui/package.json

## Purpose

Authenticated setup/configuration UI for first-run model configuration and later model/channel updates. It supports discriminated concrete/virtual model-provider forms, raw models YAML, transient concrete-provider testing, full app-config YAML editing with managed-channel reload, and Weixin QR login.

## Export

- default `SetupView({ forced?, onClose?, onSetupChanged? })`.

## API contract

All requests append to `API_BASE_PATH` and use the normal authenticated WebUI routes:

| Method/path | Use |
|---|---|
| `GET /setup/status` | OOBE flag, models diagnostics/raw YAML, full app-config YAML, channel runtime statuses |
| `GET /models` | Concrete model-key suggestions for virtual target editing; virtual entries are excluded |
| `POST /setup/models` | Save raw YAML byte-for-byte after validation or build current config from form providers |
| `POST /setup/models/test` | One transient provider/model request; does not persist first |
| `POST /setup/config` | Validate/write full app config and call `reloadManagedChannels` |
| `POST /setup/weixin/login/start` | Start/force a QR login session |
| `POST /setup/weixin/login/wait` | Check one session; on success update channel config and reload |

## Behavior

- Existing non-empty models YAML starts in raw mode; absent YAML starts with structured provider form.
- Raw models save preserves user text after validation. Structured save sends provider drafts/default selection for current config generation.
- Concrete provider cards edit connection/model fields and retain the existing transient test flow. Virtual `session-hash` cards edit target keys; `failover` additionally edits optional positive-integer threshold/cooldown values whose blanks select backend defaults.
- Virtual target input uses one exact concrete lookup key per line, rejects exact duplicate lines and insufficient target counts in the browser, and leaves unknown-key and canonical-alias validation to the canonical backend model resolver.
- Structured request and generated-YAML helpers serialize fields by provider-type discriminant, keep virtual providers independent of concrete model lists, use a virtual provider ID as its default key, and clear mutually exclusive fields when provider type changes.
- Virtual cards cannot invoke the transient provider test endpoint; saved virtual routes are exercised through normal model selection. Canonical routing/configuration semantics: [model routing](../threads/model-routing.md).
- App config editor edits the entire `state/config.yaml`, preserving unknown top-level fields through raw text rather than serializing only channels.
- Config save restarts every managed channel through `reloadManagedChannels` and displays started results.
- Weixin start renders returned image/base64/pairing URL; wait persists connected token/user/channel fields server-side.
- Forced mode is closable only after models config exists; WebUI itself makes the current channel-availability check non-blocking.

## Integration

- Normal App uses singleton `system:setup`; missing models forces this tab and rejects close.
- Code's Setup custom editor mounts the same non-forced leaf view and lets the extension own close/restore identity.
- `onSetupChanged` lets App re-read status after successful model/config/login changes.

## Function index

- `SetupView` — loads setup/model diagnostics and renders the discriminated setup workflow.
- `hydrateProviderDrafts` — converts setup status arrays/numbers into editable provider drafts.
- `changeProviderType` / `changeDefaultForProviderType` — clear mutually exclusive fields and normalize an affected default key on concrete/virtual transitions.
- `validateProviderDrafts` — enforces browser-known provider/model/target/integer constraints.
- `buildStructuredSetupRequest` — emits the field-discriminated structured save body.
- `buildModelsYaml` — previews the corresponding current YAML shape without changing raw-YAML persistence.
- `buildConcreteTestRequest` / `canTestProvider` — retain transient testing only for concrete providers.

## Design decisions

### D-setup-raw-preservation

Raw models/app configuration is validated then written without parse-and-redump so comments, key order, quoting, and unknown fields survive.

### D-setup-model-oobe

OOBE is the absence of models configuration. The forced Setup tab remains until the server status clears that condition.

## Canonical ownership

Saving app/channel configuration invokes the canonical full managed-channel restart behavior: [D-channel-managed-reload](../modules/channels.md#d-channel-managed-reload).
