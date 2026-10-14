import { memo } from 'react'
import RuntimeBusySpinner from './RuntimeBusySpinner'
import type { TimelineView } from '../chatPreferences'
import { getRuntimeStateSummary, type SessionRuntimeState } from '../sessionRuntimeState'

interface ProcessingStatusProps {
  sessionBusy: boolean
  runtimeState?: SessionRuntimeState
  sessionQueueLength: number
  turnIncomplete: boolean
  loading: boolean
  isMobile: boolean
  timelineView?: TimelineView
  onStop?: () => void
  onRunQueued?: () => void
  onContinue?: () => void
}

const controlButtonClass = 'rounded border border-current px-2 py-0.5 text-[11px] font-medium leading-4 transition-colors hover:bg-fw-overlay/5 focus:outline-none focus:ring-2 focus:ring-fw-focus-ring disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-fw-surface/10 dark:focus:ring-fw-focus-ring'

const ProcessingStatus = memo(function ProcessingStatus({
  sessionBusy,
  runtimeState,
  sessionQueueLength,
  turnIncomplete,
  loading,
  isMobile,
  timelineView,
  onStop,
  onRunQueued,
  onContinue,
}: ProcessingStatusProps) {
  const rowWidthClass = isMobile ? 'w-full' : 'w-full max-w-[80%]'
  const queuedLabel = `${sessionQueueLength} queued message${sessionQueueLength > 1 ? 's' : ''}`
  const runtimeStateName = runtimeState?.state || (sessionBusy ? 'requesting-model' : 'idle')
  const showRuntimeStatus = runtimeStateName !== 'idle' && !loading
  const runtimeSummary = getRuntimeStateSummary(runtimeState, sessionBusy)
  const isCompacting = runtimeStateName === 'requesting-model' && runtimeState?.active?.phase === 'compaction'
  const visibleRuntimeSummary = timelineView === 'conversation' && (runtimeStateName === 'requesting-model' || runtimeStateName === 'running-tool')
    ? isCompacting ? 'Compacting…' : 'Working…'
    : timelineView === 'conversation' && runtimeStateName === 'waiting'
    ? 'Waiting'
    : isCompacting
    ? 'Compacting...'
    : runtimeStateName === 'requesting-model'
    ? runtimeSummary.replace(/^thinking\b/, 'Thinking...')
    : runtimeSummary
  const isActive = runtimeStateName === 'requesting-model' || runtimeStateName === 'running-tool'
  const tone = runtimeStateName === 'running-tool'
    ? {
        surface: 'bg-fw-special-surface dark:bg-fw-special-surface/20 border-fw-special-border dark:border-fw-special-border',
        text: 'text-fw-special dark:text-fw-special',
        controls: 'text-fw-special dark:text-fw-special',
        dot: 'bg-fw-special dark:bg-fw-special',
      }
    : runtimeStateName === 'waiting' || runtimeStateName === 'idle'
      ? {
          surface: 'bg-fw-warning-surface dark:bg-fw-warning-surface-strong/20 border-fw-warning-border dark:border-fw-warning-border',
          text: 'text-fw-warning dark:text-fw-warning',
          controls: 'text-fw-warning dark:text-fw-warning',
          dot: 'bg-fw-warning dark:bg-fw-warning',
        }
      : {
          surface: 'bg-fw-accent-surface dark:bg-fw-accent-surface-strong/20 border-fw-accent-border dark:border-fw-accent-border',
          text: 'text-fw-accent dark:text-fw-accent',
          controls: 'text-fw-accent dark:text-fw-accent',
          dot: 'bg-fw-accent dark:bg-fw-accent',
        }
  const queuedContinuation = sessionQueueLength > 0
    ? isCompacting
      ? `${queuedLabel} will be inserted when this session resumes after compaction`
      : runtimeStateName === 'running-tool'
      ? `${queuedLabel} will be inserted after this tool call`
      : runtimeStateName === 'waiting'
        ? `${queuedLabel} will be inserted when this session resumes`
        : `${queuedLabel} will be inserted after this model response`
    : ''

  const interrupted = runtimeStateName === 'idle' && turnIncomplete && !loading
  const statusLabel = interrupted ? 'Turn interrupted' : visibleRuntimeSummary
  const queueLabel = runtimeStateName === 'idle' ? `${queuedLabel} pending` : queuedContinuation

  const hasQueue = sessionQueueLength > 0
  const showStatusLabel = showRuntimeStatus || interrupted
  const label = showStatusLabel
    ? `${statusLabel}${hasQueue ? ` • ${queueLabel}` : ''}`
    : hasQueue ? queueLabel : ''

  return (
    <div data-processing-status-slot className={hasQueue ? 'mt-4' : 'flex h-14 items-end'}>
      {(loading || showRuntimeStatus || interrupted || hasQueue) && (
        <div className={`flex min-w-0 ${rowWidthClass}`}>
          <div
            className={`inline-flex min-w-0 max-w-full items-center gap-2 rounded-lg border px-4 py-2 ${hasQueue ? 'flex-wrap' : ''} ${loading ? 'bg-fw-surface border-fw-border' : tone.surface}`}
            data-processing-runtime-state={loading ? undefined : interrupted ? 'interrupted' : showRuntimeStatus ? runtimeStateName : undefined}
            role="status"
          >
            <div className="flex min-w-0 max-w-full items-center gap-2">
              {loading ? (
                <span className="flex shrink-0 items-center gap-2" aria-label="Loading">
                  <span className="h-2 w-2 rounded-full bg-fw-text-subtle dark:bg-fw-text-muted animate-bounce" />
                  <span className="h-2 w-2 rounded-full bg-fw-text-subtle dark:bg-fw-text-muted animate-bounce" style={{ animationDelay: '0.1s' }} />
                  <span className="h-2 w-2 rounded-full bg-fw-text-subtle dark:bg-fw-text-muted animate-bounce" style={{ animationDelay: '0.2s' }} />
                </span>
              ) : showStatusLabel && (
                runtimeStateName === 'waiting' || interrupted ? (
                  <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} data-processing-status-dot="static" />
                ) : (
                  <RuntimeBusySpinner className={`h-4 w-4 shrink-0 ${tone.text}`} />
                )
              )}
              {label && <span className={`min-w-0 text-sm leading-5 ${hasQueue ? 'break-words' : 'truncate'} ${tone.text}`} title={label}>{label}</span>}
            </div>
            {(!loading && (isActive || interrupted) || hasQueue) && (
              <div className={`ml-auto flex shrink-0 items-center gap-1 ${tone.controls}`}>
                {!loading && isActive && onStop && <button type="button" onClick={onStop} className={controlButtonClass}>Stop</button>}
                {interrupted && onContinue && <button type="button" onClick={onContinue} className={controlButtonClass}>Continue</button>}
                {hasQueue && onRunQueued && <button type="button" onClick={onRunQueued} className={controlButtonClass}>Run queued</button>}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

export default ProcessingStatus
