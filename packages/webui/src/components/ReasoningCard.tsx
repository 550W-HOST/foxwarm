import { memo, useEffect, useMemo, useState } from 'react'
import { getCollapsedReasoningPreview, renderMarkdown, ToolTag } from './chatShared'
import ThreadLineButton from './ThreadLineButton'

type ReasoningTone = 'message' | 'processing'

interface ReasoningCardProps {
  thinking: string
  tone?: ReasoningTone
  debounceMs?: number
  defaultExpanded?: boolean
}

const reasoningLineToneClasses: Record<ReasoningTone, string> = {
  message: 'text-slate-300 hover:text-slate-500 focus-visible:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400 dark:focus-visible:text-slate-400',
  processing: 'text-blue-300 hover:text-blue-500 focus-visible:text-blue-500 dark:text-blue-700 dark:hover:text-blue-400 dark:focus-visible:text-blue-400',
}

const reasoningTextClasses: Record<ReasoningTone, string> = {
  message: 'text-slate-700 dark:text-slate-300',
  processing: 'text-blue-900 dark:text-blue-100',
}

const reasoningSurfaceClasses: Record<ReasoningTone, string> = {
  message: 'my-0.5 bg-slate-100/45 dark:bg-slate-800/20',
  processing: 'my-0.5 bg-blue-50/55 dark:bg-blue-900/10',
}

const reasoningHeaderClasses: Record<ReasoningTone, string> = {
  message: '-ml-2 -mr-2 bg-slate-200/80 px-2 py-1 dark:bg-slate-700/25',
  processing: '-ml-2 -mr-2 bg-blue-100/80 px-2 py-1 dark:bg-blue-800/20',
}

const reasoningHeaderHoverClasses: Record<ReasoningTone, string> = {
  message: 'hover:text-slate-900 dark:hover:text-slate-100',
  processing: 'hover:text-blue-950 dark:hover:text-white',
}

const reasoningBodyClasses: Record<ReasoningTone, string> = {
  message: 'prose-slate dark:prose-invert prose-p:text-slate-700 dark:prose-p:text-slate-300 prose-headings:text-slate-800 dark:prose-headings:text-slate-200 prose-strong:text-slate-900 dark:prose-strong:text-white prose-li:text-slate-700 dark:prose-li:text-slate-300',
  processing: 'prose-blue dark:prose-invert prose-p:text-blue-900 dark:prose-p:text-blue-100 prose-headings:text-blue-900 dark:prose-headings:text-blue-100 prose-strong:text-blue-950 dark:prose-strong:text-white prose-li:text-blue-900 dark:prose-li:text-blue-100',
}

const extractOpenAIReasoningSummaryTitles = (text: string): string[] => {
  const trimmed = text.trimStart()
  if (!/^\*\*[^*\n]+\*\*\s*(?:\r?\n|$)/.test(trimmed)) {
    return []
  }

  const titles: string[] = []
  const titleLinePattern = /^\*\*([^*\n]+)\*\*\s*$/gm
  let match: RegExpExecArray | null
  while ((match = titleLinePattern.exec(trimmed)) !== null) {
    const title = match[1].trim()
    if (title) titles.push(title)
  }
  return titles
}

const getReasoningPreview = (text: string): { text: string; isOpenAISummary: boolean } => {
  const titles = extractOpenAIReasoningSummaryTitles(text)
  return titles.length > 0
    ? { text: titles.join(' / '), isOpenAISummary: true }
    : { text: getCollapsedReasoningPreview(text), isOpenAISummary: false }
}

const ReasoningCard = memo(function ReasoningCard({
  thinking,
  tone = 'message',
  debounceMs = 0,
  defaultExpanded,
}: ReasoningCardProps) {
  const [expanded, setExpanded] = useState(defaultExpanded ?? tone === 'processing')
  const [displayThinking, setDisplayThinking] = useState(thinking)

  useEffect(() => {
    if (debounceMs <= 0) {
      setDisplayThinking(thinking)
      return
    }

    const timeout = window.setTimeout(() => {
      setDisplayThinking(thinking)
    }, debounceMs)

    return () => {
      window.clearTimeout(timeout)
    }
  }, [debounceMs, thinking])

  const collapsedPreview = useMemo(() => getReasoningPreview(displayThinking), [displayThinking])
  const html = useMemo(() => renderMarkdown(displayThinking), [displayThinking])

  if (!thinking.trim()) return null

  return (
    <div
      className={`relative group pl-2 pr-2 text-xs ${reasoningSurfaceClasses[tone]} ${expanded ? 'pb-1' : ''} ${reasoningTextClasses[tone]} ${!expanded ? 'cursor-pointer [&_*]:cursor-pointer' : ''}`}
      onClick={!expanded ? () => setExpanded(true) : undefined}
    >
      <ThreadLineButton
        expanded={expanded}
        onToggle={() => setExpanded(current => !current)}
        label={expanded ? 'Collapse reasoning' : 'Expand reasoning'}
        className={reasoningLineToneClasses[tone]}
      />
      <div
        className={`${expanded ? 'mb-1' : ''} flex min-w-0 items-center gap-2 ${reasoningHeaderClasses[tone]} ${expanded ? `cursor-pointer ${reasoningHeaderHoverClasses[tone]}` : ''}`}
        onClick={expanded ? (e) => { e.stopPropagation(); setExpanded(false) } : undefined}
      >
        <ToolTag name="reasoning" label="Reasoning" tone="neutral" />
        {!expanded && (
          <span className={`min-w-0 flex-1 truncate text-[13px] leading-[18px] ${collapsedPreview.isOpenAISummary ? 'font-semibold' : 'font-normal'}`} title={collapsedPreview.text}>
            {collapsedPreview.text}
          </span>
        )}
      </div>
      {expanded && (
        <div
          className={`foxwarm-markdown prose max-w-none text-[13px] prose-p:my-1 prose-headings:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 ${reasoningBodyClasses[tone]}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  )
})

export default ReasoningCard
