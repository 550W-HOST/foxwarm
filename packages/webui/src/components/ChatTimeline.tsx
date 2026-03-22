import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, UIEvent } from 'react'
import { Eye, Code, FileJson, Copy, Check, X } from 'lucide-react'
import {
  Diff,
  IconToggleButton,
  MiniToggleButton,
  ToolLabel,
  ToolTag,
  ToolTagList,
  SessionHashLink,
  buildPatchHunkSnippets,
  clampContentStyle,
  copyTextToClipboard,
  formatObject,
  formatStructuredSystemText,
  getCollapsedReasoningPreview,
  isCollapsibleSystemText,
  isHeavySystemTextLine,
  isLightweightStructuredSystem,
  isSystemLikeText,
  parseAnsi,
  parseApplyPatchPreview,
  renderMarkdown,
  renderSystemTextWithSessionLinks,
  type FunctionCall,
  type FunctionResponse,
  type Message,
  type MessagePart,
  type ToolTagItem,
  type ToolViewMode,
  type ViewMode,
} from './chatShared'

interface ChatTimelineProps {
  messages: Message[]
  isMobile: boolean
  verbose: boolean
}

const MarkdownContent = memo(function MarkdownContent({ text, className }: { text: string; className: string }) {
  const html = useMemo(() => renderMarkdown(text), [text])
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />
})

const ImageParts = memo(function ImageParts({ imageParts, keyPrefix }: { imageParts: MessagePart[]; keyPrefix: string }) {
  if (imageParts.length === 0) return null

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {imageParts.map((part, idx) => {
        const { data, mimeType } = part.inlineData!
        const src = `data:${mimeType};base64,${data}`
        return (
          <div key={`${keyPrefix}-${idx}`} className="relative group cursor-pointer" onClick={() => window.open(src, '_blank')}>
            <img
              src={src}
              alt={`Image ${idx + 1}`}
              className="max-w-[300px] max-h-[200px] rounded-lg border border-gray-200 dark:border-gray-600 hover:opacity-90 transition"
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition rounded-lg pointer-events-none" />
          </div>
        )
      })}
    </div>
  )
})

const InlineMetaPart = memo(function InlineMetaPart({ systemText, isUser }: { systemText: string; isUser: boolean }) {
  return (
    <pre
      className={`whitespace-pre-wrap font-sans ${isUser ? 'text-white' : 'text-gray-500 dark:text-gray-400'}`}
      style={{ fontSize: '70%', lineHeight: '1.1em', opacity: 0.7 }}
    >
      {systemText.split('\n').map((line, lineIdx) => (
        <span key={lineIdx} style={{ display: 'block' }}>{renderSystemTextWithSessionLinks(line)}</span>
      ))}
    </pre>
  )
})

