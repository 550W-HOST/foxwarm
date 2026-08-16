import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, RefreshCw, Settings, XCircle } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import { buildModelsYaml, makeDefaultProvider } from '../setupModels'
import { APP_CONFIG_YAML_MODEL_URI, MODELS_YAML_MODEL_URI } from '../yamlConfigSchemas'
import ContentHeader from './ContentHeader'
import SimpleCodeEditor from './SimpleCodeEditor'

type SetupStatus = {
  oobe: boolean
  models: {
    exists: boolean
    path: string
    templatePath: string
    providerCount: number
    defaultModel: string | null
    rawYaml?: string
    providers?: unknown[]
    hasPlaceholderSecrets: boolean
    placeholderProviders: string[]
  }
  config: {
    appConfigPath: string
    rawYaml?: string
    channelsYaml: string
    channelCount: number
  }
  channels: Array<{
    channelId: string
    type: string
    running: boolean
    configured: boolean
    enabled: boolean
    managed: boolean
    details: string[]
    lastError?: string
  }>
}

interface SetupViewProps {
  forced?: boolean
  onClose?: () => void
  onSetupChanged?: () => void
  focusModelsRequest?: number
}

const DEFAULT_MODELS_YAML = buildModelsYaml([makeDefaultProvider(0)], 'openai/gpt-5.6-sol')
const SETUP_EDITOR_HEIGHT = 'calc(min(600px, 80vh))'

const DEFAULT_CONFIG_YAML = `# Foxwarm settings.
# bot:
#   name: foxwarm
#   httpPort: 3001
#
# channels:
#   telegram:
#     type: telegram
#     enabled: true
#     botToken: "123456:telegram-token"
#     mainAttachUser: "your-telegram-user-id"
#     allowedUsers:
#       - "your-telegram-user-id"
#
#   weixin:
#     type: weixin
#     enabled: true
#     baseUrl: "https://ilinkai.weixin.qq.com"
#     token: "token-from-webui-login"
#     allowAllUsers: false
`

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${ok ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-200' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200'}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {label}
    </span>
  )
}

type SaveResult = { kind: 'success' | 'error'; message: string }
type SetupTab = 'models' | 'config'

