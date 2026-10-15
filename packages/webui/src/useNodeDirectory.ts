import { useCallback, useEffect, useRef, useState } from 'react'
import { API_BASE_PATH } from './config'
import { parseWebUiNodeTargets, type WebUiNodeTarget } from './nodeTargets'

/** Directory/status only; pending approvals and setup credentials have separate owners. */
export function useNodeDirectory() {
  const [nodes, setNodes] = useState<WebUiNodeTarget[]>(() => parseWebUiNodeTargets({ nodes: [] }))
  const [error, setError] = useState('')
  const requestRef = useRef<AbortController | null>(null)
  const reload = useCallback(async () => {
    if (document.hidden) return
    requestRef.current?.abort()
    const request = new AbortController()
    requestRef.current = request
    try {
      const response = await fetch(`${API_BASE_PATH}/nodes`, { signal: request.signal })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload.error || 'Could not load Nodes.')
      if (requestRef.current === request) {
        setNodes(parseWebUiNodeTargets(payload))
        setError('')
      }
    } catch (error) {
      if (requestRef.current === request && !request.signal.aborted) setError(error instanceof Error ? error.message : 'Could not load Nodes.')
    } finally {
      if (requestRef.current === request) requestRef.current = null
    }
  }, [])

  useEffect(() => {
    void reload()
    const timer = window.setInterval(() => { if (!requestRef.current) void reload() }, 30_000)
    const visibility = () => {
      if (document.hidden) {
        requestRef.current?.abort()
        requestRef.current = null
      } else void reload()
    }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      requestRef.current?.abort()
      requestRef.current = null
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [reload])

  return { nodes, error, reload }
}
