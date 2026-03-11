import { memo, useMemo } from 'react'
import { getCollapsedReasoningPreview, renderMarkdown } from './chatShared'

interface ProcessingStatusProps {
  sessionBusy: boolean
  sessionQueueLength: number
  loading: boolean
  processingReasoningSummary: string
  isMobile: boolean
}

const ProcessingReasoningCard = memo(function ProcessingReasoningCard({ thinking }: { thinking: string }) {
  const html = useMemo(() => renderMarkdown(thinking), [thinking])
  const collapsedPreview = useMemo(() => getCollapsedReasoningPreview(thinking), [thinking])

  if (!thinking.trim()) return null

  return (
    <div className="rounded-lg border px-3 py-2 bg-white/80 dark:bg-gray-900/40 border-blue-200 dark:border-blue-700/60 text-blue-900 dark:text-blue-100">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 text-[11px] font-medium uppercase tracking-wide text-blue-600 dark:text-blue-300">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0">Reasoning</span>
            <span className="min-w-0 flex-1 truncate normal-case text-sm font-normal tracking-normal" title={collapsedPreview}>
              {collapsedPreview}
            </span>
          </div>
        </div>
      </div>
      <div
        className="foxwarm-markdown prose prose-sm max-w-none prose-blue dark:prose-invert prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 prose-p:text-blue-900 dark:prose-p:text-blue-100 prose-headings:text-blue-900 dark:prose-headings:text-blue-100 prose-strong:text-blue-950 dark:prose-strong:text-white prose-li:text-blue-900 dark:prose-li:text-blue-100"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
})

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
              {processingReasoningSummary && (
                <div className="mt-2 max-w-full overflow-x-hidden">
                  <ProcessingReasoningCard thinking={processingReasoningSummary} />
                </div>
              )}
            </div>
          </div>
        </div>
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
