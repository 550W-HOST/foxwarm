import { isStandaloneWebUi, requestUpdateReload } from './updateReload'
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
let resourceFailure: string | null = null
let availableBuild: string | null = null
let dismissedBuild: string | null = null
let reloadBlocked = false
let leaveTimer: number | undefined
let removeTimer: number | undefined
let screen: HTMLElement | null = null

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : typeof error === 'string' ? error : '')
    || 'An unexpected startup error occurred.'
}

function showRecovery(message: string, state: 'error' | 'notice') {
  screen ||= document.getElementById('foxwarm-boot')
  if (!screen) return
  if (!screen.isConnected) document.body.append(screen)
  screen.hidden = false
  screen.dataset.state = state
  screen.toggleAttribute('data-fox-splash', state === 'error')
  screen.setAttribute('role', 'alert')
  screen.removeAttribute('aria-label')
  screen.setAttribute('aria-labelledby', 'foxwarm-boot-title')
  screen.setAttribute('aria-describedby', 'foxwarm-boot-description')
  document.getElementById('foxwarm-boot-title')!.textContent = state === 'error' ? 'Foxwarm couldn’t load'
    : availableBuild && availableBuild !== dismissedBuild ? 'A new version is available' : 'Some features couldn’t load'
  document.getElementById('foxwarm-boot-description')!.textContent = reloadBlocked
    ? 'Finish sending or save your draft before reloading.'
    : state === 'error'
    ? 'Reload to try again.'
    : 'You can keep working, or reload to try again.'
  document.getElementById('foxwarm-boot-error')!.textContent = message
  document.getElementById('foxwarm-boot-recovery')!.hidden = false
  document.getElementById('foxwarm-boot-details')!.hidden = !message
  document.getElementById('foxwarm-boot-reload')!.onclick = () => {
    const blocked = !requestUpdateReload(contentReady)
    if (blocked !== reloadBlocked) {
      reloadBlocked = blocked
      showRecovery(message, state)
    }
  }
  const dismiss = document.getElementById('foxwarm-boot-dismiss')!
  dismiss.hidden = state !== 'notice'
  dismiss.onclick = () => {
    resourceFailure = null
    dismissedBuild = availableBuild
    reloadBlocked = false
    screen!.remove()
  }
}

function showFailure() {
  if (failure !== null) showRecovery(failure, 'error')
}

function showNotice() {
  if (!isStandaloneWebUi() || failure !== null || !ready) return
  if (resourceFailure !== null || (availableBuild && availableBuild !== dismissedBuild)) {
    showRecovery(resourceFailure || '', 'notice')
  } else if (screen?.dataset.state === 'notice') screen.remove()
}

function updateBuild(build: string | null) {
  if (availableBuild === build) return
  availableBuild = build
  reloadBlocked = false
  // Let the startup animation finish before presenting a live notice.
  if (screen && (!screen.isConnected || screen.dataset.state === 'notice')) showNotice()
}

function finishSplash() {
  screen!.remove()
  showNotice()
}

function reportResourceFailure(error: unknown) {
  if (!contentReady) {
    fail(error)
    return
  }
  if (failure !== null) return
  resourceFailure ||= errorMessage(error)
  // Mounted content may already have a supported local fallback. Keep it usable;
  // the specific module-load error remains visible without taking over the app.
  if (ready && screen && (!screen.isConnected || screen.dataset.state === 'notice')) showNotice()
}

function fail(error: unknown) {
  if (failure !== null) return
  failure = errorMessage(error)
  window.clearTimeout(leaveTimer)
  window.clearTimeout(removeTimer)
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
    finishSplash()
    return
  }
  leaveTimer = window.setTimeout(() => {
    screen!.dataset.state = 'leaving'
    removeTimer = window.setTimeout(finishSplash, 480)
  }, Math.max(0, 1500 - (performance.now() - startedAt)))
}

function onStartupError(event: Event) {
  if (ready) return
  if (event instanceof ErrorEvent) {
    // Module errors expose their source URL, including cross-origin CORS assets.
    // Initial static dependencies are represented by Vite's modulepreload links;
    // lazy imports and React root failures have their own explicit callbacks.
    // Anonymous classic-script errors cannot be attributed to the application.
    if (event.filename && Array.from(document.querySelectorAll<HTMLScriptElement | HTMLLinkElement>('[data-foxwarm-boot-resource]'))
      .some(resource => (resource instanceof HTMLScriptElement ? resource.src : resource.rel === 'modulepreload' ? resource.href : '') === event.filename)) {
      fail(event.error || event.message)
    }
    return
  }
  const target = event.target
  if (!(target instanceof Element) || !target.hasAttribute('data-foxwarm-boot-resource')) return
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
  reportResourceFailure((event as Event & { payload: unknown }).payload)
  // Preserve Vite's throw/console diagnostics. No automatic reload or data reset.
})
document.addEventListener('DOMContentLoaded', showFailure, { once: true })
window.foxwarmBoot = { ready: markReady, fail, update: updateBuild }
