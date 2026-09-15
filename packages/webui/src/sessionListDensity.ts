import { useEffect, useState } from 'react'

export const SESSION_LIST_COMPACT_KEY = 'foxwarm_session_list_compact_v1'
const CHANGE_EVENT = 'foxwarm:session-list-density'

export function loadSessionListCompact(storage?: Pick<Storage, 'getItem'>): boolean {
  try { return (storage ?? localStorage).getItem(SESSION_LIST_COMPACT_KEY) === 'true' } catch { return false }
}

/** Presentation-only preference shared by sidebar, mobile, and embedded list roots. */
export function useSessionListCompact(): [boolean, () => void] {
  const [compact, setCompact] = useState(loadSessionListCompact)
  useEffect(() => {
    const onChange = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key === null || event.key === SESSION_LIST_COMPACT_KEY) setCompact(loadSessionListCompact())
      } else {
        setCompact((event as CustomEvent<boolean>).detail)
      }
    }
    window.addEventListener('storage', onChange)
    window.addEventListener(CHANGE_EVENT, onChange)
    return () => {
      window.removeEventListener('storage', onChange)
      window.removeEventListener(CHANGE_EVENT, onChange)
    }
  }, [])
  return [compact, () => {
    const next = !compact
    try { localStorage.setItem(SESSION_LIST_COMPACT_KEY, String(next)) } catch { /* Still works for this page when storage is unavailable. */ }
    setCompact(next)
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }))
  }]
}
