import { useEffect, useId, useRef, useState } from 'react'
import { CheckCircle2, Download, Eye, EyeOff, Plus, X } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import {
  addModel,
  connectionTestRequest,
  describeModelLimits,
  formFromPreset,
  isPlaceholderApiKey,
  MODEL_PROVIDER_TYPES,
  modelIds,
  presetFor,
  PROVIDER_PRESETS,
  providerConnection,
  readListedModels,
  removeModel,
  requiresApiKey,
  type ListedModel,
  type ModelProviderType,
  type ModelSetupForm,
} from '../setupModels'

const inputClass = 'mt-1 w-full rounded-lg border border-fw-border-strong bg-fw-surface px-3 py-2 text-sm text-fw-text-strong outline-none focus:border-fw-accent-border focus:ring-2 focus:ring-fw-focus-ring/20 disabled:opacity-70 dark:border-fw-border-strong dark:bg-fw-surface dark:text-fw-text-strong'
const labelClass = 'block text-sm font-medium text-fw-text-strong'
const hintClass = 'mt-1 text-xs text-fw-text-muted'
const secondaryButtonClass = 'inline-flex items-center gap-1.5 rounded-lg border border-fw-border px-3 py-2 text-sm font-medium text-fw-text hover:bg-fw-hover disabled:cursor-not-allowed disabled:opacity-50 dark:border-fw-border dark:text-fw-text-strong dark:hover:bg-fw-hover'

type Feedback = { kind: 'success' | 'error' | 'progress'; message: string }

function FeedbackLine({ feedback, name }: { feedback: Feedback | null; name: string }) {
  if (!feedback) return null
  const tone = feedback.kind === 'error' ? 'text-fw-danger' : feedback.kind === 'success' ? 'text-fw-success' : 'text-fw-text-muted'
  return <p role={feedback.kind === 'error' ? 'alert' : 'status'} data-model-setup-feedback={name} className={`mt-2 break-words text-sm ${tone}`}>
    {feedback.kind === 'success' && <CheckCircle2 className="mr-1 inline h-4 w-4 align-text-bottom" aria-hidden="true" />}
    {feedback.message}
  </p>
}

