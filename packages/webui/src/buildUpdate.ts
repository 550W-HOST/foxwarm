export const BEFORE_UPDATE_RELOAD = 'foxwarm-before-update-reload'

/** Vite's hashed entry URLs identify actual delivered frontend assets, including
 * untagged rebuilds. Login/error HTML is not a build and must never trigger reload. */
export function frontendBuild(document: Document, base: string): string | null {
  if (!document.getElementById('root')) return null
  const urls = [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')]
    .map(script => new URL(script.getAttribute('src')!, base))
    .filter(url => url.origin === new URL(base).origin && /\/assets\/[^/]+\.js$/.test(url.pathname))
    .map(url => url.pathname).sort()
  return urls.length ? urls.join('\n') : null
}

export function watchFrontendBuild(onUpdate: (build: string | null) => void) {
  const url = new URL('./', location.href).href
  const current = frontendBuild(document, url)
  if (!current) return () => {}
  let stopped = false, controller: AbortController | null = null, lastCheck = 0
  const check = async () => {
    if (stopped || document.visibilityState === 'hidden' || controller || Date.now() - lastCheck < 15000) return
    lastCheck = Date.now()
    controller = new AbortController()
    const active = controller
    const timeout = window.setTimeout(() => active.abort(), 10000)
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: active.signal })
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return
      const latest = frontendBuild(new DOMParser().parseFromString(await response.text(), 'text/html'), url)
      if (!stopped && latest) onUpdate(latest === current ? null : latest)
    } catch { /* Offline/restarting/authentication failures are not update notifications. */ }
    finally { window.clearTimeout(timeout); controller = null }
  }
  const onVisible = () => { void check() }
  window.addEventListener('online', onVisible)
  window.addEventListener('focus', onVisible)
  document.addEventListener('visibilitychange', onVisible)
  const interval = window.setInterval(onVisible, 60000)
  void check()
  return () => {
    stopped = true; controller?.abort(); window.clearInterval(interval)
    window.removeEventListener('online', onVisible); window.removeEventListener('focus', onVisible)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
