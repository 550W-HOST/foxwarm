// Browser-visible deployment paths are authoritative, including prefix-stripping proxies.
const cookieName = 'foxwarm_token'
const recoveryKey = 'foxwarm_cookie_recovery:'

export function browserAuthPath() {
  return location.pathname.replace(/[^/]+$/, '') || '/'
}

export function writeBrowserAuthCookie(token: string) {
  document.cookie = `${cookieName}=${encodeURIComponent(token)}; path=${browserAuthPath()}; max-age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
}

export function existingBrowserAuthToken(): string | null {
  try {
    const entry = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))
    return entry ? decodeURIComponent(entry.slice(cookieName.length + 1)) || null : null
  } catch { return null }
}

// Only migrate the credential already sent successfully as a cookie, never a stale
// localStorage token. HttpOnly cookies remain owned by their original writer.
export function renewAuthenticatedBrowserCookie() {
  const token = existingBrowserAuthToken()
  try { if (token) writeBrowserAuthCookie(token) } catch { /* Cookie policy must not break authenticated app boot. */ }
  try { sessionStorage.removeItem(recoveryKey + browserAuthPath()) } catch { /* Storage is optional. */ }
}

// Old Strict cookies can omit credentials on a cold external PWA navigation.
// A same-origin check confirms the existing cookie before migrating and re-entering.
// Explicit login pages and token links remain manual; failures never erase credentials.
export async function recoverBrowserCookie(signal: AbortSignal, canNavigate: () => boolean) {
  if (location.pathname.endsWith('/login.html') || location.hash.startsWith('#token=') || !existingBrowserAuthToken()) return
  const key = recoveryKey + browserAuthPath()
  try {
    if (sessionStorage.getItem(key)) return
  } catch { return } // Without a redirect guard, leave the manual form available.
  try {
    const response = await fetch('./api/auth/session', { credentials: 'same-origin', cache: 'no-store', signal })
    if (!response.ok) return
    const payload = await response.json()
    if (payload?.role !== 'admin' && payload?.role !== 'webui') return
    if (signal.aborted || !canNavigate()) return
    renewAuthenticatedBrowserCookie()
    sessionStorage.setItem(key, '1')
    location.replace('./')
  } catch { /* Offline/expired cookies leave the ordinary sign-in form usable. */ }
}