async function postJson(path: string, body: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(`${API_BASE_PATH}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok || data.success === false) {
    throw new Error(typeof data.error === 'string' && data.error ? data.error : `Request failed (${response.status}).`)
  }
  return data
}

interface ModelSetupFormPanelProps {
  form: ModelSetupForm
  onChange: (form: ModelSetupForm) => void
  focusRequest?: number
}

/** First-provider model form. Every change is written back to models YAML by the owner. */
export default function ModelSetupFormPanel({ form, onChange, focusRequest = 0 }: ModelSetupFormPanelProps) {
  const id = useId()
  const preset = presetFor(form)
  const keyRequired = requiresApiKey(form.baseUrl)
  const [showKey, setShowKey] = useState(false)
  const [modelDraft, setModelDraft] = useState('')
  const [availableModels, setAvailableModels] = useState<ListedModel[]>([])
  const [listFeedback, setListFeedback] = useState<Feedback | null>(null)
  const [testFeedback, setTestFeedback] = useState<Feedback | null>(null)
  const listAbort = useRef<AbortController | null>(null)
  const testAbort = useRef<AbortController | null>(null)
  const serviceRef = useRef<HTMLSelectElement | null>(null)
  const connectionKey = JSON.stringify(providerConnection(form))

  // Listed models and test results describe one connection; a changed connection retires them.
  useEffect(() => {
    listAbort.current?.abort()
    testAbort.current?.abort()
    setAvailableModels([])
    setListFeedback(null)
    setTestFeedback(null)
  }, [connectionKey])

  useEffect(() => () => {
    listAbort.current?.abort()
    testAbort.current?.abort()
  }, [])

  useEffect(() => {
    if (focusRequest > 0) serviceRef.current?.focus({ preventScroll: true })
  }, [focusRequest])

  const update = (patch: Partial<ModelSetupForm>) => {
    setTestFeedback(null)
    onChange({ ...form, ...patch })
  }

  const loadModels = async () => {
    listAbort.current?.abort()
    const controller = new AbortController()
    listAbort.current = controller
    setListFeedback({ kind: 'progress', message: 'Loading models…' })
    try {
      const data = await postJson('/setup/models/list', providerConnection(form), controller.signal)
      if (controller.signal.aborted) return
      const models = readListedModels(data.models)
      setAvailableModels(models)
      setListFeedback(models.length > 0
        ? { kind: 'success', message: `${models.length} model${models.length === 1 ? '' : 's'} available. Pick one below.` }
        : { kind: 'error', message: 'The service returned no models. Enter a model ID instead.' })
    } catch (error) {
      if (controller.signal.aborted) return
      setListFeedback({ kind: 'error', message: `${error instanceof Error ? error.message : String(error)} You can still enter a model ID.` })
    }
  }

  const testConnection = async () => {
    testAbort.current?.abort()
    if (form.models.length === 0) {
      setTestFeedback({ kind: 'error', message: 'Add a model to test.' })
      return
    }
    const controller = new AbortController()
    testAbort.current = controller
    const request = connectionTestRequest(form)
    setTestFeedback({ kind: 'progress', message: `Sending a short test message to ${request.testModel}…` })
    try {
      await postJson('/setup/models/test', request, controller.signal)
      if (!controller.signal.aborted) setTestFeedback({ kind: 'success', message: `Connected. ${request.testModel} replied.` })
    } catch (error) {
      if (!controller.signal.aborted) setTestFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
    }
  }

  const commitModelDraft = () => {
    const next = addModel(form, modelDraft, availableModels)
    setModelDraft('')
    if (next !== form) update(next)
  }

  const selectedIds = modelIds(form)
  const suggestions = availableModels.filter((model) => !selectedIds.includes(model.id))

  return (
    <div data-model-setup-form className="w-full max-w-2xl space-y-5">
      <div>
        <label className={labelClass} htmlFor={`${id}-service`}>Service</label>
        <select
          ref={serviceRef}
          id={`${id}-service`}
          data-model-setup-field="service"
          value={preset.id}
          onChange={(event) => {
            setShowKey(false)
            onChange({ ...formFromPreset(event.target.value), ...(event.target.value === 'custom' ? { providerType: form.providerType } : {}) })
          }}
          className={inputClass}
        >
          {PROVIDER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        {preset.id === 'ollama' && <p className={hintClass}>Uses Ollama on the machine where Foxwarm is installed.</p>}
      </div>

      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor={`${id}-type`}>API type</label>
          <select
            id={`${id}-type`}
            data-model-setup-field="providerType"
            value={form.providerType}
            onChange={(event) => update({ providerType: event.target.value as ModelProviderType })}
            className={inputClass}
          >
            {MODEL_PROVIDER_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </div>
        <div>
          <label className={labelClass} htmlFor={`${id}-name`}>Provider name</label>
          <input
            id={`${id}-name`}
            data-model-setup-field="providerId"
            type="text"
            value={form.providerId}
            spellCheck={false}
            onChange={(event) => update({ providerId: event.target.value.trim() })}
            className={inputClass}
          />
          <p className={hintClass}>Shown before model names, such as {form.providerId || 'openai'}/{form.defaultModel || form.models[0]?.id || 'model'}.</p>
        </div>
      </div>

      <div>
        <label className={labelClass} htmlFor={`${id}-url`}>API base URL</label>
        <input
          id={`${id}-url`}
          data-model-setup-field="baseUrl"
          type="url"
          inputMode="url"
          value={form.baseUrl}
          placeholder="https://api.example.com/v1"
          spellCheck={false}
          onChange={(event) => update({ baseUrl: event.target.value })}
          className={inputClass}
        />
      </div>

      <div>
        <label className={labelClass} htmlFor={`${id}-key`}>API key</label>
        <div className="flex items-start gap-2">
          <input
            id={`${id}-key`}
            data-model-setup-field="apiKey"
            type={showKey ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            value={isPlaceholderApiKey(form.apiKey) ? '' : form.apiKey}
            placeholder={keyRequired ? 'Paste your API key' : 'Optional'}
            onChange={(event) => update({ apiKey: event.target.value.trim() })}
            className={inputClass}
          />
          <button type="button" className={`${secondaryButtonClass} mt-1 shrink-0`} aria-pressed={showKey} aria-label={showKey ? 'Hide API key' : 'Show API key'} onClick={() => setShowKey((value) => !value)}>
            {showKey ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
        <p className={hintClass}>{keyRequired ? 'Required for this service. It is stored in your models.yaml on the server.' : 'Leave empty if your server doesn’t need one.'}</p>
      </div>

      <fieldset>
        <legend className={labelClass}>Models</legend>
        {form.models.length > 0 ? (
          <ul aria-label="Selected models" className="mt-2 flex flex-wrap gap-2">
            {form.models.map((model) => {
              const limits = describeModelLimits(model)
              return (
              <li key={model.id} data-model-setup-model={model.id} className="inline-flex max-w-full items-center gap-1 rounded-full border border-fw-border-muted bg-fw-surface-sunken py-1 pl-3 pr-1 text-sm text-fw-text-strong">
                <span className="truncate">{model.id}</span>
                {limits && <span data-model-setup-limits className="shrink-0 text-xs text-fw-text-muted">{limits}</span>}
                <button type="button" aria-label={`Remove ${model.id}`} onClick={() => update(removeModel(form, model.id))} className="rounded-full p-1 text-fw-text-muted hover:bg-fw-hover hover:text-fw-text-strong">
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </li>
              )
            })}
          </ul>
        ) : <p className="mt-1 text-sm text-fw-text-muted">No models yet. Load the list from the service or enter a model ID.</p>}
        <div className="mt-3 flex flex-wrap items-start gap-2">
          <div className="min-w-[12rem] flex-1">
            <label className="sr-only" htmlFor={`${id}-model`}>Model ID</label>
            <input
              id={`${id}-model`}
              data-model-setup-field="model"
              type="text"
              list={`${id}-available`}
              value={modelDraft}
              placeholder={suggestions.length > 0 ? 'Search or enter a model ID' : 'Model ID'}
              spellCheck={false}
              onChange={(event) => setModelDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                commitModelDraft()
              }}
              className={`${inputClass} !mt-0`}
            />
            <datalist id={`${id}-available`}>
              {suggestions.map((model) => <option key={model.id} value={model.id} label={describeModelLimits(model) || undefined} />)}
            </datalist>
          </div>
          <button type="button" disabled={!modelDraft.trim()} onClick={commitModelDraft} className={secondaryButtonClass}><Plus className="h-4 w-4" aria-hidden="true" />Add</button>
          <button type="button" disabled={!form.baseUrl.trim() || listFeedback?.kind === 'progress'} onClick={() => void loadModels()} className={secondaryButtonClass}><Download className="h-4 w-4" aria-hidden="true" />Load models</button>
        </div>
        <FeedbackLine feedback={listFeedback} name="list" />
      </fieldset>

      <div>
        <label className={labelClass} htmlFor={`${id}-default`}>Default model</label>
        <select
          id={`${id}-default`}
          data-model-setup-field="defaultModel"
          value={form.defaultModel}
          disabled={form.models.length === 0}
          onChange={(event) => update({ defaultModel: event.target.value })}
          className={inputClass}
        >
          {!selectedIds.includes(form.defaultModel) && <option value={form.defaultModel}>Choose a model</option>}
          {selectedIds.map((model) => <option key={model} value={model}>{model}</option>)}
        </select>
        <p className={hintClass}>New conversations use this model. You can switch models in any chat.</p>
      </div>

      <div className="border-t border-fw-border-muted pt-4">
        <button type="button" disabled={testFeedback?.kind === 'progress'} onClick={() => void testConnection()} className={secondaryButtonClass}>Test connection</button>
        <FeedbackLine feedback={testFeedback} name="test" />
      </div>
    </div>
  )
}