const CollapsibleUserText = memo(function CollapsibleUserText({ text }: { text: string }) {
  const isSystemMessage = isCollapsibleSystemText(text)
  const [expanded, setExpanded] = useState(false)
  const shouldCollapse = isSystemMessage && !expanded

  return (
    <div>
      <div className={shouldCollapse ? 'overflow-hidden' : ''} style={shouldCollapse ? { maxHeight: 'calc(1.5em * 4)' } : {}}>
        <pre className="whitespace-pre-wrap font-sans" style={{ lineHeight: '1.5em' }}>
          {text.split('\n').map((line, lineIdx) => {
            const isPrefix = /^\[(SYSTEM|FROM):/.test(line)
            return (
              <span
                key={lineIdx}
                style={isPrefix
                  ? { display: 'block', fontSize: '70%', lineHeight: '1em', opacity: 0.7 }
                  : { display: 'block' }
                }
              >
                {line}
              </span>
            )
          })}
        </pre>
      </div>
      {isSystemMessage && (
        <button
          onClick={() => setExpanded(current => !current)}
          className="text-xs text-blue-200 hover:text-white mt-1 text-left"
        >
          {expanded ? '▲ Show less' : '▼ Show more'}
        </button>
      )}
    </div>
  )
})

const SystemLikeMessageCard = memo(function SystemLikeMessageCard({ msg, messageKey }: { msg: Message; messageKey: string }) {
  const [expanded, setExpanded] = useState(false)
  const allLines = useMemo(() => msg.parts.flatMap((part) => {
    if (part.system) {
      return formatStructuredSystemText(part.system).split('\n')
    }
    if (part.text) {
      return part.text.split('\n')
    }
    return []
  }), [msg.parts])

  const renderedText = allLines.join('\n')
  const shouldCollapse = !expanded

  return (
    <div className="w-full overflow-x-hidden">
      <div className="bg-slate-50 dark:bg-slate-900/30 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 text-slate-700 dark:text-slate-300">
        <div className={shouldCollapse ? 'overflow-hidden' : ''} style={shouldCollapse ? { maxHeight: 'calc(1.5em * 4)' } : undefined}>
          <pre className="whitespace-pre-wrap font-sans text-sm" style={{ lineHeight: '1.5em' }}>
            {renderedText.split('\n').map((line, lineIdx) => {
              const isPrefix = isSystemLikeText(line)
              return (
                <span
                  key={`${messageKey}-${lineIdx}`}
                  style={isPrefix
                    ? { display: 'block', fontSize: '70%', lineHeight: '1.1em', opacity: 0.7 }
                    : { display: 'block', opacity: 0.92 }
                  }
                >
                  {renderSystemTextWithSessionLinks(line)}
                </span>
              )
            })}
          </pre>
        </div>
        {allLines.length > 4 && (
          <button
            onClick={() => setExpanded(current => !current)}
            className="text-xs mt-2 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 text-left"
          >
            {expanded ? '▲ Show less' : '▼ Show more'}
          </button>
        )}
      </div>
      <ImageParts imageParts={msg.parts.filter(p => p.inlineData)} keyPrefix={messageKey} />
    </div>
  )
})

const ReasoningSummaryCard = memo(function ReasoningSummaryCard({ thinking, tone }: { thinking: string; tone: 'message' | 'processing' }) {
  const [expanded, setExpanded] = useState(tone === 'processing')
  const collapsedPreview = useMemo(() => getCollapsedReasoningPreview(thinking), [thinking])

  useEffect(() => {
    if (tone === 'processing') {
      setExpanded(true)
    }
  }, [tone, thinking])

  if (!thinking.trim()) return null

  const containerClass = tone === 'processing'
    ? 'bg-white/80 dark:bg-gray-900/40 border-blue-200 dark:border-blue-700/60 text-blue-900 dark:text-blue-100'
    : 'bg-slate-50 dark:bg-slate-900/30 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300'
  const labelClass = tone === 'processing'
    ? 'text-blue-600 dark:text-blue-300'
    : 'text-slate-500 dark:text-slate-400'
  const bodyClass = tone === 'processing'
    ? 'prose-blue dark:prose-invert prose-p:text-blue-900 dark:prose-p:text-blue-100 prose-headings:text-blue-900 dark:prose-headings:text-blue-100 prose-strong:text-blue-950 dark:prose-strong:text-white prose-li:text-blue-900 dark:prose-li:text-blue-100'
    : 'prose-slate dark:prose-invert prose-p:text-slate-700 dark:prose-p:text-slate-300 prose-headings:text-slate-800 dark:prose-headings:text-slate-200 prose-strong:text-slate-900 dark:prose-strong:text-white prose-li:text-slate-700 dark:prose-li:text-slate-300'
  const isProcessing = tone === 'processing'
  const isInteractive = !isProcessing
  const toggleExpanded = () => {
    if (!isInteractive) return
    setExpanded(current => !current)
  }

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${containerClass} ${isInteractive && !expanded ? 'cursor-pointer' : ''}`}
      onClick={!expanded && isInteractive ? toggleExpanded : undefined}
    >
      <div
        className={`mb-1 flex items-start justify-between gap-3 ${isInteractive ? 'cursor-pointer' : ''}`}
        onClick={expanded && isInteractive ? toggleExpanded : undefined}
      >
        <div className={`min-w-0 flex-1 text-[11px] font-medium uppercase tracking-wide ${labelClass}`}>
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0">Reasoning</span>
            {!expanded && (
              <span className="min-w-0 flex-1 truncate normal-case text-sm font-normal tracking-normal" title={collapsedPreview}>
                {collapsedPreview}
              </span>
            )}
          </div>
        </div>
        {!isProcessing && (
          <button
            onClick={(e) => {
              e.stopPropagation()
              toggleExpanded()
            }}
            className="shrink-0 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            {expanded ? '▲ Show less' : '▼ Show more'}
          </button>
        )}
      </div>
      {expanded ? (
        <MarkdownContent
          text={thinking}
          className={`foxwarm-markdown prose prose-sm max-w-none prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 ${bodyClass}`}
        />
      ) : null}
    </div>
  )
})

const AssistantTextCard = memo(function AssistantTextCard({ text, message }: { text: string; message: Message }) {
  const [viewMode, setViewMode] = useState<ViewMode>('rendered')
  const [copied, setCopied] = useState(false)
  const copyResetTimeoutRef = useRef<number | null>(null)
  const jsonText = useMemo(() => viewMode === 'json' ? JSON.stringify(message, null, 2) : '', [message, viewMode])

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
    }
  }, [])

  const handleCopy = useCallback(async (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      await copyTextToClipboard(text)
      setCopied(true)
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopied(false)
        copyResetTimeoutRef.current = null
      }, 1500)
    } catch (error) {
      console.error('Failed to copy raw text:', error)
    }
  }, [text])

  const paddingClass = viewMode === 'rendered' ? 'px-2' : 'px-2 py-2'

  return (
    <div className={`bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 ${paddingClass} rounded-lg cursor-text relative group`}>
      <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <IconToggleButton onClick={() => setViewMode('rendered')} active={viewMode === 'rendered'} title="Rendered (Markdown)">
          <Eye size={12} />
        </IconToggleButton>
        <IconToggleButton onClick={() => setViewMode('raw')} active={viewMode === 'raw'} title="Raw Text">
          <Code size={12} />
        </IconToggleButton>
        <IconToggleButton onClick={() => setViewMode('json')} active={viewMode === 'json'} title="JSON">
          <FileJson size={14} />
        </IconToggleButton>
        <IconToggleButton onClick={handleCopy} active={copied} title={copied ? 'Copied' : 'Copy Raw Text'}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </IconToggleButton>
      </div>

      {viewMode === 'rendered' ? (
        <MarkdownContent
          text={text}
          className="foxwarm-markdown prose prose-sm dark:prose-invert max-w-none prose-pre:bg-gray-100 dark:prose-pre:bg-gray-900 prose-pre:text-gray-900 dark:prose-pre:text-gray-100 prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0"
        />
      ) : viewMode === 'raw' ? (
        <pre className="whitespace-pre-wrap font-mono text-sm text-gray-900 dark:text-gray-100 pr-32">{text}</pre>
      ) : (
        <pre className="whitespace-pre-wrap font-mono text-sm text-gray-900 dark:text-gray-100 overflow-x-auto pr-32">{jsonText}</pre>
      )}
    </div>
  )
})

const renderInlineToolSummary = (name: string, summary: ReactNode, summaryClassName = 'text-gray-700 dark:text-gray-200') => (
  <div className="flex items-center gap-2 min-w-0">
    <ToolLabel name={name} />
    <div className={`min-w-0 flex-1 ${summaryClassName}`}>{summary}</div>
  </div>
)

const formatToolResponseText = (resp: FunctionResponse): string => {
  if (resp.response?.error !== undefined && resp.response?.error !== null) {
    return typeof resp.response.error === 'string' ? resp.response.error : JSON.stringify(resp.response.error, null, 2)
  }
  if (resp.response?.output !== undefined && resp.response?.output !== null) {
    return typeof resp.response.output === 'string' ? resp.response.output : JSON.stringify(resp.response.output, null, 2)
  }
  if (resp.response?.content !== undefined && resp.response?.content !== null) {
    return typeof resp.response.content === 'string' ? resp.response.content : JSON.stringify(resp.response.content, null, 2)
  }
  return formatObject(resp.response)
}

const getPrimaryToolResponseText = (resp: FunctionResponse): string | null => {
  if (resp.response?.error !== undefined && resp.response?.error !== null) {
    return typeof resp.response.error === 'string' ? resp.response.error : JSON.stringify(resp.response.error, null, 2)
  }
  if (resp.response?.output !== undefined && resp.response?.output !== null) {
    return typeof resp.response.output === 'string' ? resp.response.output : JSON.stringify(resp.response.output, null, 2)
  }
  if (resp.response?.content !== undefined && resp.response?.content !== null) {
    return typeof resp.response.content === 'string' ? resp.response.content : JSON.stringify(resp.response.content, null, 2)
  }
  return null
}

const getToolResponseStatus = (resp: FunctionResponse): 'success' | 'error' => {
  if (resp.response?.error !== undefined && resp.response?.error !== null) {
    return 'error'
  }
  if (resp.name === 'edit') {
    return resp.response?.output === 'File edited successfully' ? 'success' : 'error'
  }
  return 'success'
}

const getToolPairStatus = (responses: FunctionResponse[], imageParts: MessagePart[] = []): 'success' | 'error' | 'neutral' => {
  if (responses.some((resp) => getToolResponseStatus(resp) === 'error')) {
    return 'error'
  }
  if (responses.length > 0 || imageParts.length > 0) {
    return 'success'
  }
  return 'neutral'
}

const truncatePreviewText = (text: string, maxLength = 400): string => {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}...`
}

const isLegacyDiffToolName = (name: string): boolean => name === 'edit' || name === 'edit_memory'

const hasLegacyDiffPayload = (call: FunctionCall): boolean => (
  typeof call.args.oldText === 'string' && typeof call.args.newText === 'string'
)

const renderToolCallPreview = (call: FunctionCall): ReactNode => {
  if (call.name === 'read') {
    const extra = (call.args.startLine || call.args.endLine)
      ? ` (lines ${call.args.startLine || 1}-${call.args.endLine || 'end'})`
      : ''
    return <span title={`${call.args.filePath}${extra}`}>{call.args.filePath}{extra}</span>
  }

  if (call.name === 'write') {
    return <span title={call.args.filePath}>{call.args.filePath}</span>
  }

  if (isLegacyDiffToolName(call.name)) {
    const hasLegacyDiff = hasLegacyDiffPayload(call)
    const oldLines = hasLegacyDiff ? call.args.oldText.split('\n').length - (call.args.oldText.endsWith('\n') ? 1 : 0) : 0
    const newLines = hasLegacyDiff ? call.args.newText.split('\n').length - (call.args.newText.endsWith('\n') ? 1 : 0) : 0
    return (
      <span className="flex items-center gap-2 min-w-0">
        {hasLegacyDiff ? (
          <span className="shrink-0 text-xs"><span className="text-orange-600 dark:text-orange-400">-{oldLines}</span><span className="mx-1 text-gray-500">/</span><span className="text-blue-600 dark:text-blue-400">+{newLines}</span></span>
        ) : (
          <span className="shrink-0 text-xs text-gray-500">legacy payload unavailable</span>
        )}
        <span className="truncate">{call.args.filePath}</span>
      </span>
    )
  }

  if (call.name === 'apply_patch') {
    try {
      const operations = parseApplyPatchPreview(call.args.input)
      const totalHunks = operations.reduce((sum, operation) => sum + (operation.action === 'update' ? operation.hunks.length : 0), 0)
      const fileSummary = operations.length === 1 ? operations[0].filePath : `${operations[0].filePath} +${operations.length - 1} more`
      return (
        <span className="flex items-center gap-2 min-w-0">
          <span className="shrink-0 text-xs text-gray-500">{operations.length} op{operations.length > 1 ? 's' : ''}{totalHunks > 0 ? ` • ${totalHunks} hunk${totalHunks > 1 ? 's' : ''}` : ''}</span>
          <span className="truncate">{fileSummary}</span>
        </span>
      )
    } catch {
      return <span className="text-red-500">invalid patch</span>
    }
  }

  if (call.name === 'exec') {
    const preview = call.args.command.length > 200 ? `${call.args.command.substring(0, 200)}...` : call.args.command
    return <span className="truncate font-mono" title={call.args.command}>{preview}</span>
  }

  if (call.name === 'send_to_session') {
    const targetSessionId = String(call.args.sessionId || '')
    const message = typeof call.args.message === 'string' ? call.args.message : formatObject(call.args.message)
    const preview = message.length > 160 ? `${message.slice(0, 160)}...` : message
    return (
      <span className="flex items-center gap-1 min-w-0" title={`${targetSessionId}: ${message}`}>
        <span className="shrink-0 text-gray-500 dark:text-gray-400">To</span>
        <span className="shrink-0"><SessionHashLink sessionId={targetSessionId} /></span>
        <span className="truncate">: {preview}</span>
      </span>
    )
  }

  const argsFormatted = formatObject(call.args)
  const preview = argsFormatted.length > 200 ? `${argsFormatted.substring(0, 200)}...` : argsFormatted
  return <span className="truncate break-all">{preview}</span>
}

const renderToolCallExpandedContent = (call: FunctionCall, diffViewMode: 'unified' | 'split') => {
  if (call.name === 'read') {
    const extra = (call.args.startLine || call.args.endLine)
      ? ` (lines ${call.args.startLine || 1}-${call.args.endLine || 'end'})`
      : ''
    return <div className="whitespace-pre-wrap break-all"><span>{call.args.filePath}</span>{extra && <span className="ml-2 text-gray-500 dark:text-gray-400">{extra}</span>}</div>
  }

  if (call.name === 'write') {
    return (
      <div className="space-y-2">
        <div className="whitespace-pre-wrap break-all">{call.args.filePath}</div>
        {call.args.content && (
          <pre className="whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">{call.args.content}</pre>
        )}
      </div>
    )
  }

  if (isLegacyDiffToolName(call.name)) {
    const hasLegacyDiff = hasLegacyDiffPayload(call)
    return hasLegacyDiff ? (
      <div className="space-y-2">
        <div className="text-xs text-gray-600 dark:text-gray-300">{call.args.filePath}</div>
        <DiffPreview oldText={call.args.oldText} newText={call.args.newText} diffViewMode={diffViewMode} />
      </div>
    ) : (
      <pre className="whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">{JSON.stringify(call.args, null, 2)}</pre>
    )
  }

  if (call.name === 'apply_patch') {
    try {
      const operations = parseApplyPatchPreview(call.args.input)
      return (
        <div className="space-y-4">
          {operations.map((operation, operationIdx) => {
            if (operation.action === 'update') {
              return (
                <div key={operationIdx} className="space-y-3">
                  <div className="text-xs font-semibold text-gray-600 dark:text-gray-300">Update {operation.filePath}</div>
                  {operation.hunks.map((hunk, hunkIdx) => {
                    const snippets = buildPatchHunkSnippets(hunk)
                    return (
                      <div key={hunkIdx} className="space-y-1">
                        {hunk.anchors.length > 0 && (
                          <div className="text-[11px] text-gray-500 dark:text-gray-400">{hunk.anchors.map((anchor, anchorIdx) => <div key={anchorIdx}>@@ {anchor}</div>)}</div>
                        )}
                        <DiffPreview oldText={snippets.oldText} newText={snippets.newText} diffViewMode={diffViewMode} />
                      </div>
                    )
                  })}
                </div>
              )
            }
            if (operation.action === 'add') {
              return (
                <div key={operationIdx} className="space-y-1">
                  <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Add {operation.filePath}</div>
                  <DiffPreview oldText="" newText={operation.lines.join('\n')} diffViewMode={diffViewMode} />
                </div>
              )
            }
            return <div key={operationIdx} className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">Delete {operation.filePath}</div>
          })}
        </div>
      )
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      return <pre className="whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">{error}\n\n{call.args.input || JSON.stringify(call.args, null, 2)}</pre>
    }
  }

  if (call.name === 'exec') {
    return <div className="break-all">{call.args.command}</div>
  }

  if (call.name === 'send_to_session') {
    const targetSessionId = String(call.args.sessionId || '')
    const message = typeof call.args.message === 'string' ? call.args.message : formatObject(call.args.message)
    return (
      <div className="space-y-1">
        <div className="whitespace-pre-wrap break-all"><span className="mr-1 text-gray-500 dark:text-gray-400">To</span><SessionHashLink sessionId={targetSessionId} /><span>:</span></div>
        <div className="whitespace-pre-wrap break-all">{message}</div>
      </div>
    )
  }

  return <div className="whitespace-pre-wrap break-all">{formatObject(call.args)}</div>
}

const renderToolResponseContent = (resp: FunctionResponse, expanded: boolean): ReactNode | null => {
  if (resp.name === 'read') {
    const fileContent = resp.response.content || resp.response.output || JSON.stringify(resp.response)
    return expanded
      ? <pre className="whitespace-pre-wrap text-xs overflow-x-auto cursor-text">{fileContent}</pre>
      : <div className="whitespace-pre-wrap break-all cursor-text">{truncatePreviewText(fileContent, 400) || 'Completed'}</div>
  }

  if (resp.name === 'edit' && getToolResponseStatus(resp) !== 'success') {
    const raw = formatToolResponseText(resp)
    const preview = raw.length > 400 ? `${raw.substring(0, 400)}...` : raw
    return <pre className="whitespace-pre-wrap break-all cursor-text text-red-700 dark:text-red-300">{expanded ? raw : preview}</pre>
  }

  if (resp.name === 'exec') {
    const output = resp.response.output || ''
    const preview = truncatePreviewText(output, 400)
    const displayStr = expanded ? output : preview
    return <div className="whitespace-pre-wrap break-all cursor-text">{parseAnsi(displayStr)}</div>
  }

  const primaryText = getPrimaryToolResponseText(resp)
  if (primaryText !== null) {
    const preview = truncatePreviewText(primaryText, 400)
    return <div className="whitespace-pre-wrap break-all cursor-text">{expanded ? primaryText : preview}</div>
  }

  if (getToolResponseStatus(resp) === 'success') {
    return expanded ? <div className="text-gray-500 dark:text-gray-400">Completed</div> : <div>Completed</div>
  }

  const respFormatted = formatToolResponseText(resp)
  const preview = truncatePreviewText(respFormatted, 400)
  return <div className="whitespace-pre-wrap break-all cursor-text">{expanded ? respFormatted : preview}</div>
}

const DiffPreview = memo(function DiffPreview({ oldText, newText, diffViewMode }: { oldText: string; newText: string; diffViewMode: 'unified' | 'split' }) {
  const lineChanges = useMemo(() => Diff.diffLines(oldText, newText), [oldText, newText])
  const diffOldScrollRefs = useRef<HTMLDivElement | null>(null)
  const diffNewScrollRefs = useRef<HTMLDivElement | null>(null)
  const diffLastScrollSide = useRef<'old' | 'new' | null>(null)

  const handleOldScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    if (diffLastScrollSide.current === 'new') return
    diffLastScrollSide.current = 'old'
    const oldDiv = e.currentTarget
    const newDiv = diffNewScrollRefs.current
    if (newDiv) {
      newDiv.scrollLeft = oldDiv.scrollLeft
      newDiv.scrollTop = oldDiv.scrollTop
    }
    setTimeout(() => {
      diffLastScrollSide.current = null
    }, 50)
  }, [])

  const handleNewScroll = useCallback((e: UIEvent<HTMLDivElement>) => {
    if (diffLastScrollSide.current === 'old') return
    diffLastScrollSide.current = 'new'
    const newDiv = e.currentTarget
    const oldDiv = diffOldScrollRefs.current
    if (oldDiv) {
      oldDiv.scrollLeft = newDiv.scrollLeft
      oldDiv.scrollTop = newDiv.scrollTop
    }
    setTimeout(() => {
      diffLastScrollSide.current = null
    }, 50)
  }, [])

  if (diffViewMode === 'unified') {
    const elements: ReactNode[] = []
    let i = 0

    while (i < lineChanges.length) {
      const change = lineChanges[i]

      if (change.removed && i + 1 < lineChanges.length && lineChanges[i + 1].added) {
        const charDiff = Diff.diffWords(change.value, lineChanges[i + 1].value)
        elements.push(
          <div key={i} className="bg-orange-100 dark:bg-orange-900/40 pl-2">
            {charDiff.map((part, j) => part.removed
              ? <span key={j} className="bg-orange-200/60 dark:bg-orange-700/60 text-orange-900 dark:text-orange-200">{part.value}</span>
              : !part.added ? <span key={j} className="text-gray-900 dark:text-gray-100">{part.value}</span> : null)}
          </div>
        )
        elements.push(
          <div key={i + 1} className="bg-blue-100 dark:bg-blue-900/40 pl-2">
            {charDiff.map((part, j) => part.added
              ? <span key={j} className="bg-blue-200/60 dark:bg-blue-700/60 text-blue-900 dark:text-blue-200">{part.value}</span>
              : !part.removed ? <span key={j} className="text-gray-900 dark:text-gray-100">{part.value}</span> : null)}
          </div>
        )
        i += 2
      } else if (change.removed) {
        elements.push(<div key={i} className="bg-orange-100 dark:bg-orange-900/40 pl-2"><span className="text-gray-900 dark:text-gray-100">{change.value}</span></div>)
        i++
      } else if (change.added) {
        elements.push(<div key={i} className="bg-blue-100 dark:bg-blue-900/40 pl-2"><span className="text-gray-900 dark:text-gray-100">{change.value}</span></div>)
        i++
      } else {
        elements.push(<div key={i} className="pl-2"><span className="text-gray-900 dark:text-gray-100">{change.value}</span></div>)
        i++
      }
    }

    return <div className="font-mono text-xs bg-gray-50 dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 whitespace-pre-wrap break-all cursor-text">{elements}</div>
  }

  const oldElements: ReactNode[] = []
  const newElements: ReactNode[] = []
  let i = 0

  while (i < lineChanges.length) {
    const change = lineChanges[i]

    if (change.removed && i + 1 < lineChanges.length && lineChanges[i + 1].added) {
      const removedLinesSplit = change.value.split('\n')
      const addedLinesSplit = lineChanges[i + 1].value.split('\n')
      const removedLines = change.value.endsWith('\n') ? removedLinesSplit.slice(0, -1) : removedLinesSplit
      const addedLines = lineChanges[i + 1].value.endsWith('\n') ? addedLinesSplit.slice(0, -1) : addedLinesSplit
      const maxLines = Math.max(removedLines.length, addedLines.length)

      for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
        const removedLine = removedLines[lineIdx]
        const addedLine = addedLines[lineIdx]

        if (removedLine !== undefined && addedLine !== undefined) {
          const charDiff = Diff.diffWords(removedLine, addedLine)
          oldElements.push(
            <div key={`${i}-old-${lineIdx}`} className="bg-orange-100 dark:bg-orange-900/40 block">
              {charDiff.map((part, j) => part.removed
                ? <span key={j} className="bg-orange-200/60 dark:bg-orange-700/60 text-orange-900 dark:text-orange-200">{part.value}</span>
                : !part.added ? <span key={j} className="text-gray-900 dark:text-gray-100">{part.value}</span> : null)}
            </div>
          )
          newElements.push(
            <div key={`${i}-new-${lineIdx}`} className="bg-blue-100 dark:bg-blue-900/40 block">
              {charDiff.map((part, j) => part.added
                ? <span key={j} className="bg-blue-200/60 dark:bg-blue-700/60 text-blue-900 dark:text-blue-200">{part.value}</span>
                : !part.removed ? <span key={j} className="text-gray-900 dark:text-gray-100">{part.value}</span> : null)}
            </div>
          )
        } else if (removedLine !== undefined) {
          oldElements.push(<div key={`${i}-old-${lineIdx}`} className="bg-orange-100 dark:bg-orange-900/40 text-gray-900 dark:text-gray-100 block">{removedLine || '\u00A0'}</div>)
          newElements.push(<div key={`${i}-new-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>)
        } else if (addedLine !== undefined) {
          oldElements.push(<div key={`${i}-old-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>)
          newElements.push(<div key={`${i}-new-${lineIdx}`} className="bg-blue-100 dark:bg-blue-900/40 text-gray-900 dark:text-gray-100 block">{addedLine || '\u00A0'}</div>)
        }
      }

      i += 2
    } else if (change.removed) {
      const actualLines = change.value.endsWith('\n') ? change.value.split('\n').slice(0, -1) : change.value.split('\n')
      actualLines.forEach((line, lineIdx) => {
        oldElements.push(<div key={`${i}-${lineIdx}`} className="bg-orange-100 dark:bg-orange-900/40 text-gray-900 dark:text-gray-100 block">{line || '\u00A0'}</div>)
        newElements.push(<div key={`${i}-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>)
      })
      i++
    } else if (change.added) {
      const actualLines = change.value.endsWith('\n') ? change.value.split('\n').slice(0, -1) : change.value.split('\n')
      actualLines.forEach((line, lineIdx) => {
        oldElements.push(<div key={`${i}-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>)
        newElements.push(<div key={`${i}-${lineIdx}`} className="bg-blue-100 dark:bg-blue-900/40 text-gray-900 dark:text-gray-100 block">{line || '\u00A0'}</div>)
      })
      i++
    } else {
      oldElements.push(<div key={i} className="text-gray-900 dark:text-gray-100 block">{change.value}</div>)
      newElements.push(<div key={i} className="text-gray-900 dark:text-gray-100 block">{change.value}</div>)
      i++
    }
  }

  return (
    <div className="font-mono text-xs border border-gray-300 dark:border-gray-600 rounded overflow-hidden cursor-text">
      <div className="grid grid-cols-2">
        <div className="bg-gray-50 dark:bg-gray-900">
          <div className="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 font-semibold px-2 py-1 border-b border-gray-300 dark:border-gray-600">- Old</div>
          <div ref={diffOldScrollRefs} onScroll={handleOldScroll} className="p-2 whitespace-pre overflow-auto max-h-[80vh]">
            <div className="inline-block min-w-full">{oldElements}</div>
          </div>
        </div>
        <div className="bg-gray-50 dark:bg-gray-900 border-l border-gray-300 dark:border-gray-600">
          <div className="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-semibold px-2 py-1 border-b border-gray-300 dark:border-gray-600">+ New</div>
          <div ref={diffNewScrollRefs} onScroll={handleNewScroll} className="p-2 whitespace-pre overflow-auto max-h-[80vh]">
            <div className="inline-block min-w-full">{newElements}</div>
          </div>
        </div>
      </div>
    </div>
  )
})

const ToolCallItem = memo(function ToolCallItem({ call, callIdx, hasFollowingContent }: { call: FunctionCall; callIdx: number; hasFollowingContent: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [viewMode, setViewMode] = useState<ToolViewMode>('default')
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>(() => {
    return (localStorage.getItem('diffViewMode') as 'unified' | 'split') || 'unified'
  })

  const setDiffMode = useCallback((mode: 'unified' | 'split') => {
    setDiffViewMode(mode)
    localStorage.setItem('diffViewMode', mode)
    setViewMode('default')
  }, [])

  const roundedClass = callIdx === 0 ? 'rounded-t' : ''
  const borderClass = hasFollowingContent ? 'border-b-0' : ''

  const content = useMemo(() => {
    if (viewMode === 'json') {
      return (
        <pre className="whitespace-pre-wrap break-all cursor-text text-gray-600 dark:text-gray-300">
          {JSON.stringify(call, null, 2)}
        </pre>
      )
    }

    if (call.name === 'read') {
      const extra = (call.args.startLine || call.args.endLine)
        ? ` (lines ${call.args.startLine || 1}-${call.args.endLine || 'end'})`
        : ''
      return expanded ? (
        <div className="space-y-1">
          {renderInlineToolSummary(call.name, <div className="whitespace-pre-wrap break-all"><span>{call.args.filePath}</span>{extra && <span className="ml-2 text-gray-500 dark:text-gray-400">{extra}</span>}</div>)}
        </div>
      ) : renderInlineToolSummary(call.name, <div className="truncate" title={`${call.args.filePath}${extra}`}><span>{call.args.filePath}</span>{extra && <span className="ml-2 text-gray-500 dark:text-gray-400">{extra}</span>}</div>)
    }

    if (call.name === 'write') {
      return (
        <div className="space-y-1">
          {renderInlineToolSummary(call.name, expanded ? <div className="whitespace-pre-wrap break-all">{call.args.filePath}</div> : <div className="truncate" title={call.args.filePath}>{call.args.filePath}</div>)}
          {expanded && call.args.content && (
            <pre className="mt-2 whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">{call.args.content}</pre>
          )}
        </div>
      )
    }

    if (isLegacyDiffToolName(call.name)) {
      const hasLegacyDiff = hasLegacyDiffPayload(call)
      const oldLines = hasLegacyDiff ? call.args.oldText.split('\n').length - (call.args.oldText.endsWith('\n') ? 1 : 0) : 0
      const newLines = hasLegacyDiff ? call.args.newText.split('\n').length - (call.args.newText.endsWith('\n') ? 1 : 0) : 0
      return (
        <div>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2 flex-wrap">
              <ToolLabel name={call.name} />
              {hasLegacyDiff ? (
                <span className="text-xs"><span className="text-orange-600 dark:text-orange-400">-{oldLines}</span><span className="mx-1 text-gray-500">/</span><span className="text-blue-600 dark:text-blue-400">+{newLines}</span></span>
              ) : (
                <span className="text-xs text-gray-500">legacy payload unavailable</span>
              )}
              <span className="text-gray-600 dark:text-gray-400">{call.args.filePath}</span>
            </span>
          </div>
          {expanded && (
            <div>
              <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                {hasLegacyDiff ? <DiffPreview oldText={call.args.oldText} newText={call.args.newText} diffViewMode={diffViewMode} /> : (
                  <pre className="whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">{JSON.stringify(call.args, null, 2)}</pre>
                )}
              </div>
              <div className="mt-2 text-center">
                <button onClick={(e) => { e.stopPropagation(); setExpanded(false) }} className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">Collapse ▲</button>
              </div>
            </div>
          )}
        </div>
      )
    }

    if (call.name === 'apply_patch') {
      try {
        const operations = parseApplyPatchPreview(call.args.input)
        const totalHunks = operations.reduce((sum, operation) => sum + (operation.action === 'update' ? operation.hunks.length : 0), 0)
        const fileSummary = operations.length === 1 ? operations[0].filePath : `${operations[0].filePath} +${operations.length - 1} more`
        return (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 flex-wrap">
                <ToolLabel name={call.name} />
                <span className="ml-2 text-xs text-gray-500">{operations.length} op{operations.length > 1 ? 's' : ''}{totalHunks > 0 ? ` • ${totalHunks} hunk${totalHunks > 1 ? 's' : ''}` : ''}</span>
                <span className="ml-2 text-gray-600 dark:text-gray-400">{fileSummary}</span>
              </span>
            </div>
            {expanded && (
              <div className="mt-2 space-y-4" onClick={(e) => e.stopPropagation()}>
                {operations.map((operation, operationIdx) => {
                  if (operation.action === 'update') {
                    return (
                      <div key={operationIdx} className="space-y-3">
                        <div className="text-xs font-semibold text-gray-600 dark:text-gray-300">Update {operation.filePath}</div>
                        {operation.hunks.map((hunk, hunkIdx) => {
                          const snippets = buildPatchHunkSnippets(hunk)
                          return (
                            <div key={hunkIdx} className="space-y-1">
                              {hunk.anchors.length > 0 && (
                                <div className="text-[11px] text-gray-500 dark:text-gray-400">{hunk.anchors.map((anchor, anchorIdx) => <div key={anchorIdx}>@@ {anchor}</div>)}</div>
                              )}
                              <DiffPreview oldText={snippets.oldText} newText={snippets.newText} diffViewMode={diffViewMode} />
                            </div>
                          )
                        })}
                      </div>
                    )
                  }
                  if (operation.action === 'add') {
                    return (
                      <div key={operationIdx} className="space-y-1">
                        <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Add {operation.filePath}</div>
                        <DiffPreview oldText="" newText={operation.lines.join('\n')} diffViewMode={diffViewMode} />
                      </div>
                    )
                  }
                  return <div key={operationIdx} className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">Delete {operation.filePath}</div>
                })}
                <div className="mt-2 text-center">
                  <button onClick={(e) => { e.stopPropagation(); setExpanded(false) }} className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">Collapse ▲</button>
                </div>
              </div>
            )}
          </div>
        )
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        return (
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <ToolLabel name={call.name} />
              <span className="text-xs text-red-500">invalid patch</span>
            </div>
            {expanded && (
              <pre className="mt-2 whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">{error}\n\n{call.args.input || JSON.stringify(call.args, null, 2)}</pre>
            )}
          </div>
        )
      }
    }

    if (call.name === 'exec') {
      const preview = call.args.command.length > 200 ? `${call.args.command.substring(0, 200)}...` : call.args.command
      return (
        <div className="space-y-1">
          {expanded ? (
            <>
              <ToolLabel name={call.name} />
              <div className="break-all">{call.args.command}</div>
            </>
          ) : renderInlineToolSummary(call.name, <div className="truncate font-mono" title={call.args.command}>{preview}</div>)}
        </div>
      )
    }

    if (call.name === 'send_to_session') {
      const targetSessionId = String(call.args.sessionId || '')
      const message = typeof call.args.message === 'string' ? call.args.message : formatObject(call.args.message)
      const preview = message.length > 200 ? `${message.slice(0, 200)}...` : message
      return (
        <div className="space-y-1">
          {expanded ? (
            <>
              {renderInlineToolSummary(call.name, <div className="whitespace-pre-wrap break-all"><SessionHashLink sessionId={targetSessionId} /></div>)}
              <div className="whitespace-pre-wrap break-all">{message}</div>
            </>
          ) : renderInlineToolSummary(call.name, <div className="truncate" title={`${targetSessionId}: ${message}`}><SessionHashLink sessionId={targetSessionId} /><span>: {preview}</span></div>)}
        </div>
      )
    }

    const argsFormatted = formatObject(call.args)
    const preview = argsFormatted.length > 200 ? `${argsFormatted.substring(0, 200)}...` : argsFormatted
    return (
      <div className="space-y-1">
        {expanded ? (
          <>
            <ToolLabel name={call.name} />
            <div className="whitespace-pre-wrap break-all">{argsFormatted}</div>
          </>
        ) : renderInlineToolSummary(call.name, <div className="truncate break-all">{preview}</div>)}
      </div>
    )
  }, [call, callIdx, diffViewMode, expanded, viewMode])

  return (
    <div className={`text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 ${roundedClass} p-2 ${borderClass} relative group`}>
      <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        {isLegacyDiffToolName(call.name) || call.name === 'apply_patch' ? (
          <>
            <MiniToggleButton onClick={(e) => { e.stopPropagation(); setDiffMode('unified') }} active={viewMode !== 'json' && diffViewMode === 'unified'} title="Unified">Unified</MiniToggleButton>
            <MiniToggleButton onClick={(e) => { e.stopPropagation(); setDiffMode('split') }} active={viewMode !== 'json' && diffViewMode === 'split'} title="Split">Split</MiniToggleButton>
            <MiniToggleButton onClick={(e) => { e.stopPropagation(); setViewMode('json') }} active={viewMode === 'json'} title="JSON">JSON</MiniToggleButton>
          </>
        ) : (
          <>
            <IconToggleButton onClick={(e) => { e.stopPropagation(); setViewMode('default') }} active={viewMode === 'default'} title="Default"><Eye size={12} /></IconToggleButton>
            <IconToggleButton onClick={(e) => { e.stopPropagation(); setViewMode('json') }} active={viewMode === 'json'} title="JSON"><FileJson size={14} /></IconToggleButton>
          </>
        )}
      </div>
      <div className="font-mono text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200" onClick={() => setExpanded(current => !current)}>
        <div style={expanded ? undefined : clampContentStyle(1, 0.25)}>{content}</div>
      </div>
    </div>
  )
})

const ToolResponseItem = memo(function ToolResponseItem({ resp, hasPrecedingCall, isLast }: { resp: FunctionResponse; hasPrecedingCall: boolean; isLast: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [viewMode, setViewMode] = useState<ToolViewMode>('default')
  const responseStatus = getToolResponseStatus(resp)
  const isError = responseStatus === 'error'

  const content = useMemo(() => {
    if (viewMode === 'json') {
      return <pre className="whitespace-pre-wrap break-all cursor-text text-green-700 dark:text-green-300">{JSON.stringify(resp, null, 2)}</pre>
    }

    if (resp.name === 'read') {
      const fileContent = resp.response.content || resp.response.output || JSON.stringify(resp.response)
      return expanded ? <pre className="whitespace-pre-wrap text-xs overflow-x-auto cursor-text">{fileContent}</pre> : null
    }

    if (resp.name === 'edit' && getToolResponseStatus(resp) !== 'success') {
      const raw = formatToolResponseText(resp)
      const preview = raw.length > 400 ? `${raw.substring(0, 400)}...` : raw
      return <pre className="whitespace-pre-wrap break-all cursor-text text-red-700 dark:text-red-300">{expanded ? raw : preview}</pre>
    }

    if (resp.name === 'exec') {
      const output = resp.response.output || ''
      const preview = output.length > 400 ? `${output.substring(0, 400)}...` : output
      const displayStr = expanded ? output : preview
      return <div className="whitespace-pre-wrap break-all cursor-text">{parseAnsi(displayStr)}</div>
    }

    const primaryText = getPrimaryToolResponseText(resp)
    if (primaryText !== null) {
      const preview = primaryText.length > 400 ? `${primaryText.substring(0, 400)}...` : primaryText
      return <div className="whitespace-pre-wrap break-all cursor-text">{expanded ? primaryText : preview}</div>
    }

    if (getToolResponseStatus(resp) === 'success') {
      return null
    }

    const respFormatted = formatToolResponseText(resp)
    const preview = respFormatted.length > 400 ? `${respFormatted.substring(0, 400)}...` : respFormatted
    return <div className="whitespace-pre-wrap break-all cursor-text">{expanded ? respFormatted : preview}</div>
  }, [expanded, resp, viewMode])

  const roundedClass = hasPrecedingCall ? '' : 'rounded-t'
  const roundedBottomClass = isLast ? 'rounded-b' : ''
  const borderClass = isLast ? '' : 'border-b-0'

  return (
    <div className={`text-xs ${isError ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'} border ${roundedClass} ${roundedBottomClass} p-2 ${borderClass} relative group`}>
      <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <IconToggleButton onClick={(e) => { e.stopPropagation(); setViewMode('default') }} active={viewMode === 'default'} title="Default"><Eye size={12} /></IconToggleButton>
        <IconToggleButton onClick={(e) => { e.stopPropagation(); setViewMode('json') }} active={viewMode === 'json'} title="JSON"><FileJson size={14} /></IconToggleButton>
      </div>
      <div className={`font-mono cursor-pointer ${isError ? 'text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300' : 'text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300'}`} onClick={() => setExpanded(current => !current)}>
        <span className="inline-flex items-center gap-1.5">{isError ? <X size={12} /> : <Check size={12} />}<span>{resp.name}</span></span>
      </div>
      {content && <div className={`font-mono mt-1 ${isError ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`} style={expanded ? undefined : clampContentStyle(3)}>{content}</div>}
    </div>
  )
})

const ToolCallResponseItem = memo(function ToolCallResponseItem({
  call,
  responses,
  imageParts,
}: {
  call: FunctionCall
  responses: FunctionResponse[]
  imageParts: MessagePart[]
}) {
  const [expanded, setExpanded] = useState(false)
  const [viewMode, setViewMode] = useState<ToolViewMode>('default')
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>(() => {
    return (localStorage.getItem('diffViewMode') as 'unified' | 'split') || 'unified'
  })

  const setDiffMode = useCallback((mode: 'unified' | 'split') => {
    setDiffViewMode(mode)
    localStorage.setItem('diffViewMode', mode)
  }, [])

  const pairStatus = getToolPairStatus(responses, imageParts)
  const isError = pairStatus === 'error'
  const outerToneClass = pairStatus === 'error'
    ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
    : pairStatus === 'success'
      ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
      : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700'
  const tagTone = pairStatus === 'error' ? 'error' : pairStatus === 'success' ? 'success' : 'neutral'

  const responsePreview = useMemo(() => {
    const firstResponse = responses[0]
    if (firstResponse) {
      const previewNode = renderToolResponseContent(firstResponse, false)
      if (responses.length > 1) {
        return (
          <div className="flex items-center gap-2 min-w-0">
            <div className="min-w-0 flex-1">{previewNode}</div>
            <span className="shrink-0 text-[11px] opacity-70">+{responses.length - 1} more</span>
          </div>
        )
      }
      return previewNode
    }
    if (imageParts.length > 0) {
      return <div>{imageParts.length} image{imageParts.length > 1 ? 's' : ''}</div>
    }
    return <div>Waiting for result…</div>
  }, [imageParts.length, responses])

  const jsonText = useMemo(() => JSON.stringify({ call, responses, imageParts }, null, 2), [call, imageParts, responses])
  const baseTextClass = 'font-mono text-gray-700 dark:text-gray-300'

  return (
    <div className={`text-xs border rounded p-2 relative group cursor-pointer ${outerToneClass}`} onClick={() => setExpanded((current) => !current)}>
      <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <IconToggleButton onClick={(e) => { e.stopPropagation(); setViewMode('default') }} active={viewMode === 'default'} title="Default"><Eye size={12} /></IconToggleButton>
        <IconToggleButton onClick={(e) => { e.stopPropagation(); setViewMode('json') }} active={viewMode === 'json'} title="JSON"><FileJson size={14} /></IconToggleButton>
      </div>

      {viewMode === 'json' ? (
        <div className={`${baseTextClass} ${expanded ? '' : 'pr-10'}`}>
          <div className="flex items-center gap-2 min-w-0">
            <ToolTag name={call.name} tone={tagTone} />
          </div>
          <pre className="mt-2 whitespace-pre-wrap break-all cursor-text" onClick={(e) => e.stopPropagation()} style={expanded ? undefined : clampContentStyle(6)}>{jsonText}</pre>
        </div>
      ) : !expanded ? (
        <div className={`${baseTextClass} pr-10`}>
            <div className="space-y-1">
            <div className="flex items-center gap-2 min-w-0">
              <ToolTag name={call.name} tone={tagTone} />
              <div className="min-w-0 flex-1 truncate">{renderToolCallPreview(call)}</div>
            </div>
            <div className="text-gray-700 dark:text-gray-300" style={clampContentStyle(3)}>{responsePreview}</div>
          </div>
        </div>
      ) : (
        <div className={baseTextClass}>
          <div>
            <div className="flex items-center gap-2 min-w-0">
              <ToolTag name={call.name} tone={tagTone} />
            </div>

            <div className="mt-2 cursor-default" onClick={(e) => e.stopPropagation()}>
              <div className={`bg-white/40 dark:bg-gray-900/30 py-1 text-gray-700 dark:text-gray-300 ${(isLegacyDiffToolName(call.name) || call.name === 'apply_patch') ? 'relative pr-24' : ''}`}>
                {(isLegacyDiffToolName(call.name) || call.name === 'apply_patch') && (
                  <div className="absolute top-1 right-0 flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <MiniToggleButton onClick={(e) => { e.stopPropagation(); setDiffMode('unified') }} active={diffViewMode === 'unified'} title="Unified">Unified</MiniToggleButton>
                    <MiniToggleButton onClick={(e) => { e.stopPropagation(); setDiffMode('split') }} active={diffViewMode === 'split'} title="Split">Split</MiniToggleButton>
                  </div>
                )}
                {renderToolCallExpandedContent(call, diffViewMode)}
              </div>

              <div className={`my-2 border-t ${isError ? 'border-red-200 dark:border-red-800' : 'border-green-200 dark:border-green-800'} opacity-70`} />

              <div className="bg-white/40 dark:bg-gray-900/30 py-1 text-gray-700 dark:text-gray-300">
                <div>
                  {responses.length > 0 ? responses.map((resp, idx) => (
                    <div key={`${resp.tool_use_id || call.id || call.name}-${idx}`} className={idx > 0 ? `pt-2 border-t ${isError ? 'border-red-100 dark:border-red-900/40' : 'border-green-100 dark:border-green-900/40'}` : ''}>
                      {renderToolResponseContent(resp, true)}
                    </div>
                  )) : <div className="text-gray-500 dark:text-gray-400">Waiting for result…</div>}

                  {imageParts.length > 0 && (
                    <div className={responses.length > 0 ? `pt-2 border-t ${isError ? 'border-red-100 dark:border-red-900/40' : 'border-green-100 dark:border-green-900/40'}` : ''}>
                      <ImageParts imageParts={imageParts} keyPrefix={`tool-pair-${call.id || call.name}`} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
})

const InterleavedToolGroup = memo(function InterleavedToolGroup({ msg, nextMsg, messageKeyPrefix }: { msg: Message; nextMsg: Message; messageKeyPrefix: string }) {
  const { functionCalls, functionResponses, imageEntriesById, unmatchedResponses, unmatchedImageParts } = useMemo(() => {
    const functionCalls = msg.parts.filter(p => p.functionCall).map(p => p.functionCall!)
    const functionResponses = nextMsg.parts.filter(p => p.functionResponse).map(p => p.functionResponse!)

    const responseEntriesById = new Map<string, Array<{ resp: FunctionResponse; respIdx: number }>>()
    const unmatchedResponses: Array<{ resp: FunctionResponse; respIdx: number }> = []
    functionResponses.forEach((resp, respIdx) => {
      const toolId = resp.tool_use_id
      if (!toolId) {
        unmatchedResponses.push({ resp, respIdx })
        return
      }
      const entries = responseEntriesById.get(toolId) || []
      entries.push({ resp, respIdx })
      responseEntriesById.set(toolId, entries)
    })

    const imageEntriesById = new Map<string, MessagePart[]>()
    const unmatchedImageParts: MessagePart[] = []
    nextMsg.parts.filter(p => p.inlineData).forEach(part => {
      if (part.toolUseId) {
        const entries = imageEntriesById.get(part.toolUseId) || []
        entries.push(part)
        imageEntriesById.set(part.toolUseId, entries)
      } else {
        unmatchedImageParts.push(part)
      }
    })

    return { functionCalls, functionResponses: responseEntriesById, imageEntriesById, unmatchedResponses, unmatchedImageParts }
  }, [msg.parts, nextMsg.parts])

  const renderedResponseIndexes = new Set<number>()

  return (
    <div>
      {functionCalls.map((call, callIdx) => {
        const toolId = call.id
        const responseEntries = toolId ? (functionResponses.get(toolId) || []) : []
        const imageParts = toolId ? (imageEntriesById.get(toolId) || []) : []
        const hasFollowingContent = responseEntries.length > 0 || imageParts.length > 0
        responseEntries.forEach(({ respIdx }) => renderedResponseIndexes.add(respIdx))

        return (
          <div key={`${messageKeyPrefix}-group-${toolId || callIdx}`}>
            {hasFollowingContent ? (
              <ToolCallResponseItem
                call={call}
                responses={responseEntries.map(({ resp }) => resp)}
                imageParts={imageParts}
              />
            ) : (
              <ToolCallItem call={call} callIdx={callIdx} hasFollowingContent={false} />
            )}
          </div>
        )
      })}
      {unmatchedResponses.filter(({ respIdx }) => !renderedResponseIndexes.has(respIdx)).map(({ resp }, orphanIdx) => (
        <ToolResponseItem
          key={`${messageKeyPrefix}-orphan-resp-${orphanIdx}`}
          resp={resp}
          hasPrecedingCall={false}
          isLast={orphanIdx === unmatchedResponses.length - 1 && unmatchedImageParts.length === 0}
        />
      ))}
      {Array.from(imageEntriesById.entries()).filter(([toolId]) => !functionCalls.some(call => call.id === toolId)).map(([toolId, imageParts], orphanIdx, orphaned) => (
        <div key={`${messageKeyPrefix}-orphan-matched-tool-image-${toolId}`} className={`border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-2 pb-2 ${orphanIdx === orphaned.length - 1 && unmatchedImageParts.length === 0 ? 'rounded-b' : ''}`}>
          <ImageParts imageParts={imageParts} keyPrefix={`${messageKeyPrefix}-orphan-matched-tool-image-${toolId}`} />
        </div>
      ))}
      {unmatchedImageParts.length > 0 && (
        <div className="rounded-b border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-2 pb-2">
          <ImageParts imageParts={unmatchedImageParts} keyPrefix={`${messageKeyPrefix}-orphan-tool-image`} />
        </div>
      )}
    </div>
  )
})

const ToolCallsBlock = memo(function ToolCallsBlock({ msg }: { msg: Message }) {
  const functionCalls = useMemo(() => msg.parts.filter(p => p.functionCall).map(p => p.functionCall!), [msg.parts])
  if (functionCalls.length === 0) return null

  return (
    <div>
      {functionCalls.map((call, callIdx) => (
        <ToolCallItem key={`call-${call.id || callIdx}`} call={call} callIdx={callIdx} hasFollowingContent={callIdx < functionCalls.length - 1} />
      ))}
    </div>
  )
})

const ToolResponsesBlock = memo(function ToolResponsesBlock({ msg, hasPrecedingCallMsg }: { msg: Message; hasPrecedingCallMsg: boolean }) {
  const functionResponses = useMemo(() => msg.parts.filter(p => p.functionResponse).map(p => p.functionResponse!), [msg.parts])
  if (functionResponses.length === 0) return null

  return (
    <div>
      {functionResponses.map((resp, respIdx) => (
        <ToolResponseItem
          key={`resp-${resp.tool_use_id || respIdx}`}
          resp={resp}
          hasPrecedingCall={respIdx === 0 && hasPrecedingCallMsg}
          isLast={respIdx === functionResponses.length - 1}
        />
      ))}
    </div>
  )
})

interface MessageRowProps {
  idx: number
  msg: Message
  prevMsg: Message | null
  nextMsg: Message | null
  isMobile: boolean
  verbose: boolean
  groupKey: string
  summaryTagItemsKey: string
  keepToolGroupExpanded: boolean
  showToolGroupSummary: boolean
  groupExpanded: boolean
  onExpandGroup: (groupKey: string) => void
}

const MessageRow = memo(function MessageRow({
  idx,
  msg,
  prevMsg,
  nextMsg,
  isMobile,
  verbose,
  groupKey,
  summaryTagItemsKey,
  keepToolGroupExpanded,
  showToolGroupSummary,
  groupExpanded,
  onExpandGroup,
}: MessageRowProps) {
  const textLikeParts = useMemo(() => msg.parts.filter(p => p.text || p.system || p.thinking), [msg.parts])
  const imageParts = useMemo(() => msg.parts.filter(p => p.inlineData), [msg.parts])
  const summaryTagItems = useMemo<ToolTagItem[]>(() => {
    if (!summaryTagItemsKey) return []
    try {
      return JSON.parse(summaryTagItemsKey) as ToolTagItem[]
    } catch {
      return []
    }
  }, [summaryTagItemsKey])
  const isInToolGroup = summaryTagItems.length > 0
  const hasVisibleTextContent = useMemo(() => msg.parts.some(p => (p.text && p.text.trim()) || (p.system && String(p.system).trim())), [msg.parts])
  const systemLikeMessage = useMemo(() => {
    if (msg.role === 'model') return false
    return (
      msg.parts.some(part => !!part.system && !isLightweightStructuredSystem(part.system)) ||
      msg.parts.some(part => !!part.text && part.text.split('\n').some(isHeavySystemTextLine))
    )
  }, [msg])
  const shouldSkipMargin = !systemLikeMessage && (msg.role === 'model' || msg.role === 'tool') && (prevMsg?.role === 'model' || prevMsg?.role === 'tool')
  const isCollapsedToolGroup = !verbose && isInToolGroup && !groupExpanded && !keepToolGroupExpanded
  const hasInterleavedToolGroup = !!(nextMsg && nextMsg.role === 'tool' && nextMsg.parts.some(p => p.functionResponse) && msg.parts.some(p => p.functionCall))
  const hasPrecedingCallMsg = !!(prevMsg?.role === 'model' && prevMsg.parts.some(p => p.functionCall))

  return (
    <div className={`flex ${systemLikeMessage ? 'justify-start' : (msg.role === 'user' ? 'justify-end' : 'justify-start')} ${shouldSkipMargin ? '' : 'mt-4'}`}>
      <div
        className={`${
          systemLikeMessage
            ? 'w-full max-w-[80%]'
            : msg.role === 'user'
              ? 'max-w-[80%]'
              : isMobile
                ? 'w-full'
                : 'w-full max-w-[80%]'
        } ${
          !systemLikeMessage && msg.role === 'user'
            ? 'bg-blue-500 dark:bg-blue-600 text-white px-4 py-2 rounded-lg'
            : ''
        } overflow-x-hidden`}
      >
        {systemLikeMessage ? (
          <SystemLikeMessageCard msg={msg} messageKey={`msg-${idx}`} />
        ) : msg.role === 'user' ? (
          <div className="flex flex-col">
            {textLikeParts.map((part, partIdx) => (
              <div key={`user-part-${partIdx}`}>
                {part.system
                  ? <InlineMetaPart systemText={formatStructuredSystemText(part.system)} isUser={true} />
                  : <CollapsibleUserText text={part.text || ''} />}
              </div>
            ))}
            <ImageParts imageParts={imageParts} keyPrefix={`user-${idx}`} />
          </div>
        ) : (
          <div className="flex flex-col">
            {textLikeParts.map((part, partIdx) => {
              if (part.system) {
                return <InlineMetaPart key={`model-system-${partIdx}`} systemText={formatStructuredSystemText(part.system)} isUser={false} />
              }
              if (part.thinking) {
                if (!verbose && !hasVisibleTextContent && isInToolGroup && !groupExpanded) {
                  return null
                }
                return <ReasoningSummaryCard key={`thinking-${partIdx}`} thinking={part.thinking} tone="message" />
              }
              return <AssistantTextCard key={`assistant-text-${partIdx}`} text={part.text || ''} message={msg} />
            })}
            <ImageParts imageParts={imageParts} keyPrefix={`message-${idx}`} />
            {!verbose && showToolGroupSummary && !groupExpanded && !keepToolGroupExpanded && (
              <div
                className="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
                onClick={() => onExpandGroup(groupKey)}
              >
                <div className="flex items-start gap-2">
                  <ToolTagList items={summaryTagItems} />
                </div>
              </div>
            )}
            {isCollapsedToolGroup ? null : (hasInterleavedToolGroup && nextMsg ? <InterleavedToolGroup msg={msg} nextMsg={nextMsg} messageKeyPrefix={`msg-${idx}`} /> : <ToolCallsBlock msg={msg} />)}
            {isCollapsedToolGroup ? null : (hasInterleavedToolGroup ? null : <ToolResponsesBlock msg={msg} hasPrecedingCallMsg={hasPrecedingCallMsg} />)}
          </div>
        )}
      </div>
    </div>
  )
}, (prev, next) => (
  prev.msg === next.msg &&
  prev.prevMsg === next.prevMsg &&
  prev.nextMsg === next.nextMsg &&
  prev.isMobile === next.isMobile &&
  prev.verbose === next.verbose &&
  prev.groupKey === next.groupKey &&
  prev.summaryTagItemsKey === next.summaryTagItemsKey &&
  prev.keepToolGroupExpanded === next.keepToolGroupExpanded &&
  prev.showToolGroupSummary === next.showToolGroupSummary &&
  prev.groupExpanded === next.groupExpanded
))

const ChatTimeline = memo(function ChatTimeline({ messages, isMobile, verbose }: ChatTimelineProps) {
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(new Set())

  const toolGroupMeta = useMemo(() => {
    const hasTextContent = (msg: Message) => msg.parts.some((p) => (p.text && p.text.trim()) || (p.system && String(p.system).trim()))
    const hasToolCalls = (msg: Message) => msg.parts.some((p) => p.functionCall)
    const hasToolResponses = (msg: Message) => msg.parts.some((p) => p.functionResponse)

    const lastIdx = messages.length - 1
    const finalStandaloneStartIdx = (() => {
      if (lastIdx < 0) return -1

      const lastMsg = messages[lastIdx]
      if (!lastMsg) return -1

      if (lastMsg.role === 'tool' && hasToolResponses(lastMsg)) {
        if (lastIdx > 0) {
          const prevMsg = messages[lastIdx - 1]
          if (prevMsg?.role === 'model' && hasToolCalls(prevMsg)) {
            return lastIdx - 1
          }
        }
        return lastIdx
      }

      if (lastMsg.role === 'model' && hasToolCalls(lastMsg)) {
        return lastIdx
      }

      return -1
    })()

    const shouldStopAtIdx = (startIdx: number, idx: number) => (
      finalStandaloneStartIdx !== -1 && startIdx < finalStandaloneStartIdx && idx >= finalStandaloneStartIdx
    )

    const getToolGroupStartIdx = (idx: number) => {
      if (finalStandaloneStartIdx !== -1 && idx >= finalStandaloneStartIdx) {
        return finalStandaloneStartIdx
      }

      const currentMsg = messages[idx]
      if (currentMsg.role === 'model' && hasTextContent(currentMsg)) {
        return idx
      }

      let start = idx
      for (let i = idx - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.role !== 'model' && m.role !== 'tool') break
        if (m.role === 'model' && hasTextContent(m)) {
          return hasToolCalls(m) ? i : start
        }
        start = i
      }
      return start
    }

    const getToolGroupSummaryItems = (startIdx: number): ToolTagItem[] => {
      const items: ToolTagItem[] = []
      const toolStatusById = new Map<string, 'success' | 'error'>()

      for (let i = startIdx; i < messages.length; i++) {
        if (shouldStopAtIdx(startIdx, i)) break
        const m = messages[i]
        if (m.role !== 'model' && m.role !== 'tool') break
        if (m.role === 'model' && hasTextContent(m) && i !== startIdx) break

        m.parts.forEach((p) => {
          if (p.functionResponse?.tool_use_id) {
            const nextStatus = getToolResponseStatus(p.functionResponse)
            const prevStatus = toolStatusById.get(p.functionResponse.tool_use_id)
            toolStatusById.set(
              p.functionResponse.tool_use_id,
              prevStatus === 'error' || nextStatus === 'error' ? 'error' : 'success'
            )
          }
        })
      }

      for (let i = startIdx; i < messages.length; i++) {
        if (shouldStopAtIdx(startIdx, i)) break
        const m = messages[i]
        if (m.role !== 'model' && m.role !== 'tool') break
        if (m.role === 'model' && hasTextContent(m) && i !== startIdx) break

        m.parts.forEach((p) => {
          if (p.thinking && p.thinking.trim() && !hasTextContent(m)) {
            items.push({ name: 'reasoning', tone: 'neutral' })
          }
          if (p.functionCall) {
            const status = p.functionCall.id ? toolStatusById.get(p.functionCall.id) : undefined
            items.push({
              name: p.functionCall.name,
              tone: status === 'error' ? 'error' : status === 'success' ? 'success' : 'neutral',
            })
          }
        })
      }
      return items
    }

    const startIdxByIndex = messages.map((_, idx) => getToolGroupStartIdx(idx))
    const summaryTagItemsByStart = new Map<number, ToolTagItem[]>()
    const summaryTagItemsKeyByStart = new Map<number, string>()
    const keepExpandedByStart = new Map<number, boolean>()
    startIdxByIndex.forEach((startIdx) => {
      if (!summaryTagItemsKeyByStart.has(startIdx)) {
        const items = getToolGroupSummaryItems(startIdx)
        summaryTagItemsByStart.set(startIdx, items)
        summaryTagItemsKeyByStart.set(startIdx, JSON.stringify(items))
        keepExpandedByStart.set(startIdx, startIdx === finalStandaloneStartIdx)
      }
    })

    return {
      handledByPreviousGroup: messages.map((msg, idx) => {
        if (msg.role !== 'tool' || idx === 0) return false
        const prevMsg = messages[idx - 1]
        return prevMsg?.role === 'model' && prevMsg.parts.some(p => p.functionCall)
      }),
      groupKeyByIndex: startIdxByIndex.map((startIdx) => `${startIdx}-toolgroup`),
      summaryTagItemsKeyByIndex: startIdxByIndex.map((startIdx) => summaryTagItemsKeyByStart.get(startIdx) || ''),
      keepExpandedByIndex: startIdxByIndex.map((startIdx) => keepExpandedByStart.get(startIdx) || false),
      shouldRenderSummary: startIdxByIndex.map((startIdx, idx) => idx === startIdx && (summaryTagItemsByStart.get(startIdx)?.length || 0) > 0),
    }
  }, [messages])

  const handleExpandGroup = useCallback((groupKey: string) => {
    setExpandedToolGroups(prev => {
      const next = new Set(prev)
      next.add(groupKey)
      return next
    })
  }, [])

  return (
    <>
      {messages.map((msg, idx) => {
        if (toolGroupMeta.handledByPreviousGroup[idx]) {
          return null
        }

        const groupKey = toolGroupMeta.groupKeyByIndex[idx]
        return (
          <MessageRow
            key={msg.__meta?.timestamp ?? idx}
            idx={idx}
            msg={msg}
            prevMsg={idx > 0 ? messages[idx - 1] : null}
            nextMsg={idx < messages.length - 1 ? messages[idx + 1] : null}
            isMobile={isMobile}
            verbose={verbose}
            groupKey={groupKey}
            summaryTagItemsKey={toolGroupMeta.summaryTagItemsKeyByIndex[idx]}
            keepToolGroupExpanded={toolGroupMeta.keepExpandedByIndex[idx]}
            showToolGroupSummary={toolGroupMeta.shouldRenderSummary[idx]}
            groupExpanded={expandedToolGroups.has(groupKey)}
            onExpandGroup={handleExpandGroup}
          />
        )
      })}
    </>
  )
})

export default ChatTimeline
