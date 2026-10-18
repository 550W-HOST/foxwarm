import { initializeThemeRuntime } from './theme/runtime'

try {
  initializeThemeRuntime()
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', getComputedStyle(document.documentElement).getPropertyValue('--foxwarm-color-canvas').trim())
} catch { /* Keep sign-in available with the standalone palette if theme enhancement fails. */ }

function mountLogin() {
  const form = document.getElementById('loginForm') as HTMLFormElement
  const input = document.getElementById('token') as HTMLInputElement
  const reveal = document.getElementById('reveal') as HTMLButtonElement
  const submit = document.getElementById('submit') as HTMLButtonElement
  const label = document.getElementById('submitLabel')!
  const error = document.getElementById('error')!
  let pending = false
  let request: AbortController | null = null

  const clearError = () => {
    error.textContent = ''
    input.removeAttribute('aria-invalid')
  }
  const fail = (message: string, invalid = false) => {
    document.body.dataset.state = 'idle'
    error.textContent = message
    if (invalid) { input.setAttribute('aria-invalid', 'true'); input.focus({ preventScroll: true }) }
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) error.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 180 })
  }
  input.addEventListener('input', clearError)
  reveal.addEventListener('click', () => {
    const visible = input.type === 'password'
    input.type = visible ? 'text' : 'password'
    reveal.setAttribute('aria-pressed', String(visible))
    reveal.setAttribute('aria-label', visible ? 'Hide token' : 'Show token')
    reveal.title = visible ? 'Hide token' : 'Show token'
  })
  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (pending) return
    const token = input.value.trim()
    if (!token) { fail('Enter your access token.', true); return }
    pending = true
    clearError()
    input.readOnly = true
    reveal.disabled = true
    submit.disabled = true
    form.setAttribute('aria-busy', 'true')
    label.textContent = 'Signing in…'
    document.body.dataset.state = 'pending'
    const controller = new AbortController()
    request = controller
    let timedOut = false
    let succeeded = false
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort() }, 15000)
    try {
      const response = await fetch('./api/auth', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }), signal: controller.signal,
      })
      if (!response.ok) {
        fail(response.status === 401 || response.status === 403 ? 'Invalid token. Try again.' : 'Couldn’t sign in. Try again.', response.status === 401 || response.status === 403)
        return
      }
      const cookiePath = location.pathname.replace(/[^/]+$/, '') || '/'
      document.cookie = `foxwarm_token=${encodeURIComponent(token)}; path=${cookiePath}; max-age=31536000; SameSite=Strict${location.protocol === 'https:' ? '; Secure' : ''}`
      try { localStorage.setItem('foxwarm_token', token) } catch { /* The authenticated cookie remains usable without browser storage. */ }
      input.value = ''
      succeeded = true
      document.body.dataset.state = 'success'
      label.textContent = 'Signed in'
      window.setTimeout(() => location.replace('./'), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180)
    } catch {
      if (timedOut) fail('Connection timed out. Try again.')
      else if (!controller.signal.aborted) fail('Couldn’t connect. Try again.')
    } finally {
      window.clearTimeout(timeout)
      if (request === controller) request = null
      if (!succeeded) {
        document.body.dataset.state = 'idle'
        pending = false
        input.readOnly = false
        reveal.disabled = false
        submit.disabled = false
        form.removeAttribute('aria-busy')
        label.textContent = 'Sign in'
      }
    }
  })
  window.addEventListener('pagehide', () => request?.abort())

  // Consume legacy sign-in links without retaining their credential in history.
  if (location.hash.startsWith('#token=')) {
    const encoded = location.hash.slice(7)
    try { history.replaceState(null, '', location.pathname + location.search) } catch { /* History may be restricted in an embed. */ }
    try {
      const token = decodeURIComponent(encoded)
      if (token) {
        input.value = token
        if (typeof form.requestSubmit === 'function') form.requestSubmit()
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      }
    } catch { fail('Invalid sign-in link.') }
  } else if (matchMedia('(pointer: fine) and (min-width: 701px)').matches) {
    input.focus({ preventScroll: true })
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountLogin, { once: true })
else mountLogin()
