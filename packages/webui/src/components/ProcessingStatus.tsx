import { memo } from 'react'

interface ProcessingStatusProps {
  sessionBusy: boolean
  sessionQueueLength: number
  loading: boolean
  isMobile: boolean
  onStop?: () => void
  onRunQueued?: () => void
}

const controlButtonClass = 'rounded border border-current px-2 py-0.5 text-[11px] font-medium leading-4 transition-colors hover:bg-black/5 focus:outline-none focus:ring-2 focus:ring-blue-300 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10 dark:focus:ring-blue-700'

const ProcessingStatus = memo(function ProcessingStatus({
  sessionBusy,
  sessionQueueLength,
  loading,
  isMobile,
  onStop,
  onRunQueued,
}: ProcessingStatusProps) {
  const rowWidthClass = isMobile ? 'w-full' : 'w-full max-w-[80%]'
  const queuedLabel = `${sessionQueueLength} queued message${sessionQueueLength > 1 ? 's' : ''}`

  return (
    <>
      {sessionBusy && !loading && (
        <>
          <div className="flex justify-start mt-4">
            <div className={`${rowWidthClass} overflow-x-hidden`}>
              <div className="inline-block max-w-full bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-4 py-2 rounded-lg">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex space-x-1">
                    <div className="w-2 h-2 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce"></div>
                    <div className="w-2 h-2 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                    <div className="w-2 h-2 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                  </div>
                  <span className="text-sm text-blue-600 dark:text-blue-300">Processing{sessionQueueLength > 0 ? ` • ${sessionQueueLength} queued` : ''}...</span>
                  <div className="ml-auto flex items-center gap-1 text-blue-700 dark:text-blue-200">
                    <button type="button" onClick={onStop} className={controlButtonClass}>Stop</button>
                    {sessionQueueLength > 0 && (
                      <button type="button" onClick={onRunQueued} className={controlButtonClass}>Run queued</button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
      {!sessionBusy && !loading && sessionQueueLength > 0 && (
        <div className="flex justify-start mt-4">
          <div className={`${rowWidthClass} overflow-x-hidden`}>
            <div className="inline-flex max-w-full flex-wrap items-center gap-2 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-2 rounded-lg text-sm text-amber-700 dark:text-amber-300">
              <span>{queuedLabel} pending</span>
              <button type="button" onClick={onRunQueued} className={`${controlButtonClass} text-amber-800 dark:text-amber-200`}>Run queued</button>
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
