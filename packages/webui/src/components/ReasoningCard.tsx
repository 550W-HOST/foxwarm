import { memo, useEffect, useMemo, useState } from 'react'
import { getCollapsedReasoningPreview, handleMarkdownLinkClick, renderMarkdown } from './chatShared'
import ModelThreadCard, { modelThreadBodyClasses } from './ModelThreadCard'

type ReasoningTone = 'message' | 'processing'

interface ReasoningCardProps {
  thinking: string
  tone?: ReasoningTone
  debounceMs?: number
  defaultExpanded?: boolean
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
    <ModelThreadCard
      kind="reasoning"
      label="Reasoning"
      preview={collapsedPreview.text}
      previewClassName={collapsedPreview.isOpenAISummary ? 'font-semibold' : 'font-normal'}
      tone={tone}
      defaultExpanded={defaultExpanded}
    >
      <div
        className={`foxwarm-markdown foxwarm-reasoning-body prose max-w-none text-[13px] prose-p:my-1 prose-headings:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 ${modelThreadBodyClasses[tone]}`}
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={handleMarkdownLinkClick}
      />
    </ModelThreadCard>
  )
})

export default ReasoningCard
