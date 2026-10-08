import { memo, useEffect, useMemo, useState } from 'react'
import { getCollapsedReasoningPreview, handleMarkdownLinkClick, renderMarkdownSegments } from './chatShared'
import MarkdownHtmlSegment from './MarkdownHtmlSegment'
import ModelThreadCard, { modelThreadBodyClasses } from './ModelThreadCard'
import type { ReasoningRunPart } from './reasoningParts'

type ReasoningTone = 'message' | 'processing'

interface ReasoningCardProps {
  thinking: string
  tone?: ReasoningTone
  debounceMs?: number
  defaultExpanded?: boolean
  searchReveal?: boolean
  searchPartIndex?: number
  parts?: ReasoningRunPart[]
  reasoningTokens?: number
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
  searchReveal,
  searchPartIndex,
  parts,
  reasoningTokens,
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
  const renderedParts = useMemo(() => (parts || [{ thinking: displayThinking, partIndex: searchPartIndex }])
    .map(part => ({ ...part, segments: renderMarkdownSegments(part.thinking) })), [displayThinking, parts, searchPartIndex])

  return (
    <ModelThreadCard
      kind="reasoning"
      label={`Reasoning${parts && parts.length > 1 ? ` ×${parts.length}` : ''}`}
      headerInfo={reasoningTokens !== undefined ? <span data-reasoning-tokens className="inline-flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums text-fw-text-muted" title="Message reasoning tokens">{reasoningTokens} tokens</span> : undefined}
      preview={collapsedPreview.text}
      previewClassName={collapsedPreview.isOpenAISummary ? 'font-semibold' : 'font-normal'}
      tone={tone}
      defaultExpanded={defaultExpanded}
      searchReveal={searchReveal}
    >
      {renderedParts.map(part => <div
        key={part.partIndex ?? 'single'}
        data-search-surface="reasoning"
        data-search-part-index={part.partIndex}
        className={`foxwarm-markdown foxwarm-reasoning-body prose max-w-none text-[13px] prose-p:my-1 prose-headings:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 ${modelThreadBodyClasses[tone]}`}
        onClick={handleMarkdownLinkClick}
      >
        {part.segments.map(segment => (
          <MarkdownHtmlSegment key={`markdown-token-${segment.tokenIndex}`} html={segment.html} />
        ))}
      </div>)}
    </ModelThreadCard>
  )
})

export default ReasoningCard
