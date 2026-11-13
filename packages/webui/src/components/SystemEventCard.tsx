import { createContext, useContext } from 'react'
import type { SessionNotice } from '../../../shared/src/sessionNotice'
import RuntimeFox from './RuntimeFox'

/** Opens Setup → Models from a notice. Absent where the host cannot open Setup. */
export const OpenModelSettingsContext = createContext<(() => void) | null>(null)

const tones = {
  error: { border: 'border-l-fw-danger', ink: 'text-fw-danger' },
  warning: { border: 'border-l-fw-warning', ink: 'text-fw-warning' },
  info: { border: 'border-l-fw-accent', ink: 'text-fw-accent' },
}

/** Operational history, visually separate from both assistant prose and tool threads. */
export default function SystemEventCard({ notice, reveal = false, searchSurface = 'system', searchPartIndex }: { notice: SessionNotice; reveal?: boolean; searchSurface?: 'system' | 'model'; searchPartIndex?: number }) {
  const tone = tones[notice.severity]
  const openModelSettings = useContext(OpenModelSettingsContext)
  return <section aria-label={notice.title} data-system-event data-event-source={notice.source} data-event-severity={notice.severity} className={`my-2 flex w-full max-w-[52rem] gap-3 rounded-md border border-fw-border-muted border-l-2 ${tone.border} bg-fw-surface-sunken/40 p-3 text-fw-text`}>
    <span className={`shrink-0 pt-0.5 ${tone.ink}`}><RuntimeFox kind={notice.severity === 'error' ? 'error' : notice.source === 'compaction' ? 'compact' : 'unknown'} size={20} animated={false} /></span>
    <div data-search-surface={searchSurface} data-search-part-index={searchPartIndex} className="min-w-0 flex-1">
      <h3 className="whitespace-pre-wrap break-words text-sm font-normal leading-6 text-fw-text-muted">
        <span className="font-semibold text-fw-text-strong">{notice.title}:</span>{' '}{notice.summary}
      </h3>
      {notice.action === 'open-model-settings' && openModelSettings && <button type="button" data-event-action="open-model-settings" onClick={openModelSettings} className="mt-2 rounded-lg border border-fw-border px-3 py-1.5 text-sm font-medium text-fw-text-strong hover:bg-fw-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring">Open model settings</button>}
      {notice.details && <details open={reveal || undefined} data-event-details className="mt-2 text-xs text-fw-text-muted">
        <summary data-search-exclude className="w-fit cursor-pointer rounded py-0.5 hover:text-fw-text-strong focus-visible:underline">Details</summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-fw-canvas/60 p-3 font-mono text-xs leading-5 text-fw-text">{notice.details}</pre>
      </details>}
    </div>
  </section>
}
