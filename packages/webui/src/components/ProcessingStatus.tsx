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

const controlButtonClass = 'rounded border border-current px-2 py-0.5 text-[11px] font-medium leading-4 transition-colors hover:bg-black/5 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10 dark:focus:ring-blue-700'

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
        surface: 'bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800',
        text: 'text-purple-600 dark:text-purple-300',
        controls: 'text-purple-700 dark:text-purple-200',
        dot: 'bg-purple-500 dark:bg-purple-400',
      }
    : runtimeStateName === 'waiting'
      ? {
          surface: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800',
          text: 'text-amber-700 dark:text-amber-300',
          controls: 'text-amber-800 dark:text-amber-200',
          dot: 'bg-amber-500 dark:bg-amber-400',
        }
      : {
          surface: 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800',
          text: 'text-blue-600 dark:text-blue-300',
          controls: 'text-blue-700 dark:text-blue-200',
          dot: 'bg-blue-500 dark:bg-blue-400',
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
              className="inline-flex max-w-full flex-wrap items-center gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-2 rounded-lg text-sm text-amber-700 dark:text-amber-300"
              data-processing-runtime-state={turnIncomplete ? 'interrupted' : undefined}
              role={turnIncomplete ? 'status' : undefined}
            >
              {turnIncomplete && <span className="w-2 h-2 bg-amber-500 dark:bg-amber-400 rounded-full" data-processing-status-dot="static" />}
              <span>{turnIncomplete ? `Turn interrupted${sessionQueueLength > 0 ? ` • ${queuedLabel} pending` : ''}` : `${queuedLabel} pending`}</span>
              <div className="flex items-center gap-1 text-amber-800 dark:text-amber-200">
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
            <div className="inline-block max-w-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 px-4 py-2 rounded-lg">
              <div className="flex space-x-2">
                <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce"></div>
                <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                <div className="w-2 h-2 bg-gray-400 dark:bg-gray-500 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
})

export default ProcessingStatus
