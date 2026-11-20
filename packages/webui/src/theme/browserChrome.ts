let canvasColor = ''
let frameColor: (() => string | null) | null = null

function applyThemeColor() {
  const color = frameColor?.() || canvasColor
  if (color) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color)
}

/**
 * Under the PWA window-controls overlay the browser paints the window controls on
 * theme-color, so the live theme-color follows the surface beneath them. The manifest
 * keeps the canvas, which is also the launch background. Pass null to return to the canvas.
 */
export function setFrameChromeColor(source: (() => string | null) | null): void {
  frameColor = source
  applyThemeColor()
}

/** Re-reads the frame colour after the layout under the window controls changed. */
export function refreshFrameChromeColor(): void {
  if (frameColor) applyThemeColor()
}

/** Keep installed-app metadata and the live page on the same canvas color.
 * This cookie contains only a validated public color, never a credential/theme document.
 */
export function syncBrowserChrome(canvas: string): void {
  canvasColor = canvas
  applyThemeColor()
  if (!/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(canvas)) return
  const color = canvas.slice(1).toLowerCase()
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  const url = new URL(manifest?.getAttribute('href') || './manifest.json', location.href)
  if (url.origin !== location.origin) return
  const path = new URL('./', url).pathname
  try {
    const previous = document.cookie.split(';').map(part => part.trim()).find(part => part.startsWith('foxwarm_canvas='))?.slice('foxwarm_canvas='.length)
    if (previous === color) return
    document.cookie = `foxwarm_canvas=${color}; Path=${path}; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
    // Re-fetch at the same URL after a theme change; preserve manifest identity,
    // relative start_url/scope, and authenticated retrieval under proxy prefixes.
    if (manifest) manifest.replaceWith(manifest.cloneNode(true))
  } catch { /* Browser storage policy must not prevent applying the page theme. */ }
}
