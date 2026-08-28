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
  message: 'text-slate-300 hover:text-slate-500 focus-visible:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400 dark:focus-visible:text-slate-400',
  processing: 'text-blue-300 hover:text-blue-500 focus-visible:text-blue-500 dark:text-blue-700 dark:hover:text-blue-400 dark:focus-visible:text-blue-400',
}

const textClasses: Record<ModelThreadTone, string> = {
  message: 'text-slate-700 dark:text-slate-300',
  processing: 'text-blue-900 dark:text-blue-100',
}

const surfaceClasses: Record<ModelThreadTone, string> = {
  message: 'my-0.5 bg-slate-100/45 dark:bg-slate-800/20',
  processing: 'my-0.5 bg-blue-50/55 dark:bg-blue-900/10',
}

const headerClasses: Record<ModelThreadTone, string> = {
  message: '-ml-2 -mr-2 bg-slate-200/80 px-2 py-1 dark:bg-slate-700/25',
  processing: '-ml-2 -mr-2 bg-blue-100/80 px-2 py-1 dark:bg-blue-800/20',
}

const headerHoverClasses: Record<ModelThreadTone, string> = {
  message: 'hover:text-slate-900 dark:hover:text-slate-100',
  processing: 'hover:text-blue-950 dark:hover:text-white',
}

export const modelThreadBodyClasses: Record<ModelThreadTone, string> = {
  message: 'prose-slate dark:prose-invert prose-p:text-slate-700 dark:prose-p:text-slate-300 prose-headings:text-slate-800 dark:prose-headings:text-slate-200 prose-strong:text-slate-900 dark:prose-strong:text-white prose-li:text-slate-700 dark:prose-li:text-slate-300',
  processing: 'prose-blue dark:prose-invert prose-p:text-blue-900 dark:prose-p:text-blue-100 prose-headings:text-blue-900 dark:prose-headings:text-blue-100 prose-strong:text-blue-950 dark:prose-strong:text-white prose-li:text-blue-900 dark:prose-li:text-blue-100',
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
