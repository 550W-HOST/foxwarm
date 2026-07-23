import { parseDocument } from 'yaml'
import { KNOWN_PROVIDER_TYPES, MODELS_YAML_MODEL_URI } from './yamlConfigSchemas'

export type ModelsYamlSuggestions = {
  modelKeys: string[]
  concreteKeys: string[]
}

type ParsedProvider = {
  providerType?: unknown
  provider?: unknown
  models?: unknown
  model?: unknown
}

function modelId(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
    return (value as { id: string }).id.trim()
  }
  return ''
}

function getDisplayConcreteKeys(providerKey: string, entry: ParsedProvider): string[] {
  const rawModels = entry.models ?? entry.model
  const models = rawModels === undefined || rawModels === null || rawModels === ''
    ? []
    : Array.isArray(rawModels)
      ? rawModels
      : [rawModels]
  const ids = models.map(modelId).filter(Boolean)
  if (ids.length <= 1) return [providerKey]
  return ids.map((id) => `${providerKey}/${id}`)
}

export function parseModelsYamlSuggestions(rawYaml: string): ModelsYamlSuggestions | null {
  const document = parseDocument(rawYaml)
  if (document.errors.length > 0) return null
  const root = document.toJS() as { providers?: unknown; models?: unknown } | null
  if (!root || typeof root !== 'object') return { modelKeys: [], concreteKeys: [] }
  const rawProviders = root.providers ?? root.models
  if (!rawProviders || typeof rawProviders !== 'object' || Array.isArray(rawProviders)) {
    return { modelKeys: [], concreteKeys: [] }
  }

  const concreteKeys: string[] = []
  const virtualKeys: string[] = []
  for (const [providerKey, rawEntry] of Object.entries(rawProviders as Record<string, unknown>)) {
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue
    const entry = rawEntry as ParsedProvider
    const providerType = String(entry.providerType ?? entry.provider ?? 'openai')
    if (providerType === 'session-hash' || providerType === 'failover') {
      virtualKeys.push(providerKey)
    } else {
      concreteKeys.push(...getDisplayConcreteKeys(providerKey, entry))
    }
  }

  return {
    concreteKeys: [...new Set(concreteKeys)],
    modelKeys: [...new Set([...concreteKeys, ...virtualKeys])],
  }
}

function indentation(line: string): number {
  return line.match(/^\s*/)?.[0].length || 0
}

export function getModelsCompletionKind(lines: string[], lineIndex: number): 'default' | 'targets' | null {
  const line = lines[lineIndex] || ''
  if (/^\s*default\s*:/.test(line)) return 'default'

  const currentIndent = indentation(line)
  if (/^\s*targets\s*:/.test(line)) return 'targets'
  for (let index = lineIndex - 1; index >= 0; index -= 1) {
    const candidate = lines[index]
    if (!candidate.trim() || /^\s*#/.test(candidate)) continue
    const candidateIndent = indentation(candidate)
    if (candidateIndent >= currentIndent) continue
    if (/^\s*targets\s*:/.test(candidate)) return 'targets'
    break
  }
  return null
}

export function createModelsYamlCompletionProvider(monaco: typeof import('monaco-editor/esm/vs/editor/editor.api.js')) {
  const suggestionsByModel = new Map<string, ModelsYamlSuggestions>()
  const timersByModel = new Map<string, ReturnType<typeof setTimeout>>()

  const update = (modelUri: string, rawYaml: string, immediate = false) => {
    const currentTimer = timersByModel.get(modelUri)
    if (currentTimer) clearTimeout(currentTimer)
    const apply = () => {
      timersByModel.delete(modelUri)
      const parsed = parseModelsYamlSuggestions(rawYaml)
      if (parsed) suggestionsByModel.set(modelUri, parsed)
    }
    if (immediate) apply()
    else timersByModel.set(modelUri, setTimeout(apply, 180))
  }

  const completionDisposable = monaco.languages.registerCompletionItemProvider('yaml', {
    triggerCharacters: [' ', '-', ':'],
    provideCompletionItems(model, position) {
      if (model.uri.toString() !== MODELS_YAML_MODEL_URI) return { suggestions: [] }
      const kind = getModelsCompletionKind(model.getLinesContent(), position.lineNumber - 1)
      if (!kind) return { suggestions: [] }
      const values = suggestionsByModel.get(MODELS_YAML_MODEL_URI)
      const keys = kind === 'targets' ? values?.concreteKeys : values?.modelKeys
      if (!keys?.length) return { suggestions: [] }
      const word = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endLineNumber: position.lineNumber,
        endColumn: word.endColumn,
      }
      return {
        suggestions: keys.map((key) => ({
          label: key,
          kind: monaco.languages.CompletionItemKind.Value,
          insertText: key,
          range,
          detail: kind === 'targets' ? 'Configured concrete model' : 'Configured model',
        })),
      }
    },
  })

  return {
    update,
    remove(modelUri: string) {
      const timer = timersByModel.get(modelUri)
      if (timer) clearTimeout(timer)
      timersByModel.delete(modelUri)
      suggestionsByModel.delete(modelUri)
    },
    dispose() {
      for (const timer of timersByModel.values()) clearTimeout(timer)
      timersByModel.clear()
      suggestionsByModel.clear()
      completionDisposable.dispose()
    },
  }
}

export const STATIC_PROVIDER_TYPE_SUGGESTIONS = [...KNOWN_PROVIDER_TYPES]
