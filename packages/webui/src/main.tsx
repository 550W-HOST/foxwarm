import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'katex/dist/katex.min.css'
import './index.css'
import App from './App'

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
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
