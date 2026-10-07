# Unit: Setup, model configuration, and UI settings

Files: `packages/webui/src/components/AgentCreationMenu.tsx`, `packages/webui/src/components/GlobalUiSettingsMenu.tsx`, `packages/webui/src/components/NodeTargetSelect.tsx`, `packages/webui/src/components/ReloadAppButton.tsx`, `packages/webui/src/components/SessionUiSettingsMenu.tsx`, `packages/webui/src/components/SetupView.tsx`, `packages/webui/src/components/WebUiBrandingSettings.tsx`, `packages/webui/src/components/childModelState.ts`, `packages/webui/src/components/modelFilter.ts`, `packages/webui/src/modelOptionsLoader.ts`, `packages/webui/src/modelsYamlCompletions.ts`, `packages/webui/src/setupModels.ts`, `packages/webui/src/workers/yaml.worker.ts`, `packages/webui/src/yamlConfigSchemas.ts`, `packages/webui/src/yamlMonacoSupport.ts`

## Purpose

Loads setup/model schemas and completions, owns setup/OOBE forms, branding and Session/UI settings, child-model selectors, and Node-target selection.

## Stable symbols and callers

`SetupView`; `setupModels`; `modelOptionsLoader`; `modelsYamlCompletions`; `yamlConfigSchemas`; `yamlMonacoSupport`; `NodeTargetSelect`; settings menus; `childModelState` and model-filter helpers. Callers are App shell, Chat model navigation, Agent creation, and host setup/model endpoints.

## Behavior and side effects

Setup preserves raw YAML text/unknown fields while editing known schema fields; validation/completion is browser-side assistance, not a second configuration authority. Save feedback distinguishes pending/success/error and retains unsaved editor text on failure. The setup editor’s keyboard/save and tab layout remain stable, and server `/setup/status` controls forced OOBE rather than a client guess.

Model OOBE and setup navigation use the singleton `system:setup` tab; child-model/node selectors submit configuration and presentation choices but do not imply remote Worker/Node or Vector runtime integration. Session/UI settings are browser/session presentation preferences and do not change active Session JSON directly.

## Tests

Setup-models, model-options/filter, YAML schema/completion, setup save feedback, Agent creation, and settings browser tests.
