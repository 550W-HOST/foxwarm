import { useEffect, useMemo, useState } from 'react'
import { CheckCircle2, RefreshCw, Settings, XCircle } from 'lucide-react'
import { API_BASE_PATH } from '../config'
import ContentHeader from './ContentHeader'

type SetupStatus = {
  oobe: boolean
  models: {
    exists: boolean
    path: string
    templatePath: string
    providerCount: number
    defaultModel: string | null
    hasPlaceholderSecrets: boolean
    placeholderProviders: string[]
  }
  config: {
    appConfigPath: string
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
}

const DEFAULT_CHANNELS_YAML = `# Configure channels here. Changes are hot-reloaded after Save.
# Example Telegram channel:
# telegram:
#   type: telegram
#   enabled: true
#   botToken: "123456:telegram-token"
#   mainAttachUser: "your-telegram-user-id"
#   allowedUsers:
#     - "your-telegram-user-id"
#
# Example Weixin channel:
# weixin:
#   type: weixin
#   enabled: true
#   baseUrl: "https://ilinkai.weixin.qq.com"
#   token: "token-from-/weixin-login"
#   allowAllUsers: false
`

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ${ok ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-200' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-200'}`}>
      {ok ? <CheckCircle2 className="h-3.5 w-3.5" /> : <XCircle className="h-3.5 w-3.5" />}
      {label}
    </span>
  )
}

export default function SetupView({ forced = false, onClose, onSetupChanged }: SetupViewProps) {
  const [status, setStatus] = useState<SetupStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [providerKey, setProviderKey] = useState('openai')
  const [providerType, setProviderType] = useState('openai-completions')
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1')
  const [apiKey, setApiKey] = useState('')
  const [models, setModels] = useState('gpt-5.2-codex')
  const [defaultModel, setDefaultModel] = useState('gpt-5.2-codex')
  const [channelsYaml, setChannelsYaml] = useState(DEFAULT_CHANNELS_YAML)
  const [savingModels, setSavingModels] = useState(false)
  const [savingChannels, setSavingChannels] = useState(false)

  const modelConfigured = !!status?.models.exists
  const channelAvailable = (status?.channels || []).some((channel) => channel.running) || true // WebUI itself is available when this page is open.
  const canLeave = !forced || (modelConfigured && channelAvailable)

  const loadStatus = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/setup/status`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to load setup status (${res.status})`)
      setStatus(data)
      if (typeof data?.config?.channelsYaml === 'string') {
        setChannelsYaml(data.config.channelsYaml.trim() ? data.config.channelsYaml : DEFAULT_CHANNELS_YAML)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadStatus()
  }, [])

  const saveModels = async () => {
    setSavingModels(true)
    setMessage(null)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/setup/models`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ providerKey, providerType, baseUrl, apiKey, models, defaultModel }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to save models (${res.status})`)
      setMessage(`Models saved to ${data.models?.path || 'state/models.yaml'}.`)
      await loadStatus()
      onSetupChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingModels(false)
    }
  }

  const saveChannels = async () => {
    setSavingChannels(true)
    setMessage(null)
    setError(null)
    try {
      const res = await fetch(`${API_BASE_PATH}/setup/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ yaml: channelsYaml }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Failed to save channels (${res.status})`)
      setMessage(`Channels saved and reloaded. Started: ${(data.reload?.started || []).join(', ') || 'none'}.`)
      if (typeof data.channelsYaml === 'string') setChannelsYaml(data.channelsYaml)
      await loadStatus()
      onSetupChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSavingChannels(false)
    }
  }

  const channelRows = useMemo(() => status?.channels || [], [status])

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
              After saving models, you can ask the agent how to explore Foxwarm. Channels can be edited and hot-reloaded below.
            </p>
            {status && (
              <div className="mt-3 grid gap-2 text-xs text-gray-500 dark:text-gray-400 md:grid-cols-2">
                <div>Models path: <code>{status.models.path}</code></div>
                <div>Config path: <code>{status.config.appConfigPath}</code></div>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Models</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Create <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">state/models.yaml</code>. For OpenAI-compatible providers, set provider type to <code>openai-completions</code> or <code>openai-responses</code>.</p>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">Provider key
                <input value={providerKey} onChange={(e) => setProviderKey(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100" />
              </label>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">Provider type
                <select value={providerType} onChange={(e) => setProviderType(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100">
                  <option value="openai-completions">openai-completions</option>
                  <option value="openai-responses">openai-responses</option>
                  <option value="openai">openai</option>
                  <option value="anthropic">anthropic</option>
                </select>
              </label>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">Base URL
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100" />
              </label>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">API key
                <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100" />
              </label>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">Models (comma or newline separated)
                <textarea value={models} onChange={(e) => setModels(e.target.value)} rows={4} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100" />
              </label>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">Default model id
                <input value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100" />
              </label>
            </div>
            <div className="mt-4 flex items-center gap-2">
              <button disabled={savingModels} onClick={() => void saveModels()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">{savingModels ? 'Saving…' : 'Save models'}</button>
              {forced && !canLeave && <span className="text-sm text-amber-600 dark:text-amber-300">Required for first-time setup.</span>}
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <h2 className="text-base font-semibold text-gray-900 dark:text-white">Channels</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Edit channel config from <code className="rounded bg-gray-100 px-1 dark:bg-gray-800">state/config.yaml</code>. Saving stops and starts managed channels without restarting Foxwarm.</p>
            <textarea value={channelsYaml} onChange={(e) => setChannelsYaml(e.target.value)} rows={14} className="mt-4 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-sm dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100" />
            <div className="mt-4 flex items-center gap-2">
              <button disabled={savingChannels} onClick={() => void saveChannels()} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-60">{savingChannels ? 'Saving…' : 'Save channels and reload'}</button>
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
