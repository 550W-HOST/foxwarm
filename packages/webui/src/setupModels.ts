import { isAlias, isMap, isScalar, isSeq, parseDocument, visit } from 'yaml'

/**
 * Structured first-provider model setup.
 *
 * The form edits exactly one concrete provider: API type, base URL, API key, model IDs and the
 * default model. Its only storage is models YAML. A document is offered in the form only when the
 * form can represent it faithfully; anything else (comments, aliases, failover, more providers,
 * model objects, extra fields) stays in the YAML editor so no configuration is lost.
 */

export type ModelProviderType = 'openai-completions' | 'openai-responses' | 'anthropic'

export const MODEL_PROVIDER_TYPES: ReadonlyArray<{ value: ModelProviderType; label: string }> = [
  { value: 'openai-completions', label: 'OpenAI-compatible (Chat Completions)' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic', label: 'Anthropic Messages' },
]

export type ProviderPreset = {
  id: string
  label: string
  providerId: string
  providerType: ModelProviderType
  baseUrl: string
  models: string[]
}

export const CUSTOM_PRESET_ID = 'custom'

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', providerId: 'openai', providerType: 'openai-responses', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] },
  { id: 'anthropic', label: 'Anthropic', providerId: 'anthropic', providerType: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5'] },
  { id: 'openrouter', label: 'OpenRouter', providerId: 'openrouter', providerType: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', models: [] },
  { id: 'deepseek', label: 'DeepSeek', providerId: 'deepseek', providerType: 'openai-completions', baseUrl: 'https://api.deepseek.com', models: [] },
  { id: 'ollama', label: 'Ollama', providerId: 'ollama', providerType: 'openai-completions', baseUrl: 'http://localhost:11434/v1', models: [] },
  { id: CUSTOM_PRESET_ID, label: 'Other service', providerId: 'custom', providerType: 'openai-completions', baseUrl: '', models: [] },
]

/**
 * A model entry. Settings come from what the provider's model list declared, or from an existing
 * file; `imageInput` defaults to true, so the form adds it only for models declared text-only.
 */
export type ModelSetupModel = {
  id: string
  contextLimit?: number
  maxOutput?: number
  imageInput?: boolean
}

/** One entry of `/setup/models/list`; every field except `id` is present only when declared. */
export type ListedModel = ModelSetupModel

export type ModelSetupForm = {
  providerId: string
  providerType: ModelProviderType
  baseUrl: string
  apiKey: string
  models: ModelSetupModel[]
  /** Model ID within this provider, without the provider prefix. */
  defaultModel: string
}

export type ModelSetupReading =
  | { ok: true; form: ModelSetupForm }
  | { ok: false; reason: 'invalid' | 'unsupported' }

// Hosted services whose API always requires a key. Unknown and local endpoints are not judged,
// because self-hosted gateways commonly run without one. Keep in step with the server's ModelApiKeys.
const KEY_REQUIRED_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'openrouter.ai',
  'api.deepseek.com',
  'generativelanguage.googleapis.com',
  'api.x.ai',
  'api.mistral.ai',
  'api.groq.com',
]

const PLACEHOLDER_API_KEY = /^(your[-_ ].*|.*[-_ ]here|replace[-_ ]?me|replace[-_ ]with[-_ ].*|change[-_ ]?me|placeholder|sk-\.\.\.|sk-x+|x{3,}|<[^>]*>)$/i

export const TEMPLATE_API_KEY = 'your-openai-api-key'

export function isPlaceholderApiKey(value: string): boolean {
  return PLACEHOLDER_API_KEY.test(value.trim())
}

export function requiresApiKey(baseUrl: string): boolean {
  let host: string
  try {
    host = new URL(baseUrl.trim()).hostname.replace(/\.$/, '').toLowerCase()
  } catch {
    return false
  }
  return KEY_REQUIRED_HOSTS.some((known) => host === known || host.endsWith(`.${known}`))
}

function normalizeUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

export function presetFor(form: Pick<ModelSetupForm, 'providerType' | 'baseUrl'>): ProviderPreset {
  const url = normalizeUrl(form.baseUrl)
  return PROVIDER_PRESETS.find((preset) => preset.id !== CUSTOM_PRESET_ID
    && preset.providerType === form.providerType
    && normalizeUrl(preset.baseUrl) === url)
    || PROVIDER_PRESETS.find((preset) => preset.id === CUSTOM_PRESET_ID)!
}

/** A fresh form for a service. Keys belong to one service, so switching services clears it. */
export function formFromPreset(presetId: string): ModelSetupForm {
  const preset = PROVIDER_PRESETS.find((item) => item.id === presetId) || PROVIDER_PRESETS[0]
  return {
    providerId: preset.providerId,
    providerType: preset.providerType,
    baseUrl: preset.baseUrl,
    apiKey: '',
    models: preset.models.map((id) => ({ id })),
    defaultModel: preset.models[0] || '',
  }
}

/** Initial editor text when no models file exists: the OpenAI preset with a key placeholder line. */
export function defaultModelsYaml(): string {
  return buildModelSetupYaml({ ...formFromPreset('openai'), apiKey: TEMPLATE_API_KEY })
}

function quote(value: string): string {
  return JSON.stringify(value)
}

function yamlKey(value: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : quote(value)
}

export function defaultModelKey(form: Pick<ModelSetupForm, 'providerId' | 'defaultModel'>): string {
  return form.defaultModel ? `${form.providerId}/${form.defaultModel}` : ''
}

export function buildModelSetupYaml(form: ModelSetupForm): string {
  const lines = [
    `default: ${quote(defaultModelKey(form))}`,
    'providers:',
    `  ${yamlKey(form.providerId)}:`,
    `    providerType: ${quote(form.providerType)}`,
    `    baseUrl: ${quote(form.baseUrl)}`,
    `    apiKey: ${quote(form.apiKey)}`,
  ]
  if (form.models.length === 0) lines.push('    models: []')
  else {
    lines.push('    models:')
    for (const model of form.models) {
      if (model.contextLimit === undefined && model.maxOutput === undefined && model.imageInput === undefined) {
        lines.push(`      - ${quote(model.id)}`)
        continue
      }
      lines.push(`      - id: ${quote(model.id)}`)
      if (model.contextLimit !== undefined) lines.push(`        contextLimit: ${model.contextLimit}`)
      if (model.maxOutput !== undefined) lines.push(`        maxOutput: ${model.maxOutput}`)
      if (model.imageInput !== undefined) lines.push(`        imageInput: ${model.imageInput}`)
    }
  }
  return `${lines.join('\n')}\n`
}

const ROOT_KEYS = new Set(['default', 'providers'])
const PROVIDER_KEYS = new Set(['providerType', 'baseUrl', 'apiKey', 'models'])
const MODEL_KEYS = new Set(['id', 'contextLimit', 'maxOutput', 'imageInput'])

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** A model the form can show: an ID string, or an object with an ID plus limits and image input only. */
function readModel(value: unknown): ModelSetupModel | null {
  if (typeof value === 'string') return value.trim() && value === value.trim() ? { id: value } : null
  if (!isPlainObject(value) || Object.keys(value).some((key) => !MODEL_KEYS.has(key))) return null
  const { id, contextLimit, maxOutput, imageInput } = value
  if (typeof id !== 'string' || !id.trim() || id !== id.trim()) return null
  if (contextLimit === undefined && maxOutput === undefined && imageInput === undefined) return null
  if ((contextLimit !== undefined && !isPositiveInteger(contextLimit)) || (maxOutput !== undefined && !isPositiveInteger(maxOutput))) return null
  if (imageInput !== undefined && typeof imageInput !== 'boolean') return null
  return {
    id,
    ...(contextLimit !== undefined ? { contextLimit } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    ...(imageInput !== undefined ? { imageInput } : {}),
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Comments, anchors, aliases and explicit tags carry information the form cannot keep. */
function hasPresentationData(doc: ReturnType<typeof parseDocument>): boolean {
  if (doc.commentBefore || doc.comment) return true
  let found = false
  visit(doc, {
    Node(_key, node) {
      if (isAlias(node)) {
        found = true
        return visit.BREAK
      }
      if ((isScalar(node) || isMap(node) || isSeq(node)) && (node.commentBefore || node.comment || node.anchor || node.tag)) {
        found = true
        return visit.BREAK
      }
      return undefined
    },
  })
  return found
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]))
  }
  if (isPlainObject(left) || isPlainObject(right)) {
    if (!isPlainObject(left) || !isPlainObject(right)) return false
    const keys = new Set([...Object.keys(left), ...Object.keys(right)])
    return [...keys].every((key) => sameValue(left[key], right[key]))
  }
  return left === right
}

