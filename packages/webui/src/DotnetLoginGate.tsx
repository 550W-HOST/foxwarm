import { useEffect, useState, type ReactNode } from 'react'
import { API_BASE_PATH } from './config'

/** The local .NET host uses the normal App after its cookie login; this is not a second app shell. */
export default function DotnetLoginGate({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState('')
  useEffect(() => { void fetch(`${API_BASE_PATH}/sessions`).then(response => setReady(response.ok)).catch(() => {}) }, [])
  if (ready) return children
  return <form className="m-auto flex max-w-sm flex-col gap-3 p-6" onSubmit={event => {
    event.preventDefault()
    void fetch(`${API_BASE_PATH}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) })
      .then(response => { setToken(''); if (response.ok) setReady(true); else setError('Invalid local access token') })
      .catch(() => { setToken(''); setError('Could not connect') })
  }}>
    <h1 className="text-lg font-semibold">Foxwarm</h1>
    <label htmlFor="dotnet-token">Local access token</label>
    <input id="dotnet-token" type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)} className="rounded border px-3 py-2" />
    <button type="submit" className="rounded border px-3 py-2">Connect</button>
    {error && <p role="alert">{error}</p>}
  </form>
}
