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

const DEFAULT_CONFIG_YAML = `# Foxwarm config. Changes to channels are hot-reloaded after Save.
# Other settings may require a process restart to take effect.
#
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
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [rawModelsYaml, setRawModelsYaml] = useState(DEFAULT_MODELS_YAML)
  const [configYaml, setConfigYaml] = useState(DEFAULT_CONFIG_YAML)
  const [savingModels, setSavingModels] = useState(false)
  const [savingConfig, setSavingConfig] = useState(false)
  const [weixinBusy, setWeixinBusy] = useState(false)
  const [weixinSessionKey, setWeixinSessionKey] = useState('')
  const [weixinQrSrc, setWeixinQrSrc] = useState('')
  const [weixinRawPairingUrl, setWeixinRawPairingUrl] = useState('')
  const [weixinMessage, setWeixinMessage] = useState<string | null>(null)
  const modelsSectionRef = useRef<HTMLElement | null>(null)

  const modelConfigured = !!status?.models.exists
  const channelAvailable = (status?.channels || []).some((channel) => channel.running) || true // WebUI itself is available when this page is open.
  const canLeave = !forced || (modelConfigured && channelAvailable)
  const channelRows = useMemo(() => status?.channels || [], [status])

  const loadStatus = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/setup/status`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to load setup status (${res.status})`)
      setStatus(data)
      if (typeof data?.models?.rawYaml === 'string' && data.models.rawYaml.trim()) {
        setRawModelsYaml(data.models.rawYaml)
      }
      if (typeof data?.config?.rawYaml === 'string') {
        setConfigYaml(data.config.rawYaml.trim() ? data.config.rawYaml : DEFAULT_CONFIG_YAML)
      } else if (typeof data?.config?.channelsYaml === 'string') {
        setConfigYaml(data.config.channelsYaml.trim() ? data.config.channelsYaml : DEFAULT_CONFIG_YAML)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadStatus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (focusModelsRequest <= 0) return
    modelsSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [focusModelsRequest])

  const saveModels = async () => {
    setSavingModels(true)
    setMessage(null)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/setup/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: rawModelsYaml }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to save models (${res.status})`)
      setRawModelsYaml(rawModelsYaml)
      setMessage(`Models saved to ${data.models?.path || 'state/models.yaml'}.`)
      await loadStatus()
      onSetupChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingModels(false)
    }
  }

  const saveConfig = async () => {
    setSavingConfig(true)
    setMessage(null)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/setup/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: configYaml }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to save config (${res.status})`)
      setMessage(`Config saved. Channels reloaded; started: ${(data.reload?.started || []).join(', ') || 'none'}.`)
      if (typeof data.rawYaml === 'string') setConfigYaml(data.rawYaml)
      await loadStatus()
      onSetupChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingConfig(false)
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
      setWeixinRawPairingUrl(rawQr)
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
        subtitle={forced ? 'Configure models before using Foxwarm. This setup cannot be closed yet.' : 'Models and channels can be updated here without restarting.'}
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
        <div className="mx-auto max-w-5xl space-y-4">
          {loading && <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300">Loading setup status…</div>}
          {message && <div className="rounded-xl border border-green-200 bg-green-50 p-4 text-sm text-green-700 dark:border-green-900/60 dark:bg-green-950/30 dark:text-green-200">{message}</div>}
          {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200">{error}</div>}

          <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">Setup checklist</h2>
              <StatusPill ok={!!status?.models.exists} label={status?.models.exists ? 'models configured' : 'models missing'} />
              <StatusPill ok={true} label="WebUI available" />
              {status?.models.hasPlaceholderSecrets && <StatusPill ok={false} label="placeholder API key detected" />}
            </div>
            <p className="text-sm text-gray-600 dark:text-gray-300">
              OOBE mode is active when <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">state/models.yaml</code> does not exist.
              After saving models, you can ask the agent how to explore Foxwarm. The raw config editor below preserves the current <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">state/config.yaml</code> text.
            </p>
            {status && (
              <div className="mt-3 grid gap-2 text-xs text-gray-500 dark:text-gray-400 md:grid-cols-2">
                <div>Models path: <code>{status.models.path}</code></div>
                <div>Config path: <code>{status.config.appConfigPath}</code></div>
              </div>
            )}
          </section>

          <section ref={modelsSectionRef} data-setup-section="models" className="scroll-mt-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">Models</h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Edit <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">state/models.yaml</code> as raw YAML. Schema suggestions and diagnostics are advisory; Save always uses the backend's canonical validator and preserves your text exactly.</p>
            </div>

            <div className="mt-4">
              <SimpleCodeEditor
                value={rawModelsYaml}
                onChange={setRawModelsYaml}
                language="yaml"
                height={SETUP_EDITOR_HEIGHT}
                modelUri={MODELS_YAML_MODEL_URI}
                focusRequest={focusModelsRequest}
                ariaLabel="Models YAML editor"
              />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <button disabled={savingModels} onClick={() => void saveModels()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">{savingModels ? 'Saving…' : 'Save models'}</button>
              {forced && !canLeave && <span className="text-sm text-amber-600 dark:text-amber-300">Required for first-time setup.</span>}
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Config / Channels</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Edit the full <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">state/config.yaml</code> file as raw YAML. Saving writes your text back directly, then hot-reloads managed channels without restarting Foxwarm.</p>

            <div className="mt-4 rounded-xl border border-gray-200 p-4 dark:border-gray-700">
              <h3 className="font-medium text-gray-900 dark:text-white">Weixin login</h3>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Start Weixin pairing from WebUI, scan the QR code, then check login. On success, Setup writes the Weixin channel config below and hot-reloads channels.</p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button disabled={weixinBusy} onClick={() => void startWeixinLogin()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">{weixinBusy ? 'Working…' : 'Start Weixin login'}</button>
                <button disabled={weixinBusy || !weixinSessionKey} onClick={() => void waitWeixinLogin()} className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800">Check login</button>
              </div>
              {weixinMessage && <div className="mt-3 text-sm text-gray-600 dark:text-gray-300">{weixinMessage}</div>}
              {weixinQrSrc && (
                <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-start">
                  <img src={weixinQrSrc} alt="Weixin login QR code" className="h-56 w-56 rounded-lg border border-gray-200 bg-white object-contain p-2 dark:border-gray-700" />
                  <div className="min-w-0 text-xs text-gray-500 dark:text-gray-400">
                    <div>sessionKey: <code>{weixinSessionKey}</code></div>
                    {weixinRawPairingUrl && <div className="break-all">pairing URL: {weixinRawPairingUrl}</div>}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-4">
              <SimpleCodeEditor value={configYaml} onChange={setConfigYaml} language="yaml" height={SETUP_EDITOR_HEIGHT} modelUri={APP_CONFIG_YAML_MODEL_URI} ariaLabel="Application config YAML editor" />
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button disabled={savingConfig} onClick={() => void saveConfig()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">{savingConfig ? 'Saving…' : 'Save config and reload channels'}</button>
            </div>
            {channelRows.length > 0 && (
              <div className="mt-4 overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
                {channelRows.map((channel) => (
                  <div key={channel.channelId} className="border-t border-gray-100 px-3 py-2 text-sm first:border-t-0 dark:border-gray-800">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-medium text-gray-900 dark:text-white">{channel.channelId}</span>
                      <span className="text-gray-500 dark:text-gray-400">type={channel.type}</span>
                      <StatusPill ok={channel.running} label={channel.running ? 'running' : 'stopped'} />
                      <StatusPill ok={channel.configured} label={channel.configured ? 'configured' : 'missing config'} />
                    </div>
                    {channel.lastError && <div className="mt-1 text-xs text-red-600 dark:text-red-300">{channel.lastError}</div>}
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
