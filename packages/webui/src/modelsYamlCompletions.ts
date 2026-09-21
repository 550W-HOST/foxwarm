import { isMap, isScalar, isSeq, parseDocument } from 'yaml'
import { KNOWN_PROVIDER_TYPES, MODELS_YAML_MODEL_URI } from './yamlConfigSchemas'

// Monaco and monaco-yaml both derive completion replacement ranges from the language's word
// pattern. YAML scalar values commonly contain model punctuation such as `gpt-5.6-sol` or `/`;
// keep that punctuation in the current word while excluding YAML delimiters and comments.
export const YAML_SCALAR_WORD_PATTERN = /[^\s[\]{},:'"#]+/g

export const PROVIDER_MODEL_CACHE_TTL_MS = 60_000
export const PROVIDER_MODEL_FAILURE_TTL_MS = 5_000

export type ModelsYamlSuggestions = {
  modelKeys: string[]
  concreteKeys: string[]
}

export type ProviderModelConnection = {
  providerType: string
  baseUrl?: string
  apiKey?: string
  extraHeaders?: Record<string, string | number | boolean>
}

export type ProviderModelCompletionContext = {
  providerKey: string
  connection: ProviderModelConnection
  replaceStartOffset: number
  replaceEndOffset: number
}

export type ListProviderModels = (connection: ProviderModelConnection, signal: AbortSignal) => Promise<string[]>

type ParsedProvider = {
  providerType?: unknown
  provider?: unknown
  models?: unknown
  model?: unknown
}

type ProviderModelCacheEntry = {
  connection: ProviderModelConnection
  generation: number
  expiresAt: number
  models?: string[]
  failed?: boolean
  controller?: AbortController
  inflight?: Promise<string[]>
}

const REMOTE_MODEL_PROVIDER_TYPES = new Set([
  'openai',
  'openai-responses',
  'openai-ws',
  'openai-completions',
  'anthropic',
])

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
    if (typeof rawEntry === 'string') {
      if (rawEntry.trim()) virtualKeys.push(providerKey)
      continue
    }
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

function nodeContainsOffset(node: any, offset: number): boolean {
  if (!Array.isArray(node?.range)) return false
  const start = node.range[0]
  const end = node.range[2] ?? node.range[1]
  return offset >= start && offset <= end
}

function scalarString(map: any, key: string, trim = true): string | undefined {
  const node = map?.get?.(key, true)
  if (!isScalar(node) || typeof node.value !== 'string') return undefined
  const value = trim ? node.value.trim() : node.value
  return value || undefined
}

function scalarHeaders(map: any): Record<string, string | number | boolean> | undefined | null {
  const node = map?.get?.('extraHeaders', true)
  if (!isMap(node)) return undefined
  const headers: Record<string, string | number | boolean> = {}
  const seen = new Set<string>()
  for (const pair of node.items) {
    const name = isScalar(pair?.key) && typeof pair.key.value === 'string' ? pair.key.value.trim() : ''
    const value = pair?.value
    if (!name || seen.has(name) || !isScalar(value) || !['string', 'number', 'boolean'].includes(typeof value.value)) return null
    seen.add(name)
    headers[name] = value.value as string | number | boolean
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function hasInvalidConnectionFields(providerNode: any): boolean {
  for (const key of ['providerType', 'provider', 'baseUrl', 'apiKey']) {
    const node = providerNode.get?.(key, true)
    if (node !== undefined && (!isScalar(node) || typeof node.value !== 'string')) return true
  }
  const extraHeaders = providerNode.get?.('extraHeaders', true)
  return extraHeaders !== undefined && !isMap(extraHeaders)
}

function modelValuePath(path: Array<string | number>): boolean {
  if (path.length < 3) return false
  const field = path[2]
  const rest = path.slice(3)
  if (field === 'models') {
    return (rest.length === 1 && typeof rest[0] === 'number')
      || (rest.length === 2 && typeof rest[0] === 'number' && rest[1] === 'id')
  }
  if (field !== 'model') return false
  return rest.length === 0
    || (rest.length === 1 && typeof rest[0] === 'number')
    || (rest.length === 2 && typeof rest[0] === 'number' && rest[1] === 'id')
}

function findScalarAtOffset(
  node: any,
  offset: number,
  path: Array<string | number> = [],
  providerNode?: any,
): { node: any; path: Array<string | number>; providerNode?: any } | null {
  if (!node || !nodeContainsOffset(node, offset)) return null
  if (isScalar(node)) return { node, path, providerNode }
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair?.key) ? pair.key.value : undefined
      if (typeof key !== 'string' || !pair?.value) continue
      const nextPath = [...path, key]
      const nextProviderNode = nextPath.length === 2 && (nextPath[0] === 'providers' || nextPath[0] === 'models')
        ? pair.value
        : providerNode
      const found = findScalarAtOffset(pair.value, offset, nextPath, nextProviderNode)
      if (found) return found
    }
  } else if (isSeq(node)) {
    for (let index = 0; index < node.items.length; index += 1) {
      const found = findScalarAtOffset(node.items[index], offset, [...path, index], providerNode)
      if (found) return found
    }
  }
  return null
}

