import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

function isIOSDevice() {
  const nav = window.navigator
  return /iPhone|iPad|iPod/i.test(nav.userAgent)
    || (nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)
}

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

function findVerticalScrollableAncestor(start: EventTarget | null): HTMLElement | null {
  let node = start instanceof Element ? start : null

  while (node && node !== document.body && node !== document.documentElement) {
    if (node instanceof HTMLElement) {
      const style = window.getComputedStyle(node)
      const overflowY = style.overflowY
      const canScroll = (overflowY === 'auto' || overflowY === 'scroll' || node.tagName === 'TEXTAREA')
        && node.scrollHeight > node.clientHeight + 1

      if (canScroll) {
        return node
      }
    }
    node = node.parentElement
  }

  return null
}

if (isIOSDevice()) {
  let lastTouchY = 0

  document.addEventListener('touchstart', (event) => {
    if (event.touches.length > 0) {
      lastTouchY = event.touches[0].clientY
    }
  }, { passive: true })

  document.addEventListener('touchmove', (event) => {
    if (event.touches.length === 0) {
      return
    }

    const currentY = event.touches[0].clientY
    const deltaY = currentY - lastTouchY
    lastTouchY = currentY

    const scrollable = findVerticalScrollableAncestor(event.target)
    if (!scrollable) {
      event.preventDefault()
      return
    }

    const isPullingDown = deltaY > 0
    const atTop = scrollable.scrollTop <= 0
    const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 1

    if ((isPullingDown && atTop) || (!isPullingDown && atBottom)) {
      event.preventDefault()
    }
  }, { passive: false })
}

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
