import { memo } from 'react'
import RuntimeBusySpinner from './RuntimeBusySpinner'
import { FoxThinking } from './FoxLoaders'
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

  return (
    <>
      <div data-processing-status-slot className="h-10 pt-2">
        {(loading || showRuntimeStatus || interrupted) && (
          <div className={`min-w-0 ${rowWidthClass}`}>
            <div
              className={`inline-flex h-8 max-w-full items-center gap-2 rounded-lg border px-3 ${loading ? 'bg-fw-surface border-fw-border' : tone.surface}`}
              data-processing-runtime-state={loading ? undefined : interrupted ? 'interrupted' : runtimeStateName}
              role="status"
            >
              {loading ? (
                <FoxThinking label="Waiting for response" />
              ) : (
                <>
                  {runtimeStateName === 'waiting' || interrupted ? (
                    <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} data-processing-status-dot="static" />
                  ) : runtimeStateName === 'requesting-model' && !isCompacting ? (
                    <FoxThinking className="shrink-0" />
                  ) : (
                    <RuntimeBusySpinner className={`h-4 w-4 shrink-0 ${tone.text}`} />
                  )}
                  <span className={`min-w-0 truncate text-sm leading-5 ${tone.text}`} title={statusLabel}>{statusLabel}</span>
                  {(isActive || interrupted) && (
                    <div className={`ml-auto flex shrink-0 items-center gap-1 ${tone.controls}`}>
                      {isActive && onStop && <button type="button" onClick={onStop} className={controlButtonClass}>Stop</button>}
                      {interrupted && onContinue && <button type="button" onClick={onContinue} className={controlButtonClass}>Continue</button>}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {sessionQueueLength > 0 && (
        <div data-processing-queue-status role="status" className={`mt-2 min-w-0 ${rowWidthClass}`}>
          <div className={`inline-flex max-w-full flex-wrap items-center gap-2 rounded-lg border px-3 py-1 text-sm ${tone.surface} ${tone.text}`}>
            <span className="min-w-0 break-words">{queueLabel}</span>
            {onRunQueued && <button type="button" onClick={onRunQueued} className={`shrink-0 ${controlButtonClass}`}>Run queued</button>}
          </div>
        </div>
      )}
    </>
  )
})

export default ProcessingStatus