function SaveFeedback({ section, result }: { section: 'models' | 'config'; result: SaveResult | null }) {
  if (!result) return null
  const isError = result.kind === 'error'
  return (
    <div
      role={isError ? 'alert' : 'status'}
      aria-live={isError ? 'assertive' : 'polite'}
      data-save-feedback={section}
      className={`min-w-0 basis-full break-words text-sm sm:basis-auto ${isError ? 'text-red-600 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}
    >
      {result.message}
    </div>
  )
}

function normalizeWeixinQrPayload(value: string): { imageSrc: string | null; raw: string } {
  const trimmed = value.trim()
  if (!trimmed) return { imageSrc: null, raw: '' }
  if (/^data:image\//i.test(trimmed)) return { imageSrc: trimmed, raw: trimmed }
  if (/^[A-Za-z0-9+/=\s]+$/.test(trimmed) && trimmed.replace(/\s/g, '').length > 80) {
    return { imageSrc: `data:image/png;base64,${trimmed.replace(/\s/g, '')}`, raw: trimmed }
  }
  return { imageSrc: null, raw: trimmed }
}

export default function SetupView({ forced = false, onClose, onSetupChanged, focusModelsRequest = 0 }: SetupViewProps) {
  const [activeTab, setActiveTab] = useState<SetupTab>('models')
  const [modelsEditorFocusRequest, setModelsEditorFocusRequest] = useState(0)
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [rawModelsYaml, setRawModelsYaml] = useState(DEFAULT_MODELS_YAML)
  const [configYaml, setConfigYaml] = useState(DEFAULT_CONFIG_YAML)
  const [savingModels, setSavingModels] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [modelsSaveResult, setModelsSaveResult] = useState<SaveResult | null>(null)
  const [configSaveResult, setConfigSaveResult] = useState<SaveResult | null>(null)
  const [weixinBusy, setWeixinBusy] = useState(false)
  const [weixinSessionKey, setWeixinSessionKey] = useState('')
  const [weixinQrSrc, setWeixinQrSrc] = useState('')
  const [weixinMessage, setWeixinMessage] = useState<string | null>(null)
  const modelsSectionRef = useRef<HTMLElement | null>(null)
  const modelsTabRef = useRef<HTMLButtonElement | null>(null)
  const configTabRef = useRef<HTMLButtonElement | null>(null)
  const rawModelsYamlRef = useRef(rawModelsYaml)
  const configYamlRef = useRef(configYaml)
  const modelsRevisionRef = useRef(0)
  const configRevisionRef = useRef(0)
  const modelsSaveGenerationRef = useRef(0)
  const configSaveGenerationRef = useRef(0)
  const loadGenerationRef = useRef(0)
  const handledFocusModelsRequestRef = useRef(0)

  rawModelsYamlRef.current = rawModelsYaml
  configYamlRef.current = configYaml

  const modelConfigured = !!status?.models.exists
  const channelAvailable = (status?.channels || []).some((channel) => channel.running) || true // WebUI itself is available when this page is open.
  const canLeave = !forced || (modelConfigured && channelAvailable)
  const channelRows = useMemo(() => status?.channels || [], [status])
  const configTabStatus = useMemo(() => {
    const enabledChannels = channelRows.filter((channel) => channel.enabled)
    if (enabledChannels.length === 0) return null
    return enabledChannels.some((channel) => !channel.configured || !channel.running || !!channel.lastError)
      ? 'attention'
      : 'complete'
  }, [channelRows])

  const updateModelsYaml = (nextValue: string) => {
    if (rawModelsYamlRef.current === nextValue) return
    rawModelsYamlRef.current = nextValue
    modelsRevisionRef.current += 1
    setRawModelsYaml(nextValue)
    setModelsSaveResult(null)
  }

  const updateConfigYaml = (nextValue: string) => {
    if (configYamlRef.current === nextValue) return
    configYamlRef.current = nextValue
    configRevisionRef.current += 1
    setConfigYaml(nextValue)
    setConfigSaveResult(null)
  }

  const loadStatus = async ({
    clearSaveResults = true,
    hydrateModels = true,
    hydrateConfig = true,
    expectedModelsRevision = modelsRevisionRef.current,
    expectedConfigRevision = configRevisionRef.current,
  }: {
    clearSaveResults?: boolean
    hydrateModels?: boolean
    hydrateConfig?: boolean
    expectedModelsRevision?: number
    expectedConfigRevision?: number
  } = {}) => {
    const loadGeneration = ++loadGenerationRef.current
    if (clearSaveResults) {
      modelsSaveGenerationRef.current += 1
      configSaveGenerationRef.current += 1
      setSavingModels(false)
      setSavingConfig(false)
      setModelsSaveResult(null)
      setConfigSaveResult(null)
    }
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/setup/status`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to load setup status (${res.status})`)
      if (loadGeneration !== loadGenerationRef.current) return
      setStatus(data)
      if (hydrateModels && modelsRevisionRef.current === expectedModelsRevision && typeof data?.models?.rawYaml === 'string' && data.models.rawYaml.trim()) {
        updateModelsYaml(data.models.rawYaml)
      }
      if (hydrateConfig && configRevisionRef.current === expectedConfigRevision) {
        if (typeof data?.config?.rawYaml === 'string') {
          updateConfigYaml(data.config.rawYaml.trim() ? data.config.rawYaml : DEFAULT_CONFIG_YAML)
        } else if (typeof data?.config?.channelsYaml === 'string') {
          updateConfigYaml(data.config.channelsYaml.trim() ? data.config.channelsYaml : DEFAULT_CONFIG_YAML)
        }
      }
    } catch (err) {
      if (loadGeneration === loadGenerationRef.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (loadGeneration === loadGenerationRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    void loadStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (focusModelsRequest <= 0) return
    setActiveTab('models')
  }, [focusModelsRequest])

  useEffect(() => {
    if (focusModelsRequest <= 0 || activeTab !== 'models') return
    if (handledFocusModelsRequestRef.current === focusModelsRequest) return
    handledFocusModelsRequestRef.current = focusModelsRequest
    setModelsEditorFocusRequest((current) => current + 1)
    const frame = requestAnimationFrame(() => modelsSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }))
    return () => cancelAnimationFrame(frame)
  }, [activeTab, focusModelsRequest])

  const activateTab = (tab: SetupTab, focus = false) => {
    setActiveTab(tab)
    if (focus) requestAnimationFrame(() => (tab === 'models' ? modelsTabRef.current : configTabRef.current)?.focus())
  }

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const nextTab = event.key === 'Home'
      ? 'models'
      : event.key === 'End'
        ? 'config'
        : activeTab === 'models' ? 'config' : 'models'
    activateTab(nextTab, true)
  }

  const saveModels = async () => {
    const saveGeneration = ++modelsSaveGenerationRef.current
    const submittedRevision = modelsRevisionRef.current
    const submittedYaml = rawModelsYamlRef.current
    setSavingModels(true)
    setModelsSaveResult(null)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/setup/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: submittedYaml }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to save models (${res.status})`)
      if (saveGeneration !== modelsSaveGenerationRef.current) return
      const submissionIsCurrent = modelsRevisionRef.current === submittedRevision && rawModelsYamlRef.current === submittedYaml
      if (submissionIsCurrent) {
        setModelsSaveResult({ kind: 'success', message: 'Models saved.' })
      }
      await loadStatus({ clearSaveResults: false, hydrateConfig: false, expectedModelsRevision: submittedRevision })
      onSetupChanged?.()
    } catch (err) {
      if (saveGeneration === modelsSaveGenerationRef.current
        && modelsRevisionRef.current === submittedRevision
        && rawModelsYamlRef.current === submittedYaml) {
        setModelsSaveResult({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      if (saveGeneration === modelsSaveGenerationRef.current) setSavingModels(false)
    }
  }

  const saveConfig = async () => {
    const saveGeneration = ++configSaveGenerationRef.current
    const submittedRevision = configRevisionRef.current
    const submittedYaml = configYamlRef.current
    setSavingConfig(true)
    setConfigSaveResult(null)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/setup/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: submittedYaml }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to save config (${res.status})`)
      if (saveGeneration !== configSaveGenerationRef.current) return
      const submissionIsCurrent = configRevisionRef.current === submittedRevision && configYamlRef.current === submittedYaml
      if (submissionIsCurrent) {
        const startedChannels = (data.reload?.started || []).join(', ')
        setConfigSaveResult({ kind: 'success', message: startedChannels ? `Config saved. Active channels refreshed: ${startedChannels}.` : 'Config saved.' })
        if (typeof data.rawYaml === 'string') updateConfigYaml(data.rawYaml)
      }
      await loadStatus({ clearSaveResults: false, hydrateModels: false, expectedConfigRevision: submittedRevision })
      onSetupChanged?.()
    } catch (err) {
      if (saveGeneration === configSaveGenerationRef.current
        && configRevisionRef.current === submittedRevision
        && configYamlRef.current === submittedYaml) {
        setConfigSaveResult({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
      }
    } finally {
      if (saveGeneration === configSaveGenerationRef.current) setSavingConfig(false)
    }
  }

  const startWeixinLogin = async () => {
    setWeixinBusy(true)
    setWeixinMessage(null)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/setup/weixin/login/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to start Weixin login (${res.status})`)
      setWeixinSessionKey(data.sessionKey || '')
      const rawQr = data.qrcodeUrl || ''
      const normalized = normalizeWeixinQrPayload(rawQr)
      if (normalized.imageSrc) {
        setWeixinQrSrc(normalized.imageSrc)
      } else if (normalized.raw) {
        const qrcode = await import('qrcode')
        setWeixinQrSrc(await qrcode.toDataURL(normalized.raw, { margin: 1, width: 256 }))
      } else {
        setWeixinQrSrc('')
      }
      setWeixinMessage('Scan the QR code with Weixin, then click Check login.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWeixinBusy(false)
    }
  }

  const waitWeixinLogin = async () => {
    if (!weixinSessionKey) return
    setWeixinBusy(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/setup/weixin/login/wait`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionKey: weixinSessionKey }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to check Weixin login (${res.status})`)
      setWeixinMessage(data.connected
        ? `Connected as ${data.userId || 'Weixin user'}. Channel config saved and reloaded.`
        : 'Login is not confirmed yet. Scan the QR code, then click Check login again.')
      if (data.connected) {
        await loadStatus()
        onSetupChanged?.()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWeixinBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-gray-50 dark:bg-gray-950">
      <ContentHeader
        icon={<Settings className="h-5 w-5" />}
        title={forced ? 'Foxwarm first-time setup' : 'Foxwarm Setup'}
        subtitle={forced ? 'Add your model settings to continue.' : 'Manage models, channels, and app settings.'}
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void loadStatus()}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
            >
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
            {!forced && onClose && (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-gray-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"
              >
                Close
              </button>
            )}
          </div>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto max-w-5xl">
          {loading && <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">Loading setup status…</div>}
          {error && <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">{error}</div>}

          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="border-b border-gray-200 px-2 pt-2 dark:border-gray-800">
              <div role="tablist" aria-label="Setup sections" className="flex gap-1">
                <button
                  ref={modelsTabRef}
                  id="setup-tab-models"
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'models'}
                  aria-controls="setup-panel-models"
                  tabIndex={activeTab === 'models' ? 0 : -1}
                  data-setup-tab="models"
                  onClick={() => activateTab('models')}
                  onKeyDown={handleTabKeyDown}
                  className={`inline-flex min-w-0 items-center gap-2 rounded-t-lg border-b-2 px-4 py-3 text-sm font-medium transition-colors ${activeTab === 'models' ? 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300' : 'border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white'}`}
                >
                  <span>Models</span>
                  {status && (status.models.exists && !status.models.hasPlaceholderSecrets ? (
                    <CheckCircle2 data-setup-tab-status="complete" className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />
                  ) : (
                    <XCircle data-setup-tab-status="attention" className="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-300" aria-hidden="true" />
                  ))}
                  {status && <span className="sr-only">{status.models.exists && !status.models.hasPlaceholderSecrets ? 'Configured' : 'Needs attention'}</span>}
                </button>
                <button
                  ref={configTabRef}
                  id="setup-tab-config"
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'config'}
                  aria-controls="setup-panel-config"
                  tabIndex={activeTab === 'config' ? 0 : -1}
                  data-setup-tab="config"
                  onClick={() => activateTab('config')}
                  onKeyDown={handleTabKeyDown}
                  className={`inline-flex min-w-0 items-center gap-2 rounded-t-lg border-b-2 px-4 py-3 text-sm font-medium transition-colors ${activeTab === 'config' ? 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300' : 'border-transparent text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-white'}`}
                >
                  <span>Config</span>
                  {configTabStatus === 'complete' && <CheckCircle2 data-setup-tab-status="complete" className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" aria-hidden="true" />}
                  {configTabStatus === 'attention' && <XCircle data-setup-tab-status="attention" className="h-4 w-4 shrink-0 text-amber-500 dark:text-amber-300" aria-hidden="true" />}
                  {configTabStatus && <span className="sr-only">{configTabStatus === 'complete' ? 'Channels ready' : 'Channels need attention'}</span>}
                </button>
              </div>
            </div>

            <section ref={modelsSectionRef} id="setup-panel-models" role="tabpanel" aria-labelledby="setup-tab-models" data-setup-section="models" hidden={activeTab !== 'models'} className="scroll-mt-4 p-4 md:p-5">
              <div>
                <h2 className="text-base font-semibold text-gray-900 dark:text-white">Model settings</h2>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Configure model providers, routing, and your default model in YAML.</p>
              </div>

              <div className="mt-4">
                <SimpleCodeEditor
                  value={rawModelsYaml}
                  onChange={updateModelsYaml}
                  language="yaml"
                  height={SETUP_EDITOR_HEIGHT}
                  modelUri={MODELS_YAML_MODEL_URI}
                  focusRequest={modelsEditorFocusRequest}
                  ariaLabel="Models YAML editor"
                />
              </div>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button disabled={savingModels} onClick={() => void saveModels()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">{savingModels ? 'Saving…' : 'Save models'}</button>
                <SaveFeedback section="models" result={modelsSaveResult} />
                {forced && !canLeave && <span className="text-sm text-amber-600 dark:text-amber-300">Save a valid model configuration to continue.</span>}
              </div>
            </section>

            <section id="setup-panel-config" role="tabpanel" aria-labelledby="setup-tab-config" data-setup-section="config" hidden={activeTab !== 'config'} className="p-4 md:p-5">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">App and channel settings</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Manage Foxwarm and channel settings in YAML.</p>

              <div className="mt-4">
                <SimpleCodeEditor value={configYaml} onChange={updateConfigYaml} language="yaml" height={SETUP_EDITOR_HEIGHT} modelUri={APP_CONFIG_YAML_MODEL_URI} ariaLabel="Application config YAML editor" />
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button disabled={savingConfig} onClick={() => void saveConfig()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">{savingConfig ? 'Saving…' : 'Save config'}</button>
                <SaveFeedback section="config" result={configSaveResult} />
              </div>
              {channelRows.length > 0 && (
                <div className="mt-4 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
                  {channelRows.map((channel) => (
                    <div key={channel.channelId} className="border-t border-gray-100 px-3 py-2 text-sm first:border-t-0 dark:border-gray-800">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-white">{channel.channelId}</span>
                        <span className="text-gray-500 dark:text-gray-400">{channel.type}</span>
                        <StatusPill ok={channel.running} label={channel.running ? 'Running' : 'Stopped'} />
                        <StatusPill ok={channel.configured} label={channel.configured ? 'Configured' : 'Needs setup'} />
                      </div>
                      {channel.lastError && <div className="mt-1 text-xs text-red-600 dark:text-red-300">{channel.lastError}</div>}
                    </div>
                  ))}
                </div>
              )}

              <div data-setup-config-last="weixin" className="mt-6 border-t border-gray-200 pt-5 dark:border-gray-800">
                <h3 className="font-medium text-gray-900 dark:text-white">Weixin login</h3>
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Connect Weixin by scanning a QR code.</p>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button disabled={weixinBusy} onClick={() => void startWeixinLogin()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">{weixinBusy ? 'Working…' : 'Start Weixin login'}</button>
                  <button disabled={weixinBusy || !weixinSessionKey} onClick={() => void waitWeixinLogin()} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">Check login</button>
                </div>
                {weixinMessage && <div className="mt-3 text-sm text-gray-600 dark:text-gray-300">{weixinMessage}</div>}
                {weixinQrSrc && <img src={weixinQrSrc} alt="Weixin login QR code" className="mt-4 h-56 w-56 rounded-lg border border-gray-200 bg-white object-contain p-2 dark:border-gray-700" />}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
