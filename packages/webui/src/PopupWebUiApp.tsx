import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import Chat from './components/Chat'
import TerminalView from './components/TerminalView'
import { API_BASE_PATH } from './config'
import { readEmbeddedSessionLink } from './embeddedWebUi'
import { makeFoxwarmPopupUrl, type FoxwarmPopupTarget } from './popupWebUi'
import { useChatPreferences } from './chatPreferences'
import { useTheme } from './theme/useTheme'
import { makeVscodeWebUrl, type CodeCommitTarget } from './vscodeWeb'

const ArchitectureView = lazy(() => import('./components/ArchitectureView'))
const SetupView = lazy(() => import('./components/SetupView'))

type WebUiSettings = { instanceName: string; tabIcon: string }

function normalizeSettings(value: unknown): WebUiSettings {
  const raw = value && typeof value === 'object' ? value as Partial<WebUiSettings> : {}
  return {
    instanceName: typeof raw.instanceName === 'string' ? raw.instanceName : '',
    tabIcon: typeof raw.tabIcon === 'string' ? raw.tabIcon : '',
  }
}

function PopupLeafFallback({ label }: { label: string }) {
  return <div className="flex h-full items-center justify-center bg-fw-canvas text-sm text-fw-text-muted">Loading {label}…</div>
}

export default function PopupWebUiApp({ target }: { target: FoxwarmPopupTarget }) {
  useTheme()
  const preferences = useChatPreferences()
  const [settings, setSettings] = useState<WebUiSettings>({ instanceName: '', tabIcon: '' })

  const navigate = useCallback((next: FoxwarmPopupTarget) => {
    window.location.assign(makeFoxwarmPopupUrl(window.location.href, next).toString())
  }, [])

  useEffect(() => {
    document.title = `${'title' in target && target.title ? target.title : target.kind === 'agents' ? 'Agents' : target.kind === 'setup' ? 'Setup' : target.kind === 'terminal' ? 'Terminal' : 'Chat'} · Foxwarm`
  }, [target])

  useEffect(() => {
    if (target.kind !== 'chat') return
    const handleClick = (event: MouseEvent) => {
      const sessionId = readEmbeddedSessionLink(event.target)
      if (!sessionId) return
      event.preventDefault()
      navigate({ kind: 'chat', sessionId })
    }
    document.addEventListener('click', handleClick, true)
    return () => document.removeEventListener('click', handleClick, true)
  }, [navigate, target.kind])

  const fetchSettings = useCallback(async () => {
    const response = await fetch(`${API_BASE_PATH}/webui/settings`)
    if (!response.ok) return
    const data = await response.json().catch(() => ({}))
    setSettings(normalizeSettings(data?.settings))
  }, [])

  useEffect(() => {
    if (target.kind === 'setup') void fetchSettings()
  }, [fetchSettings, target.kind])

  const saveSetting = async (field: 'instanceName' | 'tabIcon', value: string) => {
    const response = await fetch(`${API_BASE_PATH}/webui/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data?.error || `Failed to save ${field === 'instanceName' ? 'instance name' : 'tab icon'}`)
    const normalized = normalizeSettings(data?.settings)
    setSettings(current => ({ ...current, [field]: normalized[field] }))
  }

  const openCommit = (commit: CodeCommitTarget) => {
    window.open(
      makeVscodeWebUrl(API_BASE_PATH, window.location.origin, commit, { openCommit: commit }).toString(),
      '_blank',
      'noopener,noreferrer',
    )
  }

  let content
  if (target.kind === 'chat') {
    content = (
      <Chat
        sessionId={target.sessionId}
        canonicalSessionId={target.sessionId}
        sessionDisplayName={target.title}
        sendKeyMode={preferences.sendKeyMode}
        groupTools={preferences.groupTools}
        showUsageBadge={preferences.showUsageBadge}
        showUserMessageMetadata={preferences.showUserMessageMetadata}
        onSendKeyModeChange={preferences.setSendKeyMode}
        onGroupToolsChange={preferences.setGroupTools}
        onShowUsageBadgeChange={preferences.setShowUsageBadge}
        onShowUserMessageMetadataChange={preferences.setShowUserMessageMetadata}
        onOpenModelSettings={() => navigate({ kind: 'setup' })}
        onOpenCodeCommit={openCommit}
      />
    )
  } else if (target.kind === 'terminal') {
    content = <TerminalView initialTerminalId={target.terminalId} />
  } else if (target.kind === 'agents') {
    content = (
      <Suspense fallback={<PopupLeafFallback label="Agents" />}>
        <ArchitectureView onSelectSession={(sessionId) => navigate({ kind: 'chat', sessionId })} />
      </Suspense>
    )
  } else {
    content = (
      <Suspense fallback={<PopupLeafFallback label="Setup" />}>
        <SetupView
          webUiSettings={settings}
          onInstanceNameChange={(value) => saveSetting('instanceName', value)}
          onTabIconChange={(value) => saveSetting('tabIcon', value)}
        />
      </Suspense>
    )
  }

  return <div data-foxwarm-popup-root={target.kind} className="foxwarm-fixed-viewport-shell h-full min-h-0 overflow-hidden bg-fw-canvas">{content}</div>
}