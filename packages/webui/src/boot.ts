import { DEFAULT_THEME_ID } from './theme/builtins'
import { readThemeRegistry, readThemeSelection } from './theme/storage'
import { parseFoxwarmEmbeddedTarget } from './embeddedWebUi'
import { parseFoxwarmPopupTarget } from './popupWebUi'

// Bundled directly into index.html, before any external module can fail.
// Reuse the real manifest registry/validator and preference compatibility path.
let storage: Storage | null = null
try { storage = window.localStorage } catch { /* Browser storage can be disabled. */ }
const selection = readThemeSelection(storage)
const mode = selection.colorMode === 'auto'
  ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  : selection.colorMode
const themes = readThemeRegistry(storage).themes
const chosenId = mode === 'light' ? selection.lightThemeId : selection.darkThemeId
const theme = themes.find(theme => theme.id === chosenId) || themes.find(theme => theme.id === DEFAULT_THEME_ID)!
const colors = theme.variants[mode].colors
const root = document.documentElement
for (const name of ['canvas', 'accent', 'text', 'accentText'] as const) {
  root.style.setProperty(`--foxwarm-color-${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, colors[name])
}
root.style.setProperty('--foxwarm-app-background', colors.canvas)
root.style.colorScheme = mode
root.classList.toggle('dark', mode === 'dark')
document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.canvas)

const leaf = !!(parseFoxwarmPopupTarget(location.search) || parseFoxwarmEmbeddedTarget(location.search))
root.toggleAttribute('data-foxwarm-boot-leaf', leaf)
const startedAt = performance.now()
let contentReady = false
let ready = false
let failure: string | null = null
let leaveTimer: number | undefined
let removeTimer: number | undefined
let screen: HTMLElement | null = null

function showFailure() {
  if (failure === null) return
  screen = document.getElementById('foxwarm-boot')
  if (!screen) return
  screen.hidden = false
  screen.dataset.state = 'error'
  screen.setAttribute('role', 'alert')
  screen.removeAttribute('aria-label')
  const message = document.getElementById('foxwarm-boot-error')!
  message.textContent = failure
  document.getElementById('foxwarm-boot-recovery')!.hidden = false
  document.getElementById('foxwarm-boot-reload')!.onclick = () => location.reload()
}

function fail(error: unknown) {
  if (failure !== null) return
  failure = error instanceof Error ? error.message : typeof error === 'string' ? error : 'An unexpected startup error occurred.'
  if (!failure) failure = 'An unexpected startup error occurred.'
  window.clearTimeout(leaveTimer)
  window.clearTimeout(removeTimer)
  // Keep the detached screen for a later async-chunk failure.
  if (screen && !screen.isConnected) document.body.append(screen)
  showFailure()
}

function markReady() {
  if (ready || failure !== null) return
  contentReady = true
  if (document.querySelector('link[data-foxwarm-boot-style]')) return
  ready = true
  root.setAttribute('data-foxwarm-boot-ready', '')
  window.removeEventListener('error', onStartupError, true)
  document.removeEventListener('load', onStyleLoad, true)
  screen = document.getElementById('foxwarm-boot')
  if (!screen) return
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (leaf || reduced) {
    screen.remove()
    return
  }
  leaveTimer = window.setTimeout(() => {
    screen!.dataset.state = 'leaving'
    removeTimer = window.setTimeout(() => screen!.remove(), 480)
  }, Math.max(0, 1500 - (performance.now() - startedAt)))
}

function onStartupError(event: Event) {
  if (ready) return
  if (event instanceof ErrorEvent) {
    fail(event.error || event.message)
    return
  }
  const target = event.target
  if (target instanceof HTMLScriptElement && target.type === 'module') {
    fail(`Could not load application module: ${target.src}`)
  } else if (target instanceof HTMLLinkElement && (target.rel === 'modulepreload' || target.rel === 'stylesheet')) {
    fail(`Could not load application resource: ${target.href}`)
  }
}

function onStyleLoad(event: Event) {
  const target = event.target
  if (!(target instanceof HTMLLinkElement) || !target.hasAttribute('data-foxwarm-boot-style')) return
  target.media = 'all'
  target.removeAttribute('data-foxwarm-boot-style')
  if (contentReady) markReady()
}

document.addEventListener('load', onStyleLoad, true)
window.addEventListener('error', onStartupError, true)
window.addEventListener('vite:preloadError', event => {
  fail((event as Event & { payload: unknown }).payload)
  // Preserve Vite's throw/console diagnostics. No automatic reload or data reset.
})
document.addEventListener('DOMContentLoaded', showFailure, { once: true })
window.foxwarmBoot = { ready: markReady, fail }
