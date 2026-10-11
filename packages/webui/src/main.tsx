import { lazy, StrictMode, Suspense, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './index.css'
import { parseFoxwarmEmbeddedTarget } from './embeddedWebUi'
import { parseFoxwarmPopupTarget } from './popupWebUi'
import { initializeThemeRuntime } from './theme/runtime'
import { API_BASE_PATH } from './config'

const App = lazy(() => import('./App'))
const WebUiIdentityApp = lazy(() => import('./WebUiIdentityApp'))
const PopupWebUiApp = lazy(() => import('./PopupWebUiApp'))
const EmbeddedSidebarApp = lazy(() => import('./EmbeddedWebUiApp').then(module => ({ default: module.EmbeddedSidebarApp })))
const EmbeddedChatApp = lazy(() => import('./EmbeddedWebUiApp').then(module => ({ default: module.EmbeddedChatApp })))
const EmbeddedAgentsApp = lazy(() => import('./EmbeddedWebUiApp').then(module => ({ default: module.EmbeddedAgentsApp })))
const EmbeddedSetupApp = lazy(() => import('./EmbeddedWebUiApp').then(module => ({ default: module.EmbeddedSetupApp })))

function syncViewportHeight() {
  const vv = window.visualViewport
  const height = Math.round(vv?.height ?? window.innerHeight)
  const topOffset = Math.round(vv?.offsetTop ?? 0)

  document.documentElement.style.setProperty('--foxwarm-app-height', `${height}px`)
  document.documentElement.style.setProperty('--foxwarm-app-top-offset', `${topOffset}px`)
}

syncViewportHeight()
initializeThemeRuntime()

window.visualViewport?.addEventListener('resize', syncViewportHeight)
window.visualViewport?.addEventListener('scroll', syncViewportHeight)
window.addEventListener('resize', syncViewportHeight)
window.addEventListener('orientationchange', syncViewportHeight)
window.addEventListener('pageshow', syncViewportHeight)

const embeddedTarget = parseFoxwarmEmbeddedTarget(window.location.search)
const popupTarget = parseFoxwarmPopupTarget(window.location.search)
const content = popupTarget
  ? <PopupWebUiApp target={popupTarget} />
  : embeddedTarget?.kind === 'sidebar'
  ? <EmbeddedSidebarApp target={embeddedTarget} />
  : embeddedTarget?.kind === 'chat'
    ? <EmbeddedChatApp target={embeddedTarget} />
    : embeddedTarget?.kind === 'agents'
      ? <EmbeddedAgentsApp target={embeddedTarget} />
      : embeddedTarget?.kind === 'setup'
        ? <EmbeddedSetupApp target={embeddedTarget} />
    : <App />

type AuthSession = { role: 'webui'; identityId: string; sessionIds: string[] } | { role: 'admin' }

function AuthenticatedWebUiRoot() {
  const [auth, setAuth] = useState<AuthSession | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    fetch(`${API_BASE_PATH}/auth/session`).then(async response => {
      if (!response.ok) throw new Error('Authentication required')
      return response.json()
    }).then(data => {
      if (!active) return
      if (data?.role === 'webui' && Array.isArray(data.sessionIds) && typeof data.identityId === 'string') {
        setAuth({ role: 'webui', identityId: data.identityId, sessionIds: data.sessionIds.filter((id: unknown): id is string => typeof id === 'string') })
      } else if (data?.role === 'admin') setAuth({ role: 'admin' })
      else setFailed(true)
    }).catch(() => { if (active) setFailed(true) })
    return () => { active = false }
  }, [])
  if (failed) return <div className="foxwarm-fixed-viewport-shell flex h-full items-center justify-center text-fw-text"><a href="login.html">Sign in again</a></div>
  if (!auth) return <div className="foxwarm-fixed-viewport-shell h-full bg-fw-canvas" />
  return auth.role === 'webui' ? <WebUiIdentityApp auth={auth} /> : content
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="foxwarm-fixed-viewport-shell h-full bg-fw-canvas" />}>
      <AuthenticatedWebUiRoot />
    </Suspense>
  </StrictMode>,
)

// Unregister any existing service workers
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => {
      registration.unregister()
    })
  })
}
