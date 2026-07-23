import { createModelsYamlCompletionProvider } from './modelsYamlCompletions'
import { MODELS_YAML_MODEL_URI, YAML_CONFIG_SCHEMAS } from './yamlConfigSchemas'

type MonacoModule = typeof import('monaco-editor')
type ModelsCompletionSupport = ReturnType<typeof createModelsYamlCompletionProvider>

type YamlMonacoSupport = {
  monaco: MonacoModule
  updateModelSuggestions: (modelUri: string, value: string, immediate?: boolean) => void
  removeModelSuggestions: (modelUri: string) => void
}

let supportPromise: Promise<YamlMonacoSupport> | null = null
let editorWorkerConstructor: (new () => Worker) | null = null
let yamlWorkerConstructor: (new () => Worker) | null = null
let completionSupport: ModelsCompletionSupport | null = null

function installWorkerDispatcher() {
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'yaml' && yamlWorkerConstructor) return new yamlWorkerConstructor()
      if (!editorWorkerConstructor) throw new Error('Monaco editor worker is not loaded')
      return new editorWorkerConstructor()
    },
  }
}

export function loadYamlMonacoSupport(): Promise<YamlMonacoSupport> {
  if (supportPromise) return supportPromise

  supportPromise = (async () => {
    const [editorWorkerModule, yamlWorkerModule] = await Promise.all([
      import('monaco-editor/esm/vs/editor/editor.worker.js?worker'),
      import('./workers/yaml.worker.ts?worker'),
    ])

    editorWorkerConstructor = editorWorkerModule.default
    yamlWorkerConstructor = yamlWorkerModule.default
    installWorkerDispatcher()

    const [monaco, monacoYaml] = await Promise.all([
      import('monaco-editor'),
      import('monaco-yaml'),
      import('monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js'),
    ])

    monacoYaml.configureMonacoYaml(monaco, {
      completion: true,
      hover: true,
      validate: true,
      enableSchemaRequest: false,
      format: { enable: false },
      hoverSchemaSource: false,
      schemas: YAML_CONFIG_SCHEMAS as never,
      yamlVersion: '1.2',
    })
    completionSupport = createModelsYamlCompletionProvider(monaco)

    return {
      monaco,
      updateModelSuggestions(modelUri: string, value: string, immediate = false) {
        if (modelUri === MODELS_YAML_MODEL_URI) completionSupport?.update(modelUri, value, immediate)
      },
      removeModelSuggestions(modelUri: string) {
        completionSupport?.remove(modelUri)
      },
    }
  })().catch((error) => {
    supportPromise = null
    completionSupport?.dispose()
    completionSupport = null
    editorWorkerConstructor = null
    yamlWorkerConstructor = null
    throw error
  })

  return supportPromise
}
