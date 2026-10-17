import { memo } from 'react'
import RuntimeBusySpinner from './RuntimeBusySpinner'
import { FoxThinking, FoxSleeping } from './FoxLoaders'
import FoxThinkingText from './FoxThinkingText'
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
  onContinue?: () => void
}

const controlButtonClass = 'inline-flex shrink-0 items-center rounded-md px-2 text-fw-text-muted transition-colors hover:bg-fw-hover hover:text-fw-text-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fw-focus-ring disabled:cursor-not-allowed disabled:opacity-50'

const ProcessingStatus = memo(function ProcessingStatus({
  sessionBusy,
  runtimeState,
  sessionQueueLength,
  turnIncomplete,
  loading,
  isMobile,
  timelineView,
  onContinue,
}: ProcessingStatusProps) {
  const rowWidthClass = isMobile ? 'w-full' : 'w-full max-w-[80%]'
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
  const rotateThinkingCopy = runtimeStateName === 'requesting-model' && !isCompacting
  const isExec = runtimeStateName === 'running-tool' && /(?:^|[.:/])exec$/.test(runtimeState?.tool?.name || '')
  const rotateStatusCopy = !loading && (rotateThinkingCopy || isExec)
  const execDetails = isExec ? [runtimeSummary, runtimeState?.tool?.executionNode, runtimeState?.tool?.argsPreview].filter(Boolean).join(' · ') : undefined
  const tone = runtimeStateName === 'running-tool'
    ? {
        text: 'text-fw-special dark:text-fw-special',
        dot: 'bg-fw-special dark:bg-fw-special',
      }
    : runtimeStateName === 'waiting' || runtimeStateName === 'idle'
      ? {
          text: 'text-fw-warning dark:text-fw-warning',
          dot: 'bg-fw-warning dark:bg-fw-warning',
        }
      : {
          text: 'text-fw-accent dark:text-fw-accent',
          dot: 'bg-fw-accent dark:bg-fw-accent',
        }
  const interrupted = runtimeStateName === 'idle' && turnIncomplete && !loading
  const statusLabel = interrupted ? 'Turn interrupted' : visibleRuntimeSummary
  const hasQueue = sessionQueueLength > 0
  const showStatusLabel = showRuntimeStatus || interrupted

  return (
    <div data-processing-status-slot className={hasQueue ? 'flex min-h-14 items-end pt-4' : 'flex h-14 items-end'}>
      {(loading || showStatusLabel) && (
        <div role="status" className={`fw-processing-control-group flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 ${rotateStatusCopy ? `fw-processing-animated ${isExec ? 'fw-processing-exec' : ''}` : ''} ${rowWidthClass}`}>
          {(loading || showStatusLabel) && (
            <div className="fw-processing-main flex min-w-0 max-w-full items-center gap-3">
              <div className="fw-processing-badge inline-flex h-8 min-w-0 max-w-full items-center gap-2.5"
                data-processing-runtime-state={loading ? undefined : interrupted ? 'interrupted' : runtimeStateName}>
                {loading ? <FoxThinking label="Loading" size={24} /> : (
                  <>
                    {runtimeStateName === 'waiting' ? (
                      <FoxSleeping className={tone.text} />
                    ) : interrupted ? (
                      <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} data-processing-status-dot="static" />
                    ) : rotateStatusCopy ? (
                      <FoxThinking className="shrink-0" size={24} />
                    ) : <RuntimeBusySpinner className={`h-5 w-5 shrink-0 ${tone.text}`} />}
                    {rotateStatusCopy ? (
                      <span className={`inline-flex min-w-0 items-baseline text-lg leading-7 ${tone.text}`}>
                        <FoxThinkingText mode={isExec ? 'exec' : 'thinking'} label={statusLabel} title={execDetails} />
                      </span>
                    ) : <span className={`min-w-0 truncate text-lg leading-7 ${tone.text}`} title={statusLabel}>{statusLabel}</span>}
                  </>
                )}
              </div>

              {interrupted && onContinue && <button type="button" onClick={onContinue} className={`${controlButtonClass} h-8 text-sm`}>Continue</button>}
            </div>
          )}

        </div>
      )}
    </div>
  )
})

/** Queue controls belong to the final visible message, not the runtime status row. */
export const QueuedMessageStatus = memo(function QueuedMessageStatus({ count, alignment, isMobile, onRunQueued }: {
  count: number
  alignment: 'left' | 'right'
  isMobile: boolean
  onRunQueued?: () => void
}) {
  if (count <= 0) return null
  return (
    <div data-processing-queue-footer data-alignment={alignment} className={`mt-1.5 flex w-full min-w-0 ${alignment === 'right' ? 'justify-end' : 'justify-start'}`}>
      <div data-processing-queue-status role="status" className={`flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 text-xs leading-5 text-fw-text-muted ${isMobile ? 'max-w-full' : 'max-w-[80%]'} ${alignment === 'right' ? 'justify-end text-right' : 'justify-start text-left'}`}>
        <span>{count} queued</span>
        {onRunQueued && <button type="button" onClick={onRunQueued} className={`${controlButtonClass} text-xs leading-5`}>Run queued</button>}
      </div>
    </div>
  )
})

export default ProcessingStatus
