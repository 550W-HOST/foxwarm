# Unit: Setup, model configuration, and UI settings

Files: `packages/webui/src/components/AgentCreationMenu.tsx`, `packages/webui/src/components/GlobalUiSettingsMenu.tsx`, `packages/webui/src/components/NodeTargetSelect.tsx`, `packages/webui/src/components/ReloadAppButton.tsx`, `packages/webui/src/components/SessionUiSettingsMenu.tsx`, `packages/webui/src/components/SetupView.tsx`, `packages/webui/src/components/WebUiBrandingSettings.tsx`, `packages/webui/src/components/childModelState.ts`, `packages/webui/src/components/modelFilter.ts`, `packages/webui/src/modelOptionsLoader.ts`, `packages/webui/src/modelsYamlCompletions.ts`, `packages/webui/src/setupModels.ts`, `packages/webui/src/workers/yaml.worker.ts`, `packages/webui/src/yamlConfigSchemas.ts`, `packages/webui/src/yamlMonacoSupport.ts`

## Purpose

Loads model/configuration schemas and owns setup, branding, settings menus, child model selectors, and node-target selection.

## Stable symbols and callers

`SetupView`; setup/model loaders; settings menus; YAML worker/schema completion; node target selectors.

Callers and boundary: Host setup/model configuration endpoints and app settings persistence.

## Behavior and side effects

`SetupView` loads schema/completion data and submits validated provider/model forms. Settings menus persist UI/session presentation preferences through explicit host endpoints; child model/node selectors are configuration inputs, not proof of remote runtime integration. YAML worker/completion files run browser-side parsing only.

## Tests

Setup-models, model-options, config-editor, and settings tests.