function hasDuplicateConnectionKeys(providerNode: any): boolean {
  const connectionKeys = new Set(['providerType', 'provider', 'baseUrl', 'apiKey', 'extraHeaders'])
  const seen = new Set<string>()
  for (const pair of providerNode.items || []) {
    const key = isScalar(pair?.key) && typeof pair.key.value === 'string' ? pair.key.value : ''
    if (!connectionKeys.has(key)) continue
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

function scalarReplacementOffsets(node: any): { start: number; end: number } | null {
  if (!Array.isArray(node?.range)) return null
  let start = node.range[0]
  let end = node.range[1]
  const tokenType = node.srcToken?.type
  if ((tokenType === 'single-quoted-scalar' || tokenType === 'double-quoted-scalar') && end - start >= 2) {
    start += 1
    end -= 1
  }
  return { start, end }
}

export function getProviderModelCompletionContext(rawYaml: string, offset: number): ProviderModelCompletionContext | null {
  let document
  try {
    document = parseDocument(rawYaml, { keepSourceTokens: true })
  } catch {
    return null
  }
  const found = findScalarAtOffset(document.contents, offset)
  if (!found || !modelValuePath(found.path)) return null
  const [rootKey, providerKey] = found.path
  if ((rootKey !== 'providers' && rootKey !== 'models') || typeof providerKey !== 'string' || !providerKey.trim()) return null

  const providerNode = found.providerNode
  if (!isMap(providerNode) || hasDuplicateConnectionKeys(providerNode) || hasInvalidConnectionFields(providerNode)) return null
  const providerType = scalarString(providerNode, 'providerType', false)
    || scalarString(providerNode, 'provider', false)
    || 'openai'
  if (!REMOTE_MODEL_PROVIDER_TYPES.has(providerType)) return null
  const replacement = scalarReplacementOffsets(found.node)
  if (!replacement) return null
  const extraHeaders = scalarHeaders(providerNode)
  if (extraHeaders === null) return null

  return {
    providerKey,
    connection: {
      providerType,
      ...(scalarString(providerNode, 'baseUrl') ? { baseUrl: scalarString(providerNode, 'baseUrl') } : {}),
      ...(scalarString(providerNode, 'apiKey') ? { apiKey: scalarString(providerNode, 'apiKey') } : {}),
      ...(extraHeaders ? { extraHeaders } : {}),
    },
    replaceStartOffset: replacement.start,
    replaceEndOffset: replacement.end,
  }
}

function connectionsEqual(left: ProviderModelConnection, right: ProviderModelConnection): boolean {
  if (left.providerType !== right.providerType || left.baseUrl !== right.baseUrl || left.apiKey !== right.apiKey) return false
  const leftHeaders = left.extraHeaders || {}
  const rightHeaders = right.extraHeaders || {}
  const leftKeys = Object.keys(leftHeaders).sort()
  const rightKeys = Object.keys(rightHeaders).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && leftHeaders[key] === rightHeaders[key])
}

function sanitizeListedModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map(item => item.trim())
    .filter(Boolean))]
}

