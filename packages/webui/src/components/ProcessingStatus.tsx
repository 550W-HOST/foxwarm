import { memo } from 'react'
import { getRuntimeStateSummary, type SessionRuntimeState } from '../sessionRuntimeState'

interface ProcessingStatusProps {
  sessionBusy: boolean
  runtimeState?: SessionRuntimeState
  sessionQueueLength: number
  turnIncomplete: boolean
  loading: boolean
  isMobile: boolean
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
  onStop,
  onRunQueued,
  onContinue,
}: ProcessingStatusProps) {
  const rowWidthClass = isMobile ? 'w-full' : 'w-full max-w-[80%]'
  const queuedLabel = `${sessionQueueLength} queued message${sessionQueueLength > 1 ? 's' : ''}`
  const runtimeStateName = runtimeState?.state || (sessionBusy ? 'requesting-model' : 'idle')
  const showRuntimeStatus = runtimeStateName !== 'idle' && !loading
  const runtimeSummary = getRuntimeStateSummary(runtimeState, sessionBusy)
  const visibleRuntimeSummary = runtimeStateName === 'requesting-model'
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
    : runtimeStateName === 'waiting'
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
    ? runtimeStateName === 'running-tool'
      ? `${queuedLabel} will be inserted after this tool call`
      : runtimeStateName === 'waiting'
        ? `${queuedLabel} will be inserted when this session resumes`
        : `${queuedLabel} will be inserted after this model response`
    : ''

  return (
    <>
      {showRuntimeStatus && (
        <div className="flex justify-start mt-4">
          <div className={`${rowWidthClass} overflow-x-hidden`}>
            <div
              className={`inline-block max-w-full border px-4 py-2 rounded-lg ${tone.surface}`}
              data-processing-runtime-state={runtimeStateName}
              role="status"
            >
              <div className="flex flex-wrap items-center gap-2">
                {runtimeStateName === 'waiting' ? (
                  <span className={`w-2 h-2 ${tone.dot} rounded-full`} data-processing-status-dot="static" />
                ) : (
                  <span className="flex space-x-1" data-processing-status-dots="animated">
                    <span className={`w-2 h-2 ${tone.dot} rounded-full animate-bounce`} />
                    <span className={`w-2 h-2 ${tone.dot} rounded-full animate-bounce`} style={{ animationDelay: '0.1s' }} />
                    <span className={`w-2 h-2 ${tone.dot} rounded-full animate-bounce`} style={{ animationDelay: '0.2s' }} />
                  </span>
                )}
                <span className={`text-sm ${tone.text}`}>
                  {visibleRuntimeSummary}{queuedContinuation ? ` • ${queuedContinuation}` : ''}
                </span>
                {(isActive || sessionQueueLength > 0) && (
                  <div className={`ml-auto flex items-center gap-1 ${tone.controls}`}>
                    {isActive && (
                      <button type="button" onClick={onStop} className={controlButtonClass}>Stop</button>
                    )}
                    {sessionQueueLength > 0 && (
                      <button type="button" onClick={onRunQueued} className={controlButtonClass}>Run queued</button>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
      {runtimeStateName === 'idle' && !loading && (turnIncomplete || sessionQueueLength > 0) && (
        <div className="flex justify-start mt-4">
          <div className={`${rowWidthClass} overflow-x-hidden`}>
            <div
              className="inline-flex max-w-full flex-wrap items-center gap-2 bg-fw-warning-surface dark:bg-fw-warning-surface-strong/20 border border-fw-warning-border dark:border-fw-warning-border px-4 py-2 rounded-lg text-sm text-fw-warning dark:text-fw-warning"
              data-processing-runtime-state={turnIncomplete ? 'interrupted' : undefined}
              role={turnIncomplete ? 'status' : undefined}
            >
              {turnIncomplete && <span className="w-2 h-2 bg-fw-warning dark:bg-fw-warning rounded-full" data-processing-status-dot="static" />}
              <span>{turnIncomplete ? `Turn interrupted${sessionQueueLength > 0 ? ` • ${queuedLabel} pending` : ''}` : `${queuedLabel} pending`}</span>
              <div className="flex items-center gap-1 text-fw-warning dark:text-fw-warning">
                {turnIncomplete && <button type="button" onClick={onContinue} className={controlButtonClass}>Continue</button>}
                {sessionQueueLength > 0 && <button type="button" onClick={onRunQueued} className={controlButtonClass}>Run queued</button>}
              </div>
            </div>
          </div>
        </div>
      )}
      {loading && (
        <div className="flex justify-start mt-4">
          <div className={`${rowWidthClass} overflow-x-hidden`}>
            <div className="inline-block max-w-full bg-fw-surface border border-fw-border px-4 py-2 rounded-lg">
              <div className="flex space-x-2">
                <div className="w-2 h-2 bg-fw-text-subtle dark:bg-fw-text-muted rounded-full animate-bounce"></div>
                <div className="w-2 h-2 bg-fw-text-subtle dark:bg-fw-text-muted rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                <div className="w-2 h-2 bg-fw-text-subtle dark:bg-fw-text-muted rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
})

export default ProcessingStatus
