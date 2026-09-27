import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './index.css'
import { parseFoxwarmEmbeddedTarget } from './embeddedWebUi'
import { parseFoxwarmPopupTarget } from './popupWebUi'
import { initializeThemeRuntime } from './theme/runtime'

const App = lazy(() => import('./App'))
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="foxwarm-fixed-viewport-shell h-full bg-fw-canvas" />}>
      {content}
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
