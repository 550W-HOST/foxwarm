import { useEffect, useState } from 'react'
import { BEFORE_UPDATE_RELOAD, watchFrontendBuild } from '../buildUpdate'

export default function BuildUpdateNotice() {
  const [available, setAvailable] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [blocked, setBlocked] = useState(false)
  useEffect(() => watchFrontendBuild(setAvailable), [])
  if (!available || available === dismissed) return null
  const reload = () => {
    const event = new Event(BEFORE_UPDATE_RELOAD, { cancelable: true })
    if (!window.dispatchEvent(event)) { setBlocked(true); return }
    // Other editors (including embedded Code) may hold unsaved changes. Never
    // auto-reload or bypass the browser's own beforeunload safeguards.
    if (window.confirm('Reload Foxwarm? Save any unsaved edits first.')) location.reload()
  }
  return <aside role="status" aria-live="polite" className="fixed left-1/2 z-[1000] flex w-max max-w-[calc(100vw-24px)] -translate-x-1/2 flex-wrap items-center gap-3 rounded-xl border border-fw-border bg-fw-surface px-4 py-3 text-sm text-fw-text shadow-lg" style={{ top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}>
    <span>{blocked ? 'Finish sending or save your draft before reloading.' : 'A new version is available.'}</span>
    <button type="button" className="font-semibold text-fw-accent" onClick={reload}>Reload</button>
    <button type="button" className="text-fw-text-muted" onClick={() => { setDismissed(available); setBlocked(false) }}>Later</button>
  </aside>
}