/**
 * Reads YAML into the form only when the form can write it back without losing information.
 * Incomplete values (no models yet, an empty URL, key or default) remain readable so the form
 * can be filled in step by step; `validateModelSetupForm` decides whether it can be saved.
 * An omitted `apiKey`, `baseUrl` or `default` is read as empty, which the server treats the same way.
 */
export function readModelSetupForm(text: string): ModelSetupReading {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) return { ok: false, reason: 'invalid' }
  const root: unknown = doc.toJS()
  if (!isPlainObject(root) || Object.keys(root).some((key) => !ROOT_KEYS.has(key))) return { ok: false, reason: 'unsupported' }
  const providers = root.providers
  if (!isPlainObject(providers) || Object.keys(providers).length !== 1) return { ok: false, reason: 'unsupported' }
  const [providerId, provider] = Object.entries(providers)[0]
  if (!isPlainObject(provider) || Object.keys(provider).some((key) => !PROVIDER_KEYS.has(key))) return { ok: false, reason: 'unsupported' }
  const providerType = provider.providerType
  if (!MODEL_PROVIDER_TYPES.some((item) => item.value === providerType)) return { ok: false, reason: 'unsupported' }
  const baseUrl = provider.baseUrl ?? ''
  const apiKey = provider.apiKey ?? ''
  const models = provider.models ?? []
  const rawDefault = root.default ?? ''
  if (typeof baseUrl !== 'string' || typeof apiKey !== 'string' || typeof rawDefault !== 'string') return { ok: false, reason: 'unsupported' }
  if (!Array.isArray(models)) return { ok: false, reason: 'unsupported' }
  const formModels = models.map(readModel)
  if (formModels.some((model) => model === null)
    || new Set(formModels.map((model) => model!.id)).size !== formModels.length) {
    return { ok: false, reason: 'unsupported' }
  }
  let defaultModel = ''
  if (rawDefault) {
    if (!rawDefault.startsWith(`${providerId}/`)) return { ok: false, reason: 'unsupported' }
    defaultModel = rawDefault.slice(providerId.length + 1)
  }
  if (hasPresentationData(doc)) return { ok: false, reason: 'unsupported' }
  const form: ModelSetupForm = { providerId, providerType: providerType as ModelProviderType, baseUrl, apiKey, models: formModels as ModelSetupModel[], defaultModel }
  // Final guard: writing the form back must produce the same configuration values.
  const expected = { default: rawDefault, providers: { [providerId]: { providerType, baseUrl, apiKey, models } } }
  if (!sameValue(parseDocument(buildModelSetupYaml(form)).toJS(), expected)) return { ok: false, reason: 'unsupported' }
  return { ok: true, form }
}

