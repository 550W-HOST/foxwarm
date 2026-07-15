import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './index.css'
import App from './App'
import { EmbeddedAgentsApp, EmbeddedChatApp, EmbeddedSetupApp, EmbeddedSidebarApp } from './EmbeddedWebUiApp'
import { parseFoxwarmEmbeddedTarget } from './embeddedWebUi'

function syncViewportHeight() {
  const vv = window.visualViewport
  const height = Math.round(vv?.height ?? window.innerHeight)
  const topOffset = Math.round(vv?.offsetTop ?? 0)

  document.documentElement.style.setProperty('--foxwarm-app-height', `${height}px`)
  document.documentElement.style.setProperty('--foxwarm-app-top-offset', `${topOffset}px`)
}

syncViewportHeight()

window.visualViewport?.addEventListener('resize', syncViewportHeight)
window.visualViewport?.addEventListener('scroll', syncViewportHeight)
window.addEventListener('resize', syncViewportHeight)
window.addEventListener('orientationchange', syncViewportHeight)
window.addEventListener('pageshow', syncViewportHeight)

const embeddedTarget = parseFoxwarmEmbeddedTarget(window.location.search)
const content = embeddedTarget?.kind === 'sidebar'
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
    {content}
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