export function createModelsYamlCompletionProvider(
  monaco: typeof import('monaco-editor/esm/vs/editor/editor.api.js'),
  listProviderModels?: ListProviderModels,
) {
  const suggestionsByModel = new Map<string, ModelsYamlSuggestions>()
  const timersByModel = new Map<string, ReturnType<typeof setTimeout>>()
  const providerModelsByKey = new Map<string, ProviderModelCacheEntry>()
  let nextProviderGeneration = 1

  const abortProviderRequests = () => {
    for (const entry of providerModelsByKey.values()) entry.controller?.abort()
    providerModelsByKey.clear()
  }

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

  const getProviderModels = (providerKey: string, connection: ProviderModelConnection): Promise<string[]> => {
    if (!listProviderModels) return Promise.resolve([])
    const now = Date.now()
    const current = providerModelsByKey.get(providerKey)
    if (current && connectionsEqual(current.connection, connection)) {
      if (current.inflight) return current.inflight
      if (current.expiresAt > now) return Promise.resolve(current.failed ? [] : (current.models || []))
    } else if (current) {
      current.controller?.abort()
      providerModelsByKey.delete(providerKey)
    }

    const controller = new AbortController()
    const entry: ProviderModelCacheEntry = {
      connection,
      generation: nextProviderGeneration++,
      expiresAt: 0,
      controller,
    }
    const inflight = listProviderModels(connection, controller.signal)
      .then((models) => {
        const listed = sanitizeListedModels(models)
        if (providerModelsByKey.get(providerKey)?.generation === entry.generation && !controller.signal.aborted) {
          entry.models = listed
          entry.failed = false
          entry.expiresAt = Date.now() + PROVIDER_MODEL_CACHE_TTL_MS
          entry.inflight = undefined
          entry.controller = undefined
        }
        return listed
      })
      .catch(() => {
        if (providerModelsByKey.get(providerKey)?.generation === entry.generation && !controller.signal.aborted) {
          entry.models = []
          entry.failed = true
          entry.expiresAt = Date.now() + PROVIDER_MODEL_FAILURE_TTL_MS
          entry.inflight = undefined
          entry.controller = undefined
        }
        return []
      })
    entry.inflight = inflight
    providerModelsByKey.set(providerKey, entry)
    return inflight
  }

  const completionDisposable = monaco.languages.registerCompletionItemProvider('yaml', {
    triggerCharacters: [' ', '-', ':'],
    async provideCompletionItems(model, position) {
      if (model.uri.toString() !== MODELS_YAML_MODEL_URI) return { suggestions: [] }
      const kind = getModelsCompletionKind(model.getLinesContent(), position.lineNumber - 1)
      if (kind) {
        // A completion can be requested before the edit debounce fires. Parse the current valid
        // document at that explicit interaction boundary; invalid partial YAML still falls back to
        // the last valid debounced snapshot.
        const currentValues = parseModelsYamlSuggestions(model.getValue())
        if (currentValues) suggestionsByModel.set(MODELS_YAML_MODEL_URI, currentValues)
        const values = currentValues ?? suggestionsByModel.get(MODELS_YAML_MODEL_URI)
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
      }

      const remoteContext = getProviderModelCompletionContext(model.getValue(), model.getOffsetAt(position))
      if (!remoteContext || !listProviderModels) return { suggestions: [] }
      const listedModels = await getProviderModels(remoteContext.providerKey, remoteContext.connection)
      const latestContext = getProviderModelCompletionContext(model.getValue(), model.getOffsetAt(position))
      if (
        listedModels.length === 0
        || !latestContext
        || latestContext.providerKey !== remoteContext.providerKey
        || !connectionsEqual(latestContext.connection, remoteContext.connection)
        || latestContext.replaceStartOffset !== remoteContext.replaceStartOffset
        || latestContext.replaceEndOffset !== remoteContext.replaceEndOffset
      ) return { suggestions: [] }
      const start = model.getPositionAt(remoteContext.replaceStartOffset)
      const end = model.getPositionAt(remoteContext.replaceEndOffset)
      const range = {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      }
      return {
        suggestions: listedModels.map((modelId) => ({
          label: modelId,
          kind: monaco.languages.CompletionItemKind.Value,
          insertText: modelId,
          range,
          detail: 'Provider model',
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
      if (modelUri === MODELS_YAML_MODEL_URI) abortProviderRequests()
    },
    dispose() {
      for (const timer of timersByModel.values()) clearTimeout(timer)
      timersByModel.clear()
      suggestionsByModel.clear()
      abortProviderRequests()
      completionDisposable.dispose()
    },
  }
}

export const STATIC_PROVIDER_TYPE_SUGGESTIONS = [...KNOWN_PROVIDER_TYPES]
