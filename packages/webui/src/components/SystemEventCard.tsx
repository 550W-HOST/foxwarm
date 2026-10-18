import type { SessionNotice } from '../../../shared/src/sessionNotice'
import RuntimeFox from './RuntimeFox'

const tones = {
  error: { border: 'border-l-fw-danger', ink: 'text-fw-danger' },
  warning: { border: 'border-l-fw-warning', ink: 'text-fw-warning' },
  info: { border: 'border-l-fw-accent', ink: 'text-fw-accent' },
}

/** Operational history, visually separate from both assistant prose and tool threads. */
export default function SystemEventCard({ notice, reveal = false }: { notice: SessionNotice; reveal?: boolean }) {
  const tone = tones[notice.severity]
  return <section aria-label={notice.title} data-system-event data-event-source={notice.source} data-event-severity={notice.severity} className={`my-2 flex w-full max-w-[52rem] gap-3 rounded-md border border-fw-border-muted border-l-2 ${tone.border} bg-fw-surface-sunken/40 p-3 text-fw-text`}>
    <span className={`shrink-0 pt-0.5 ${tone.ink}`}><RuntimeFox kind={notice.severity === 'error' ? 'error' : notice.source === 'compaction' ? 'compact' : 'unknown'} size={20} animated={false} /></span>
    <div data-search-surface="system" className="min-w-0 flex-1">
      <h3 className="whitespace-pre-wrap break-words text-sm font-normal leading-6 text-fw-text-muted">
        <span className="font-semibold text-fw-text-strong">{notice.title}:</span>{' '}{notice.summary}
      </h3>
      {notice.details && <details open={reveal || undefined} data-event-details className="mt-2 text-xs text-fw-text-muted">
        <summary data-search-exclude className="w-fit cursor-pointer rounded py-0.5 hover:text-fw-text-strong focus-visible:underline">Details</summary>
        <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded bg-fw-canvas/60 p-3 font-mono text-xs leading-5 text-fw-text">{notice.details}</pre>
      </details>}
    </div>
  </section>
}
