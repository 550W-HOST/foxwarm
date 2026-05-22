import { memo } from 'react'
import ReasoningCard from './ReasoningCard'

interface ProcessingStatusProps {
  sessionBusy: boolean
  sessionQueueLength: number
  loading: boolean
  processingReasoningSummary: string
  isMobile: boolean
}

const ProcessingStatus = memo(function ProcessingStatus({
  sessionBusy,
  sessionQueueLength,
  loading,
  processingReasoningSummary,
  isMobile,
}: ProcessingStatusProps) {
  const rowWidthClass = isMobile ? 'w-full' : 'w-full max-w-[80%]'

  return (
    <>
      {sessionBusy && !loading && (
        <>
          <div className="flex justify-start mt-4">
            <div className={`${rowWidthClass} overflow-x-hidden`}>
              <div className="inline-block max-w-full bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-4 py-2 rounded-lg">
                <div className="flex items-center space-x-2">
                  <div className="flex space-x-1">
                    <div className="w-2 h-2 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce"></div>
                    <div className="w-2 h-2 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                    <div className="w-2 h-2 bg-blue-500 dark:bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                  </div>
                  <span className="text-sm text-blue-600 dark:text-blue-300">Processing{sessionQueueLength > 0 ? ` • ${sessionQueueLength} queued` : ''}...</span>
                </div>
              </div>
            </div>
          </div>
          {processingReasoningSummary && (
            <div className="flex justify-start mt-2">
              <div className={`${rowWidthClass} overflow-visible`}>
                <ReasoningCard thinking={processingReasoningSummary} tone="processing" debounceMs={30} />
              </div>
            </div>
          )}
        </>
      )}
      {!sessionBusy && !loading && sessionQueueLength > 0 && (
        <div className="flex justify-start mt-4">
          <div className={`${rowWidthClass} overflow-x-hidden`}>
            <div className="inline-block max-w-full bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 px-4 py-2 rounded-lg text-sm text-amber-700 dark:text-amber-300">
              {sessionQueueLength} queued message{sessionQueueLength > 1 ? 's' : ''} pending
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