export function modelIds(form: Pick<ModelSetupForm, 'models'>): string[] {
  return form.models.map((model) => model.id)
}

/**
 * Adds a model by ID. When the provider's listing declared limits for that ID, they are written
 * with it, and a model declared without image input gets `imageInput: false`. Anything undeclared
 * keeps the configured defaults.
 */
export function addModel(form: ModelSetupForm, model: string, listed: readonly ListedModel[] = []): ModelSetupForm {
  const id = model.trim()
  if (!id || form.models.some((item) => item.id === id)) return form
  const declared = listed.find((item) => item.id === id)
  const entry: ModelSetupModel = {
    id,
    ...(declared && isPositiveInteger(declared.contextLimit) ? { contextLimit: declared.contextLimit } : {}),
    ...(declared && isPositiveInteger(declared.maxOutput) ? { maxOutput: declared.maxOutput } : {}),
    ...(declared?.imageInput === false ? { imageInput: false } : {}),
  }
  return { ...form, models: [...form.models, entry], defaultModel: form.defaultModel || id }
}

export function removeModel(form: ModelSetupForm, model: string): ModelSetupForm {
  const models = form.models.filter((item) => item.id !== model)
  return { ...form, models, defaultModel: form.defaultModel === model ? models[0]?.id || '' : form.defaultModel }
}

