# Unit: WebUI Setup view

Files: packages/webui/src/components/SetupView.tsx, packages/webui/src/components/ModelSetupFormPanel.tsx, packages/webui/src/components/WebUiBrandingSettings.tsx, packages/webui/src/components/NotificationSettings.tsx, packages/webui/src/setupModels.ts, packages/webui/src/components/ModelCatalogEditor.tsx, packages/webui/src/modelCatalog.ts, packages/webui/test/modelCatalog.test.mjs, packages/webui/test/setupModels.test.mjs, packages/webui/test/setupModels.e2e.mjs
Secondary files: packages/webui/package.json, packages/webui/src/yamlConfigSchemas.ts, packages/webui/src/components/SimpleCodeEditor.tsx, packages/webui/src/components/ThemeManager.tsx

## Purpose

Authenticated setup/configuration UI for first-run model configuration and later model/channel/appearance updates. Models offer a small structured form for one provider and the schema-aware YAML editor as the complete view; both edit the same models YAML. The view also edits full app-config YAML, reloads managed channels after config save, supports Weixin QR login, and hosts browser-local theme management.

Governing decisions: a new user must be able to finish first-run Setup without knowing the models schema ([D-setup-models-form](#d-setup-models-form)), and editing an existing configuration must never lose data ([D-setup-raw-preservation](#d-setup-raw-preservation)). The form is therefore offered only for documents it can write back faithfully.

## Export

- default `SetupView({ forced?, onClose?, onSetupChanged?, focusModelsRequest? })`.

## API contract

All requests append to `API_BASE_PATH` and use normal authenticated WebUI routes:

| Method/path | Use |
|---|---|
| `GET /setup/status` | OOBE flag, model diagnostics/raw YAML, full app-config YAML, and channel runtime status |
| `POST /setup/models` | Validate and save raw models YAML byte-for-byte |
| `POST /setup/models/list` | List models for one transient known concrete-provider connection: the form's **Load models** action and Monaco completion. Each entry is `{ id }` plus `contextLimit`, `maxOutput` and `imageInput` only when the provider declares them |
| `POST /setup/models/test` | Send one short transient request through the form's current connection and default model (**Test connection**); nothing is saved |
| `POST /setup/config` | Validate/install full app config, apply identities, reload managed channels, and report pending restart settings |
| `POST /setup/weixin/login/start` | Start or replace a QR login session |
| `POST /setup/weixin/login/wait` | Check one login session; on success update channel config and reload |

The form saves through the same raw `{ yaml }` request as the YAML editor. The server's older structured `/setup/models` request shape remains a backend compatibility boundary that this view does not use.

## Behavior

Config-save feedback preserves the .NET `reload.available: false` restart notice after checking explicit `notApplied` and `restartRequired` results. The host capability `managedChannels: false` hides unavailable external-channel controls while retaining the host-provided explanation.

- Models has a **Form** / **YAML** view switch. The models YAML text is the single source of truth: the form is derived from it with `readModelSetupForm` and every form change regenerates it with `buildModelSetupYaml`, so the YAML view always shows what Save will write. The YAML editor stays mounted while the form is shown.
- The form covers one concrete provider: a service preset (OpenAI, Anthropic, OpenRouter, DeepSeek, Ollama or another service), API type (`openai-completions`, `openai-responses`, `anthropic`), provider name, base URL, API key, a model list and the default model. **Load models** fills suggestions from `/setup/models/list`; entering a model ID manually always remains possible. Selecting a listed model whose listing declared a context limit, maximum output or no image input writes that model as an object with only the declared values (`imageInput: false` only; declared `true` is the default and is omitted), and the chip shows them (for example "1M context · 128K output · Images" or "32K context · Text only"; declared image support is shown from the current listing even when not written). Other models stay plain IDs and keep the configured defaults ([D-setup-models-declared-limits](#d-setup-models-declared-limits)). **Test connection** uses `/setup/models/test`. Changing the connection discards listed models and test results; changing service clears the key.
- `readModelSetupForm` accepts only a root with `default` and `providers`, exactly one provider with `providerType`, `baseUrl`, `apiKey` and `models` whose entries are unique IDs or `{ id, contextLimit?, maxOutput?, imageInput? }` objects with at least one of those settings (positive-integer limits, boolean `imageInput`, either value kept as written), a default of the form `provider/model`, and no comments, anchors, aliases or explicit tags. It then checks that writing the form back yields the same values. An omitted `apiKey`, `baseUrl` or `default` reads as empty, which the server treats identically. Anything else, including several providers, aliases, failover, model objects with other settings, extra provider fields (including provider-level `imageInput`) and root `defaults`, is not offered in the form: loading such a file selects the YAML view, and the Form view shows an explanation with **Edit in YAML** and disables Save. Only first-run Setup (no saved file) offers **Start over with the form**.
- If the active file is missing or empty, Setup initializes editable text from `defaultModelsYaml()`: the OpenAI preset (`openai-responses`, default `openai/gpt-5.6-sol`, models `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`) with an `apiKey` line holding the `TEMPLATE_API_KEY` placeholder. The form shows a placeholder key as an empty key field.
- In the Form view Save first applies `validateModelSetupForm`: provider name, an HTTP(S) base URL, no placeholder key, a key for known hosted services, at least one model and a listed default. Keyless local or unknown endpoints are allowed. The YAML view relies on backend validation.
- Saving a configuration that still contains placeholder keys after first run succeeds and names those providers in the success feedback; the Models tab shows its attention icon from `hasPlaceholderSecrets`. First-run saves with such keys are rejected by the server ([D-setup-model-oobe](#d-setup-model-oobe)).
- Raw model and app-config saves preserve user text after canonical backend validation. Comments, key order, quoting, custom fields, and formatting survive. Successful Models saves refresh only the current JavaScript context’s model cache and mounted Chat pickers, independent of editor revision feedback; failed saves retain cached choices. See [D-webui-model-settings-navigation](../modules/webui.md#d-webui-model-settings-navigation).
- Each Models or Config save reports its success or validation error beside (or immediately below on narrow layouts) that section's own Save button using an announced status. While focus is inside the active section's Monaco editor or controlled textarea fallback, unmodified Ctrl+S or Meta+S prevents the browser Save action and invokes that same section-owned save path exactly once; repeat events and additional presses during an in-flight save remain prevented without starting duplicate requests. Hidden editors, Appearance, and other panes do not own the shortcut. Load and Weixin errors remain in the page-level error area.
- Setup presents Appearance, Models, Config and Notifications as an accessible four-section surface without a nested enclosing card. At 700px pane width and above, section navigation is a left rail; narrower panes use a compact horizontal row. All labels have consistent leading icons, with configuration-state icons aligned separately. Tablist orientation follows actual pane width, and arrow keys/Home/End retain roving focus. Appearance is first and selected by default; forced first-run Setup starts on Models. Inactive panels are hidden while both editor instances remain mounted, preserving Monaco model/diagnostic lifecycle and each tab's local state without visibly stacking the editors.
- The former checklist is removed. Completion/attention icons appear in the tab labels: Models reflects usable model configuration; Config reflects enabled channel health and omits its icon when no enabled channel provides a meaningful status. Disabled channels do not create attention state.
- The two editors use distinct model URIs and static frontend schemas. Suggestions/markers are advisory and never disable Save; canonical behavior is [D-editor-local-yaml-assistance](./webui-editor.md#d-editor-local-yaml-assistance).
- Models and Config use the full available Setup content width and a pane-height editor section that grows with the active workbench/embedded pane instead of a fixed viewport cap. Only the section heading and Save/status row share its height budget; later channel/Weixin modules follow below without shrinking the editor. The active panel is the single Setup content scroller and keeps the small-window editor minimum and later modules reachable. Monaco and the plain-text fallback share the same container contract; Appearance keeps its narrower reading width.
- Model suggestions are derived from current unsaved YAML: defaults include concrete and virtual keys, while virtual targets include concrete keys only. History compatibility fields use the local concrete model/provider suggestions described in [WebUI editor](./webui-editor.md#behavior).
- App-config save uses the shared Main installer, hot-applies access identities, reloads every managed channel, and reports started results. Feedback distinguishes saved changes from incomplete application or remaining settings requiring restart; it does not claim all app fields are live. See [D-config-live-install](./src-config.md#d-config-live-install).
- Weixin login is the final section in the Config tab. Start renders image/base64/pairing payloads as a QR code without exposing internal session keys or pairing payload text; wait persists connected token/user/channel fields server-side.
- Forced mode is closable only after the active models file exists. WebUI itself makes the channel-availability check non-blocking.
- A positive `focusModelsRequest` activates the Models tab, scrolls to its panel, and focuses the form's first field or the Monaco editor, whichever view is active, then calls `onFocusModelsRequestHandled` so the owner clears the request. Per-mount state does not replay it. Canonical one-shot contract: [D-webui-model-settings-navigation](../modules/webui.md#d-webui-model-settings-navigation).
- Appearance hosts `ThemeManager` for theme-family selection, in-place Auto/Light/Dark palette preview, and portable import/export/clone/delete. A separate section below theme management edits the server-backed browser instance name and tab icon with the existing save/clear/cancel/error behavior. The compact global settings menu retains color mode as a quick control. Theme behavior is owned by [webui-theme-system](./webui-theme-system.md).
- [2026-11-06, user request] Notifications holds browser-local notification preferences: the browser permission status (with an Allow action before the browser has been asked, and a short pointer to site settings when blocked) and the question notification choice, All sessions (default), Only sessions with notifications on, or Off, stored in `foxwarm_question_notifications_v1`. Per-session idle notifications remain in the Session menu. Behavior of the choice is owned by [structured user questions](./session-questions.md).
- Browser name/icon saves send only the field being edited. Each successful response merges only that field into current UI state, preserving a successful sibling-field save even when two requests resolve out of order; failed saves leave the other field unchanged.
- If lazy editor support loading or configuration rejects, the Models and app-config surfaces remain controlled plain-text editors, so OOBE can still be completed and canonical backend validation still owns Save. Internal worker health is not probed after initialization; Monaco remains editable if schema assistance later degrades.

## Integration

- Normal App owns singleton `system:setup`; a missing active models file forces this tab and rejects close. The degraded-editor OOBE fixture rejects the lazy YAML worker import without blocking shared bootstrap chunks, exercises the protected sole-tab header Close action, and verifies continued Models editing and save against the production preview.
- The browser fixture runs the ordinary top-level Setup accessibility, product-copy, tab/keyboard, Config/Weixin, and theme scenario, plus the primary browser-name/icon scenario, against the built production preview mounted below `/production/foxwarm/`; the degraded-editor OOBE scenario uses that preview too. Its Vite development page remains for specialized editor-action, embedded-host, and deployment-relative `/preview` probes, so cold dependency optimization cannot replace the document underneath ordinary product interactions. In Chromium, its request mocks intercept API routes only, except when a scenario explicitly blocks editor assets, so YAML workers can initialize.
- Setup browser failures retain a bounded 8 KiB Chromium stderr tail and the active fixture/test phase. Unexpected disconnection emits process/connection status, with a later child exit reported once if needed; intentional final teardown stays silent. This observation does not restart the browser or change test results.
- Branding regression coverage mounts normal App, including missing/whitespace names with a custom favicon, named and busy titles, and the initial HTML title; title/favicon ownership is documented in [WebUI App](./webui-app.md#app-behavior). The fixture uses a disposable Vite dependency cache and the runner config loader so read-only installed dependencies remain untouched. Development editor actions record the optimized Monaco module URL with a pre-navigation resource observer per document, including its version query and external-cache `/@fs/` paths. They do not depend on the bounded Resource Timing buffer; a browser regression fills that buffer before Monaco loads and verifies both mounted editors remain readable and editable through the helper. The name-save scenario waits for App's updated title rather than the already-edited draft input.
- The active file is the data-directory models path; diagnostics and writes do not follow the removed generic override. Canonical path contract: [D-config-models-data-path](./src-config.md#d-config-models-data-path).
- Chat's model popup opens/activates this singleton and requests Models focus through App.
- Code's Setup custom editor mounts the same non-forced leaf view, accepts only the nonce-bound fixed Models-focus signal, and lets the extension own close/restore identity.
- `onSetupChanged` lets App refresh setup/OOBE status after successful model/config/login changes. Model-cache refresh belongs to the leaf’s Models save path, so embedded Setup uses it too without requiring an App callback.
- `setupModels.test.mjs` covers form ↔ YAML round trips for every API type and incomplete drafts, hand-written representable files, the non-representable cases that must stay in YAML, validation, placeholder/hosted-endpoint rules, presets and connection requests.
- `setupModels.e2e.mjs` completes forced first-run Setup through the form (Models opens first, the template placeholder blocks Save, service preset, model listing, manual model entry, connection test and the exact saved YAML), verifies that a simple existing file opens in the form while the complex fixture stays in YAML, and optionally writes screenshots to `FOXWARM_SETUP_SCREENSHOT_DIR`. It also authenticates its browser fixture as an administrator, checks saved-versus-restart/incomplete-application Config feedback, and verifies a successful Models save updates the existing Chat picker in a real production-preview split-pane App, rejected saves preserve choices, and explicit picker Refresh refetches.

## Function index

- `SetupView` — loads status and renders accessible Appearance/Models/Config tabs, raw editors, channel status, bottom-of-Config Weixin controls, theme management, and controlled browser-branding settings.
- `loadStatus` — refreshes diagnostics and hydrates raw editor text.
- `saveModels` / `saveConfig` — send raw YAML to backend-authoritative validators/writers; successful Models writes invoke the shared models-only refresh entry point.
- `startWeixinLogin` / `waitWeixinLogin` — manage pairing and persisted channel setup.
- `ModelSetupFormPanel` — the one-provider form, model listing and connection test; reports each change to `SetupView`, which writes YAML.
- `readModelSetupForm` / `buildModelSetupYaml` in `setupModels.ts` — faithful YAML ↔ form conversion and the representability check; `validateModelSetupForm`, `isPlaceholderApiKey`, `requiresApiKey`, `PROVIDER_PRESETS`, `formFromPreset`, `defaultModelsYaml`, `connectionTestRequest` support the form. The placeholder pattern and key-required host list mirror the server's `ModelApiKeys`.

## Design decisions

### D-setup-raw-preservation

Raw models/app configuration is validated then written without parse-and-redump so comments, key order, quoting, and unknown fields survive.

### D-setup-model-oobe

OOBE is the absence of the active data-directory models configuration. The forced Setup tab remains until the server status clears that condition, and it opens on Models.

[2026-11-03, approved first-run proposal] First-run Setup must not complete with a configuration that obviously cannot work. The server rejects the installation that would create the models file when a concrete provider's effective key (including the legacy app-level fallback) is a template placeholder, or is empty for a known hosted service that always requires one (`ModelApiKeys`; see [model configuration](./model-configuration.md#first-run-key-check)). Unknown and local endpoints may stay keyless. Later saves are not blocked; Setup reports remaining placeholders.

### D-setup-models-declared-limits

[2026-11-03, user-approved] When a provider's model list declares limits, the form uses them: a selected model gets `contextLimit` / `maxOutput` exactly as declared, and nothing is invented for undeclared models. Declared image-input support uses the `imageInput` model setting (default `true`, see [model configuration](./model-configuration.md)): a model declared without image input is written with `imageInput: false`, while declared support or no declaration writes nothing. Sources are described in [model configuration](./model-configuration.md#setup-model-listing).

### D-setup-models-form

[2026-11-03, user-approved; replaces the former raw-YAML-only decision] Setup offers a structured form for a first provider, while the schema-aware YAML editor remains the complete view. An earlier multi-provider form (removed in `7a61eb08`) tried to replace YAML and gave poor results, so this form deliberately covers one concrete provider and nothing else. It is offered only when it can represent the document faithfully; otherwise YAML is shown so aliases, failover, several providers, other model settings, comments and unknown fields are never lost. The form writes models YAML through the same raw save path, so backend validation and byte-preserving installation remain authoritative.

### D-setup-models-catalog

[2026-11-08, directly selected] Setup → Models lists the user's [recommended models](./model-configuration.md#d-model-catalog) below the models editor in both views: ordered rows of a model key chosen from the configured selectable keys (concrete `provider/model` keys first, then aliases and virtual routes) and a description, with add, remove and move up/down. The editor reads and rewrites the `catalog` section of the same models YAML text (`modelCatalog.ts`), so the YAML view, the single-provider form and this list always agree, unrelated content and comments are kept, and Save models remains the one save path with backend validation authoritative. The section is hidden until a models file exists and disabled with a short notice while the YAML does not parse. The single-provider form represents a catalog (`ModelSetupForm.catalog`): removing a model drops its row, renaming the provider rewrites its keys, and validation blocks saving a row whose key no longer exists or has no description. `setupModels.test.mjs`/`modelCatalog.test.mjs` cover the pure logic and `setupModels.e2e.mjs` covers row editing and save.

### D-setup-editor-height

[Updated 2026-10-25] The Models YAML and app-config YAML areas fill the width and remaining height of the active Setup pane through CSS ownership, with no JavaScript size calculation or fixed desktop cap. Each editor section budgets the pane height for its heading, editor and Save/status row; later modules follow below and do not reduce editor height. Keep one active-panel content scrollbar, a practical small-window editor minimum, reachable Save/status and later Config sections, and the same sizing contract for Monaco and the controlled plain-text fallback. Appearance remains reading-width bounded.

### D-setup-save-feedback

Models save success/errors belong beside or immediately below the Models Save button, and Config save success/errors belong beside or immediately below the Config Save button. Each result belongs to the exact submitted document revision: editing that section or hydrating a new status clears it, and an older save/status response must neither publish stale feedback nor overwrite a newer edit. Keep the two results independent, responsive, and accessibly announced rather than placing them in the page-top notice area. The loading notice appears only before the first successful status load; subsequent status refreshes, including those after Models and Config saves, keep the existing content mounted without inserting a page-top notice or shifting the editor. Load and Weixin failures remain page-level.

### D-setup-editor-save-shortcut

[2026-09-22] The active Models and Config editor regions own unmodified Ctrl+S and Meta+S. Handle the key at the section boundary shared by Monaco and its controlled textarea fallback, prevent the browser Save action, and delegate to the existing section save function and backend-authoritative validation. A held key repeat, composing input, or another press while that section's request is in flight must not create another request, although the recognized chord remains prevented. Do not register a document-global shortcut or capture Appearance, inactive panels, other workbench panes, Ctrl+Shift+S, or Alt-modified chords.

### D-setup-tab-layout

[2026-09-03, updated 2026-10-14] Setup uses three accessible tabs in this order: `Appearance`, `Models` and `Config`. The former Authorizations entry is removed; Setup does not mount its retained component or request its administrator API. MCP OAuth capability and account ownership remain in [outbound MCP OAuth](./src-mcp-oauth.md). Appearance is the initial default; [2026-11-03] forced first-run Setup starts on Models because adding a model is its only purpose. Completion/attention status is shown on the configuration tabs. Only the active panel is visible, while both editor instances remain mounted to preserve editor lifecycle and document state. Weixin login is the final section of Config. Model-focus requests always activate Models before focusing its editor, including the Code-embedded Setup surface. Appearance owns theme-family/theme-file management and the server-backed browser name/icon section; see [D-webui-theme-controls](./webui-theme-system.md#d-webui-theme-controls) and [D-webui-settings-placement](../modules/webui.md#d-webui-settings-placement).

## Canonical ownership

Saving app/channel configuration invokes the canonical full managed-channel restart behavior: [D-channel-managed-reload](../modules/channels.md#d-channel-managed-reload).

Mobile-specific navigation, headers, and preferences follow the [mobile shell contract](../threads/webui-mobile-shell.md); desktop data and workbench owners remain unchanged.
