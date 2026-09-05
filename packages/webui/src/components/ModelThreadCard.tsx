import { type ReactNode, useState } from 'react'
import { THREAD_CARD_HEADER_PREVIEW_CLASS, THREAD_CARD_HEADER_ROW_CLASS, ToolTag } from './chatShared'
import ThreadLineButton from './ThreadLineButton'
import { useThreadCardOverflowFade } from './useThreadCardOverflowFade'

type ModelThreadTone = 'message' | 'processing'

interface ModelThreadCardProps {
  kind: 'reasoning' | 'web-search'
  label: string
  iconName?: string
  preview: string
  previewClassName?: string
  children: ReactNode
  tone?: ModelThreadTone
  defaultExpanded?: boolean
}

const lineToneClasses: Record<ModelThreadTone, string> = {
  message: 'text-fw-thread-text hover:text-fw-text-muted focus-visible:text-fw-text-muted',
  processing: 'text-fw-system-accent hover:text-fw-system-accent focus-visible:text-fw-system-accent',
}

const textClasses: Record<ModelThreadTone, string> = {
  message: 'text-fw-thread-text',
  processing: 'text-fw-system-accent',
}

const surfaceClasses: Record<ModelThreadTone, string> = {
  message: 'my-0.5 bg-fw-reasoning-surface/45 dark:bg-fw-reasoning-surface/20',
  processing: 'my-0.5 bg-fw-system-surface/55 dark:bg-fw-system-surface/10',
}

const headerClasses: Record<ModelThreadTone, string> = {
  message: '-ml-2 -mr-2 bg-fw-reasoning-surface-strong/80 px-2 py-1 dark:bg-fw-reasoning-surface-strong/25',
  processing: '-ml-2 -mr-2 bg-fw-system-surface-strong/80 px-2 py-1 dark:bg-fw-system-surface-strong/20',
}

const headerHoverClasses: Record<ModelThreadTone, string> = {
  message: 'hover:text-fw-text-strong dark:hover:text-fw-text-strong',
  processing: 'hover:text-fw-system-accent',
}

export const modelThreadBodyClasses: Record<ModelThreadTone, string> = {
  message: 'prose-slate dark:prose-invert prose-p:text-fw-thread-text prose-headings:text-fw-text-strong prose-strong:text-fw-text-strong prose-li:text-fw-thread-text',
  processing: 'prose-blue dark:prose-invert prose-p:text-fw-system-accent prose-headings:text-fw-system-accent prose-strong:text-fw-system-accent prose-li:text-fw-system-accent',
}

const ModelThreadCard = ({
  kind,
  label,
  iconName,
  preview,
  previewClassName = '',
  children,
  tone = 'message',
  defaultExpanded,
}: ModelThreadCardProps) => {
  const [expanded, setExpanded] = useState(defaultExpanded ?? tone === 'processing')
  const previewFade = useThreadCardOverflowFade<HTMLSpanElement>('right', !expanded)
  const semanticPrefix = `foxwarm-${kind}`
  const readableKind = kind === 'web-search' ? 'web search' : kind

  return (
    <div
      data-model-thread-card={kind}
      data-model-thread-tone={tone}
      className={`${semanticPrefix}-card ${semanticPrefix}-card-${tone} relative group min-w-0 max-w-full pl-2 pr-2 text-xs ${surfaceClasses[tone]} ${expanded ? 'pb-1' : ''} ${textClasses[tone]} ${!expanded ? 'cursor-pointer [&_*]:cursor-pointer' : ''}`}
      onClick={!expanded ? () => setExpanded(true) : undefined}
    >
      <ThreadLineButton
        expanded={expanded}
        onToggle={() => setExpanded(current => !current)}
        label={expanded ? `Collapse ${readableKind}` : `Expand ${readableKind}`}
        className={`${semanticPrefix}-thread-line ${lineToneClasses[tone]}`}
      />
      <div
        className={`${semanticPrefix}-header ${expanded ? 'mb-1' : ''} ${THREAD_CARD_HEADER_ROW_CLASS} ${headerClasses[tone]} ${expanded ? `cursor-pointer ${headerHoverClasses[tone]}` : ''}`}
        onClick={expanded ? (event) => { event.stopPropagation(); setExpanded(false) } : undefined}
      >
        <ToolTag name={kind} iconName={iconName} label={label} tone="neutral" className={`${semanticPrefix}-tag`} />
        {!expanded && (
          <span ref={previewFade.ref} {...previewFade.overflowFadeProps} className={`${semanticPrefix}-preview ${THREAD_CARD_HEADER_PREVIEW_CLASS} ${previewClassName}`} title={preview}>
            {preview}
          </span>
        )}
      </div>
      {expanded && children}
    </div>
  )
}

export default ModelThreadCard