/** Reads `/setup/models/list` entries, keeping only well-formed declared metadata. */
export function readListedModels(value: unknown): ListedModel[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: ListedModel[] = []
  for (const item of value) {
    const raw = typeof item === 'string' ? { id: item } : isPlainObject(item) ? item : null
    const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
    if (!raw || !id || seen.has(id)) continue
    seen.add(id)
    result.push({
      id,
      ...(isPositiveInteger(raw.contextLimit) ? { contextLimit: raw.contextLimit } : {}),
      ...(isPositiveInteger(raw.maxOutput) ? { maxOutput: raw.maxOutput } : {}),
      ...(typeof raw.imageInput === 'boolean' ? { imageInput: raw.imageInput } : {}),
    })
  }
  return result
}

/** Short token count for labels, such as 200K or 1M. */
export function formatTokenCount(value: number): string {
  if (value >= 1_000_000 && value % 100_000 === 0) return `${value / 1_000_000}M`
  if (value >= 1_000 && value % 1_000 === 0) return `${value / 1_000}K`
  if (value >= 1_024 && value % 1_024 === 0) return `${value / 1_024}K`
  return String(value)
}

/**
 * Known model details for display, such as "1M context · 128K output · Images"; empty when nothing
 * is known. Image support is shown only when declared or configured.
 */
export function describeModelLimits(model: Pick<ModelSetupModel, 'contextLimit' | 'maxOutput' | 'imageInput'>): string {
  return [
    model.contextLimit !== undefined ? `${formatTokenCount(model.contextLimit)} context` : '',
    model.maxOutput !== undefined ? `${formatTokenCount(model.maxOutput)} output` : '',
    model.imageInput === true ? 'Images' : model.imageInput === false ? 'Text only' : '',
  ].filter(Boolean).join(' · ')
}

/** Returns the first problem that prevents saving, written for the person filling in the form. */
export function validateModelSetupForm(form: ModelSetupForm): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(form.providerId)) {
    return 'Enter a provider name using letters, numbers, dots, dashes or underscores.'
  }
  let url: URL | null
  try {
    url = new URL(form.baseUrl.trim())
  } catch {
    url = null
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    return 'Enter the API base URL, for example https://api.openai.com/v1.'
  }
  if (isPlaceholderApiKey(form.apiKey)) return 'Replace the placeholder API key with your key.'
  if (!form.apiKey.trim() && requiresApiKey(form.baseUrl)) return 'Enter your API key.'
  if (form.models.length === 0) return 'Add at least one model.'
  if (!modelIds(form).includes(form.defaultModel)) return 'Choose a default model.'
  return null
}

export function providerConnection(form: ModelSetupForm): { providerType: string; baseUrl: string; apiKey: string } {
  return { providerType: form.providerType, baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim() }
}

export function connectionTestRequest(form: ModelSetupForm): Record<string, string> {
  return {
    providerKey: form.providerId,
    ...providerConnection(form),
    models: modelIds(form).join('\n'),
    testModel: form.defaultModel || form.models[0]?.id || '',
  }
}
