import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, UIEvent } from 'react'
import { Eye, Code, FileJson, Copy, Check, X } from 'lucide-react'
import {
  Diff,
  IconToggleButton,
  MiniToggleButton,
  ToolLabel,
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

const ReasoningSummaryCard = memo(function ReasoningSummaryCard({
  thinking,
  isExpanded,
  tone,
  onToggle,
}: {
  thinking: string
  isExpanded: boolean
  tone: 'message' | 'processing'
  onToggle?: () => void
}) {
  const collapsedPreview = useMemo(() => getCollapsedReasoningPreview(thinking), [thinking])

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

  return (
    <div className={`rounded-lg border px-3 py-2 ${containerClass}`}>
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className={`min-w-0 flex-1 text-[11px] font-medium uppercase tracking-wide ${labelClass}`}>
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0">Reasoning</span>
            {!isExpanded && (
              <span className="min-w-0 flex-1 truncate normal-case text-sm font-normal tracking-normal" title={collapsedPreview}>
                {collapsedPreview}
              </span>
            )}
          </div>
        </div>
        {!isProcessing && onToggle && (
          <button
            onClick={onToggle}
            className="shrink-0 text-xs text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200"
          >
            {isExpanded ? '▲ Show less' : '▼ Show more'}
          </button>
        )}
      </div>
      {isExpanded ? (
        <MarkdownContent
          text={thinking}
          className={`foxwarm-markdown prose prose-sm max-w-none prose-p:my-2 prose-headings:my-2 prose-ul:my-2 prose-ol:my-2 prose-li:my-0 ${bodyClass}`}
        />
      ) : null}
    </div>
  )
})

const ChatTimeline = memo(function ChatTimeline({ messages, isMobile, verbose }: ChatTimelineProps) {
  const [expandedTool, setExpandedTool] = useState<string | null>(null)
  const [expandedSystemMessages, setExpandedSystemMessages] = useState<Set<string>>(new Set())
  const [expandedReasoningSummaries, setExpandedReasoningSummaries] = useState<Set<string>>(new Set())
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>(() => {
    return (localStorage.getItem('diffViewMode') as 'unified' | 'split') || 'unified'
  })
  const [messageViewModes, setMessageViewModes] = useState<Map<number, ViewMode>>(new Map())
  const [toolViewModes, setToolViewModes] = useState<Map<string, ToolViewMode>>(new Map())
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(new Set())
  const [copiedMessageKey, setCopiedMessageKey] = useState<string | null>(null)

  const copyResetTimeoutRef = useRef<number | null>(null)
  const diffOldScrollRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const diffNewScrollRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const diffLastScrollSide = useRef<'old' | 'new' | null>(null)

  useEffect(() => {
    return () => {
      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }
    }
  }, [])

  const setMessageView = useCallback((messageIdx: number, mode: ViewMode) => {
    setMessageViewModes(prev => {
      const next = new Map(prev)
      next.set(messageIdx, mode)
      return next
    })
  }, [])

  const setToolView = useCallback((toolKey: string, mode: ToolViewMode) => {
    setToolViewModes(prev => {
      const next = new Map(prev)
      next.set(toolKey, mode)
      return next
    })

    if (mode === 'json') {
      setExpandedTool(toolKey)
    }
  }, [])

  const handleCopyRawText = useCallback(async (messageKey: string, text: string) => {
    try {
      await copyTextToClipboard(text)
      setCopiedMessageKey(messageKey)

      if (copyResetTimeoutRef.current !== null) {
        window.clearTimeout(copyResetTimeoutRef.current)
      }

      copyResetTimeoutRef.current = window.setTimeout(() => {
        setCopiedMessageKey(current => current === messageKey ? null : current)
        copyResetTimeoutRef.current = null
      }, 1500)
    } catch (error) {
      console.error('Failed to copy raw text:', error)
    }
  }, [])

  const hasTextContent = useCallback((msg: Message) => {
    return msg.parts.some((p) => (p.text && p.text.trim()) || (p.system && String(p.system).trim()))
  }, [])

  const hasToolCalls = useCallback((msg: Message) => {
    return msg.parts.some((p) => p.functionCall)
  }, [])

  const toolGroupMeta = useMemo(() => {
    const getToolGroupStartIdx = (idx: number) => {
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

    const getToolGroupSummaryTags = (startIdx: number) => {
      const names: string[] = []

      for (let i = startIdx; i < messages.length; i++) {
        const m = messages[i]

        if (m.role !== 'model' && m.role !== 'tool') break
        if (m.role === 'model' && hasTextContent(m) && i !== startIdx) break

        m.parts.forEach((p) => {
          if (p.thinking && p.thinking.trim() && !hasTextContent(m)) {
            names.push('reasoning')
          }
          if (p.functionCall) {
            names.push(p.functionCall.name)
          }
        })
      }

      return names
    }

    const startIdxByIndex = messages.map((_, idx) => getToolGroupStartIdx(idx))
    const summaryTagsByStart = new Map<number, string[]>()
    startIdxByIndex.forEach((startIdx) => {
      if (!summaryTagsByStart.has(startIdx)) {
        summaryTagsByStart.set(startIdx, getToolGroupSummaryTags(startIdx))
      }
    })

    const summaryTagsByIndex = startIdxByIndex.map((startIdx) => summaryTagsByStart.get(startIdx) || [])
    const groupKeyByIndex = startIdxByIndex.map((startIdx) => `${startIdx}-toolgroup`)
    const handledByPreviousGroup = messages.map((msg, idx) => {
      if (msg.role !== 'tool' || idx === 0) return false
      const prevMsg = messages[idx - 1]
      return prevMsg?.role === 'model' && prevMsg.parts.some(p => p.functionCall)
    })

    return {
      summaryTagsByIndex,
      groupKeyByIndex,
      handledByPreviousGroup,
      shouldRenderSummary: summaryTagsByIndex.map((tags, idx) => idx === startIdxByIndex[idx] && tags.length > 0),
    }
  }, [hasTextContent, hasToolCalls, messages])

  const toggleDiffView = useCallback(() => {
    const newMode = diffViewMode === 'unified' ? 'split' : 'unified'
    setDiffViewMode(newMode)
    localStorage.setItem('diffViewMode', newMode)
  }, [diffViewMode])

  const isSystemLikeMessage = useCallback((msg: Message) => {
    if (msg.role === 'model') {
      return false
    }

    return (
      msg.parts.some(part => !!part.system && !isLightweightStructuredSystem(part.system)) ||
      msg.parts.some(part => !!part.text && part.text.split('\n').some(isHeavySystemTextLine))
    )
  }, [])

  const renderInlineMetaPart = useCallback((systemText: string, key: string, isUser: boolean) => (
    <pre
      key={key}
      className={`whitespace-pre-wrap font-sans ${isUser ? 'text-white' : 'text-gray-500 dark:text-gray-400'}`}
      style={{ fontSize: '70%', lineHeight: '1.1em', opacity: 0.7 }}
    >
      {systemText.split('\n').map((line, lineIdx) => (
        <span key={lineIdx} style={{ display: 'block' }}>{renderSystemTextWithSessionLinks(line)}</span>
      ))}
    </pre>
  ), [])

  const renderSystemLikeMessage = useCallback((msg: Message, messageKey: string) => {
    const isExpanded = expandedSystemMessages.has(messageKey)
    const allLines = msg.parts.flatMap((part) => {
      if (part.system) {
        return formatStructuredSystemText(part.system).split('\n')
      }
      if (part.text) {
        return part.text.split('\n')
      }
      return []
    })

    const renderedText = allLines.join('\n')
    const shouldCollapse = !isExpanded

    return (
      <div className="w-full max-w-[80%] overflow-x-hidden">
        <div className="bg-slate-50 dark:bg-slate-900/30 border border-slate-200 dark:border-slate-700 rounded-lg px-4 py-3 text-slate-700 dark:text-slate-300">
          <div
            className={shouldCollapse ? 'overflow-hidden' : ''}
            style={shouldCollapse ? { maxHeight: 'calc(1.5em * 4)' } : undefined}
          >
            <pre className="whitespace-pre-wrap font-sans text-sm" style={{ lineHeight: '1.5em' }}>
              {renderedText.split('\n').map((line, lineIdx) => {
                const isPrefix = isSystemLikeText(line)
                return (
                  <span
                    key={lineIdx}
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
              onClick={() => {
                const newExpanded = new Set(expandedSystemMessages)
                if (isExpanded) {
                  newExpanded.delete(messageKey)
                } else {
                  newExpanded.add(messageKey)
                }
                setExpandedSystemMessages(newExpanded)
              }}
              className="text-xs mt-2 text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 text-left"
            >
              {isExpanded ? '▲ Show less' : '▼ Show more'}
            </button>
          )}
        </div>
        {renderImages(msg, messageKey)}
      </div>
    )
  }, [expandedSystemMessages])

  const renderDiff = useCallback((oldText: string, newText: string, diffIndex: number) => {
    const lineChanges = Diff.diffLines(oldText, newText)

    const handleOldScroll = (e: UIEvent<HTMLDivElement>) => {
      if (diffLastScrollSide.current === 'new') return
      diffLastScrollSide.current = 'old'
      const oldDiv = e.currentTarget
      const newDiv = diffNewScrollRefs.current.get(diffIndex)
      if (newDiv) {
        newDiv.scrollLeft = oldDiv.scrollLeft
        newDiv.scrollTop = oldDiv.scrollTop
      }
      setTimeout(() => {
        diffLastScrollSide.current = null
      }, 50)
    }

    const handleNewScroll = (e: UIEvent<HTMLDivElement>) => {
      if (diffLastScrollSide.current === 'old') return
      diffLastScrollSide.current = 'new'
      const newDiv = e.currentTarget
      const oldDiv = diffOldScrollRefs.current.get(diffIndex)
      if (oldDiv) {
        oldDiv.scrollLeft = newDiv.scrollLeft
        oldDiv.scrollTop = newDiv.scrollTop
      }
      setTimeout(() => {
        diffLastScrollSide.current = null
      }, 50)
    }

    if (diffViewMode === 'unified') {
      const elements: ReactNode[] = []
      let i = 0

      while (i < lineChanges.length) {
        const change = lineChanges[i]

        if (change.removed && i + 1 < lineChanges.length && lineChanges[i + 1].added) {
          const removed = change.value
          const added = lineChanges[i + 1].value
          const charDiff = Diff.diffWords(removed, added)

          elements.push(
            <div key={i} className="bg-orange-100 dark:bg-orange-900/40 pl-2">
              {charDiff.map((part, j) => {
                if (part.removed) {
                  return (
                    <span key={j} className="bg-orange-200/60 dark:bg-orange-700/60 text-orange-900 dark:text-orange-200">
                      {part.value}
                    </span>
                  )
                } else if (!part.added) {
                  return <span key={j} className="text-gray-900 dark:text-gray-100">{part.value}</span>
                }
                return null
              })}
            </div>
          )

          elements.push(
            <div key={i + 1} className="bg-blue-100 dark:bg-blue-900/40 pl-2">
              {charDiff.map((part, j) => {
                if (part.added) {
                  return (
                    <span key={j} className="bg-blue-200/60 dark:bg-blue-700/60 text-blue-900 dark:text-blue-200">
                      {part.value}
                    </span>
                  )
                } else if (!part.removed) {
                  return <span key={j} className="text-gray-900 dark:text-gray-100">{part.value}</span>
                }
                return null
              })}
            </div>
          )

          i += 2
        } else if (change.removed) {
          elements.push(
            <div key={i} className="bg-orange-100 dark:bg-orange-900/40 pl-2">
              <span className="text-gray-900 dark:text-gray-100">{change.value}</span>
            </div>
          )
          i++
        } else if (change.added) {
          elements.push(
            <div key={i} className="bg-blue-100 dark:bg-blue-900/40 pl-2">
              <span className="text-gray-900 dark:text-gray-100">{change.value}</span>
            </div>
          )
          i++
        } else {
          elements.push(
            <div key={i} className="pl-2">
              <span className="text-gray-900 dark:text-gray-100">{change.value}</span>
            </div>
          )
          i++
        }
      }

      return (
        <div className="font-mono text-xs bg-gray-50 dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 whitespace-pre-wrap break-all cursor-text">
          {elements}
        </div>
      )
    }

    const oldElements: ReactNode[] = []
    const newElements: ReactNode[] = []
    let i = 0

    while (i < lineChanges.length) {
      const change = lineChanges[i]

      if (change.removed && i + 1 < lineChanges.length && lineChanges[i + 1].added) {
        const removed = change.value
        const added = lineChanges[i + 1].value
        const removedLinesSplit = removed.split('\n')
        const addedLinesSplit = added.split('\n')
        const removedLines = removed.endsWith('\n') ? removedLinesSplit.slice(0, -1) : removedLinesSplit
        const addedLines = added.endsWith('\n') ? addedLinesSplit.slice(0, -1) : addedLinesSplit
        const maxLines = Math.max(removedLines.length, addedLines.length)

        for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
          const removedLine = removedLines[lineIdx]
          const addedLine = addedLines[lineIdx]

          if (removedLine !== undefined && addedLine !== undefined) {
            const charDiff = Diff.diffWords(removedLine, addedLine)

            oldElements.push(
              <div key={`${i}-old-${lineIdx}`} className="bg-orange-100 dark:bg-orange-900/40 block">
                {charDiff.map((part, j) => {
                  if (part.removed) {
                    return (
                      <span key={j} className="bg-orange-200/60 dark:bg-orange-700/60 text-orange-900 dark:text-orange-200">
                        {part.value}
                      </span>
                    )
                  } else if (!part.added) {
                    return <span key={j} className="text-gray-900 dark:text-gray-100">{part.value}</span>
                  }
                  return null
                })}
              </div>
            )

            newElements.push(
              <div key={`${i}-new-${lineIdx}`} className="bg-blue-100 dark:bg-blue-900/40 block">
                {charDiff.map((part, j) => {
                  if (part.added) {
                    return (
                      <span key={j} className="bg-blue-200/60 dark:bg-blue-700/60 text-blue-900 dark:text-blue-200">
                        {part.value}
                      </span>
                    )
                  } else if (!part.removed) {
                    return <span key={j} className="text-gray-900 dark:text-gray-100">{part.value}</span>
                  }
                  return null
                })}
              </div>
            )
          } else if (removedLine !== undefined) {
            oldElements.push(
              <div key={`${i}-old-${lineIdx}`} className="bg-orange-100 dark:bg-orange-900/40 text-gray-900 dark:text-gray-100 block">
                {removedLine || '\u00A0'}
              </div>
            )
            newElements.push(
              <div key={`${i}-new-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>
            )
          } else if (addedLine !== undefined) {
            oldElements.push(
              <div key={`${i}-old-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>
            )
            newElements.push(
              <div key={`${i}-new-${lineIdx}`} className="bg-blue-100 dark:bg-blue-900/40 text-gray-900 dark:text-gray-100 block">
                {addedLine || '\u00A0'}
              </div>
            )
          }
        }

        i += 2
      } else if (change.removed) {
        const lines = change.value.split('\n')
        const actualLines = change.value.endsWith('\n') ? lines.slice(0, -1) : lines

        actualLines.forEach((line, lineIdx) => {
          oldElements.push(
            <div key={`${i}-${lineIdx}`} className="bg-orange-100 dark:bg-orange-900/40 text-gray-900 dark:text-gray-100 block">
              {line || '\u00A0'}
            </div>
          )
          newElements.push(
            <div key={`${i}-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>
          )
        })

        i++
      } else if (change.added) {
        const lines = change.value.split('\n')
        const actualLines = change.value.endsWith('\n') ? lines.slice(0, -1) : lines

        actualLines.forEach((line, lineIdx) => {
          oldElements.push(
            <div key={`${i}-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>
          )
          newElements.push(
            <div key={`${i}-${lineIdx}`} className="bg-blue-100 dark:bg-blue-900/40 text-gray-900 dark:text-gray-100 block">
              {line || '\u00A0'}
            </div>
          )
        })

        i++
      } else {
        oldElements.push(
          <div key={i} className="text-gray-900 dark:text-gray-100 block">{change.value}</div>
        )
        newElements.push(
          <div key={i} className="text-gray-900 dark:text-gray-100 block">{change.value}</div>
        )
        i++
      }
    }

    return (
      <div className="font-mono text-xs border border-gray-300 dark:border-gray-600 rounded overflow-hidden cursor-text">
        <div className="grid grid-cols-2">
          <div className="bg-gray-50 dark:bg-gray-900">
            <div className="bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 font-semibold px-2 py-1 border-b border-gray-300 dark:border-gray-600">- Old</div>
            <div
              ref={(el) => {
                if (el) diffOldScrollRefs.current.set(diffIndex, el)
              }}
              onScroll={handleOldScroll}
              className="p-2 whitespace-pre overflow-auto max-h-[80vh]"
            >
              <div className="inline-block min-w-full">{oldElements}</div>
            </div>
          </div>
          <div className="bg-gray-50 dark:bg-gray-900 border-l border-gray-300 dark:border-gray-600">
            <div className="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-semibold px-2 py-1 border-b border-gray-300 dark:border-gray-600">+ New</div>
            <div
              ref={(el) => {
                if (el) diffNewScrollRefs.current.set(diffIndex, el)
              }}
              onScroll={handleNewScroll}
              className="p-2 whitespace-pre overflow-auto max-h-[80vh]"
            >
              <div className="inline-block min-w-full">{newElements}</div>
            </div>
          </div>
        </div>
      </div>
    )
  }, [diffViewMode])

  const renderImageParts = useCallback((imageParts: MessagePart[], keyPrefix: string) => {
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
  }, [])

  const renderImages = useCallback((msg: Message, keyPrefix: string) => {
    const imageParts = msg.parts.filter(p => p.inlineData)
    return renderImageParts(imageParts, keyPrefix)
  }, [renderImageParts])

  type ToolCallRendererParams = {
    call: FunctionCall
    isExpanded: boolean
    viewMode: ToolViewMode
    callIdx: number
  }

  type ToolResponseRendererParams = {
    resp: FunctionResponse
    isExpanded: boolean
  }

  const renderInlineToolSummary = useCallback((name: string, summary: ReactNode, summaryClassName = 'text-gray-700 dark:text-gray-200') => (
    <div className="flex items-center gap-2 min-w-0">
      <ToolLabel name={name} />
      <div className={`min-w-0 flex-1 ${summaryClassName}`}>{summary}</div>
    </div>
  ), [])

  const defaultToolCallRenderer = useCallback(({ call, isExpanded }: ToolCallRendererParams) => {
    const argsFormatted = formatObject(call.args)
    const preview = argsFormatted.length > 200 ? `${argsFormatted.substring(0, 200)}...` : argsFormatted
    return {
      content: (
        <div className="space-y-1">
          {isExpanded ? (
            <>
              <ToolLabel name={call.name} />
              <div className="whitespace-pre-wrap break-all">{argsFormatted}</div>
            </>
          ) : renderInlineToolSummary(
            call.name,
            <div className="truncate break-all">{preview}</div>
          )}
        </div>
      )
    }
  }, [renderInlineToolSummary])

  const formatToolResponseText = useCallback((resp: FunctionResponse): string => {
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
  }, [])

  const getToolResponseStatus = useCallback((resp: FunctionResponse): 'success' | 'error' => {
    if (resp.response?.error !== undefined && resp.response?.error !== null) {
      return 'error'
    }
    if (resp.name === 'edit') {
      return resp.response?.output === 'File edited successfully' ? 'success' : 'error'
    }
    return 'success'
  }, [])

  const defaultToolResponseRenderer = useCallback(({ resp, isExpanded }: ToolResponseRendererParams) => {
    const respFormatted = formatToolResponseText(resp)
    const preview = respFormatted.length > 400 ? `${respFormatted.substring(0, 400)}...` : respFormatted
    return { content: <div className="whitespace-pre-wrap break-all cursor-text">{isExpanded ? respFormatted : preview}</div> }
  }, [formatToolResponseText])

  const toolCallRenderers = useMemo<Record<string, (params: ToolCallRendererParams) => { content: ReactNode }>>(() => ({
    read: ({ call, isExpanded }) => {
      const extra = (call.args.startLine || call.args.endLine)
        ? ` (lines ${call.args.startLine || 1}-${call.args.endLine || 'end'})`
        : ''
      return {
        content: isExpanded ? (
          <div className="space-y-1">
            {renderInlineToolSummary(
              call.name,
              <div className="whitespace-pre-wrap break-all">
                <span>{call.args.filePath}</span>
                {extra && <span className="ml-2 text-gray-500 dark:text-gray-400">{extra}</span>}
              </div>
            )}
          </div>
        ) : renderInlineToolSummary(
          call.name,
          <div className="truncate" title={`${call.args.filePath}${extra}`}>
            <span>{call.args.filePath}</span>
            {extra && <span className="ml-2 text-gray-500 dark:text-gray-400">{extra}</span>}
          </div>
        )
      }
    },
    write: ({ call, isExpanded }) => ({
      content: (
        <div className="space-y-1">
          {renderInlineToolSummary(
            call.name,
            isExpanded
              ? <div className="whitespace-pre-wrap break-all">{call.args.filePath}</div>
              : <div className="truncate" title={call.args.filePath}>{call.args.filePath}</div>
          )}
          {isExpanded && call.args.content && (
            <pre className="mt-2 whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">
              {call.args.content}
            </pre>
          )}
        </div>
      )
    }),
    edit: ({ call, isExpanded, callIdx }) => {
      const hasLegacyDiff = typeof call.args.oldText === 'string' && typeof call.args.newText === 'string'
      const oldLines = hasLegacyDiff ? call.args.oldText.split('\n').length - (call.args.oldText.endsWith('\n') ? 1 : 0) : 0
      const newLines = hasLegacyDiff ? call.args.newText.split('\n').length - (call.args.newText.endsWith('\n') ? 1 : 0) : 0

      const stats = hasLegacyDiff ? (
        <span className="text-xs">
          <span className="text-orange-600 dark:text-orange-400">-{oldLines}</span>
          <span className="mx-1 text-gray-500">/</span>
          <span className="text-blue-600 dark:text-blue-400">+{newLines}</span>
        </span>
      ) : (
        <span className="text-xs text-gray-500">legacy payload unavailable</span>
      )
      const path = <span className="text-gray-600 dark:text-gray-400">{call.args.filePath}</span>

      return {
        content: (
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 flex-wrap">
                <ToolLabel name={call.name} />
                {stats}
                {path}
              </span>
            </div>
            {isExpanded && (
              <div>
                <div className="mt-2" onClick={(e) => e.stopPropagation()}>
                  {hasLegacyDiff ? renderDiff(call.args.oldText, call.args.newText, callIdx) : (
                    <pre className="whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">
                      {JSON.stringify(call.args, null, 2)}
                    </pre>
                  )}
                </div>
                <div className="mt-2 text-center">
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setExpandedTool(null)
                    }}
                    className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                  >
                    Collapse ▲
                  </button>
                </div>
              </div>
            )}
          </div>
        )
      }
    },
    apply_patch: ({ call, isExpanded, callIdx }) => {
      try {
        const operations = parseApplyPatchPreview(call.args.input)
        const totalHunks = operations.reduce((sum, operation) => sum + (operation.action === 'update' ? operation.hunks.length : 0), 0)
        const fileSummary = operations.length === 1 ? operations[0].filePath : `${operations[0].filePath} +${operations.length - 1} more`

        return {
          content: (
            <div>
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2 flex-wrap">
                  <ToolLabel name={call.name} />
                  <span className="ml-2 text-xs text-gray-500">{operations.length} op{operations.length > 1 ? 's' : ''}{totalHunks > 0 ? ` • ${totalHunks} hunk${totalHunks > 1 ? 's' : ''}` : ''}</span>
                  <span className="ml-2 text-gray-600 dark:text-gray-400">{fileSummary}</span>
                </span>
              </div>
              {isExpanded && (
                <div className="mt-2 space-y-4" onClick={(e) => e.stopPropagation()}>
                  {operations.map((operation, operationIdx) => {
                    if (operation.action === 'update') {
                      return (
                        <div key={operationIdx} className="space-y-3">
                          <div className="text-xs font-semibold text-gray-600 dark:text-gray-300">Update {operation.filePath}</div>
                          {operation.hunks.map((hunk, hunkIdx) => {
                            const snippets = buildPatchHunkSnippets(hunk)
                            const diffKey = callIdx * 1000 + operationIdx * 100 + hunkIdx
                            return (
                              <div key={hunkIdx} className="space-y-1">
                                {hunk.anchors.length > 0 && (
                                  <div className="text-[11px] text-gray-500 dark:text-gray-400">
                                    {hunk.anchors.map((anchor, anchorIdx) => (
                                      <div key={anchorIdx}>@@ {anchor}</div>
                                    ))}
                                  </div>
                                )}
                                {renderDiff(snippets.oldText, snippets.newText, diffKey)}
                              </div>
                            )
                          })}
                        </div>
                      )
                    }

                    if (operation.action === 'add') {
                      const diffKey = callIdx * 1000 + operationIdx * 100
                      return (
                        <div key={operationIdx} className="space-y-1">
                          <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Add {operation.filePath}</div>
                          {renderDiff('', operation.lines.join('\n'), diffKey)}
                        </div>
                      )
                    }

                    return (
                      <div key={operationIdx} className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-700 dark:text-red-300">
                        Delete {operation.filePath}
                      </div>
                    )
                  })}
                  <div className="mt-2 text-center">
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        setExpandedTool(null)
                      }}
                      className="text-xs text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
                    >
                      Collapse ▲
                    </button>
                  </div>
                </div>
              )}
            </div>
          )
        }
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        return {
          content: (
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <ToolLabel name={call.name} />
                <span className="text-xs text-red-500">invalid patch</span>
              </div>
              {isExpanded && (
                <pre className="mt-2 whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">
                  {error}\n\n{call.args.input || JSON.stringify(call.args, null, 2)}
                </pre>
              )}
            </div>
          )
        }
      }
    },
    exec: ({ call, isExpanded }) => {
      const preview = call.args.command.length > 200 ? `${call.args.command.substring(0, 200)}...` : call.args.command
      return {
        content: (
          <div className="space-y-1">
            {isExpanded ? (
              <>
                <ToolLabel name={call.name} />
                <div className="break-all">{call.args.command}</div>
              </>
            ) : renderInlineToolSummary(
              call.name,
              <div className="truncate font-mono" title={call.args.command}>{preview}</div>
            )}
          </div>
        )
      }
    },
    send_to_session: ({ call, isExpanded }) => {
      const targetSessionId = String(call.args.sessionId || '')
      const message = typeof call.args.message === 'string' ? call.args.message : formatObject(call.args.message)
      const preview = message.length > 200 ? `${message.slice(0, 200)}...` : message

      return {
        content: (
          <div className="space-y-1">
            {isExpanded ? (
              <>
                {renderInlineToolSummary(
                  call.name,
                  <div className="whitespace-pre-wrap break-all">
                    <SessionHashLink sessionId={targetSessionId} />
                  </div>
                )}
                <div className="whitespace-pre-wrap break-all">{message}</div>
              </>
            ) : renderInlineToolSummary(
              call.name,
              <div className="truncate" title={`${targetSessionId}: ${message}`}>
                <SessionHashLink sessionId={targetSessionId} />
                <span>: {preview}</span>
              </div>
            )}
          </div>
        )
      }
    }
  }), [renderDiff, renderInlineToolSummary])

  const toolResponseRenderers = useMemo<Record<string, (params: ToolResponseRendererParams) => { content: ReactNode | null }>>(() => ({
    read: ({ resp, isExpanded }) => {
      const fileContent = resp.response.content || resp.response.output || JSON.stringify(resp.response)
      return {
        content: isExpanded ? (
          <pre className="whitespace-pre-wrap text-xs overflow-x-auto cursor-text">{fileContent}</pre>
        ) : null,
      }
    },
    write: () => ({ content: null }),
    edit: ({ resp, isExpanded }) => {
      if (getToolResponseStatus(resp) === 'success') {
        return { content: null }
      }

      const raw = formatToolResponseText(resp)
      const preview = raw.length > 400 ? `${raw.substring(0, 400)}...` : raw
      return {
        content: (
          <pre className="whitespace-pre-wrap break-all cursor-text text-red-700 dark:text-red-300">
            {isExpanded ? raw : preview}
          </pre>
        ),
      }
    },
    exec: ({ resp, isExpanded }) => {
      const output = resp.response.output || ''
      const preview = output.length > 400 ? `${output.substring(0, 400)}...` : output
      const displayStr = isExpanded ? output : preview
      return {
        content: <div className="whitespace-pre-wrap break-all cursor-text">{parseAnsi(displayStr)}</div>,
      }
    }
  }), [formatToolResponseText, getToolResponseStatus])

  const getToolGroupMessages = useCallback((idx: number) => {
    const nextMsg = idx < messages.length - 1 ? messages[idx + 1] : null
    const functionCalls = messages[idx].parts.filter(p => p.functionCall).map(p => p.functionCall!)
    const functionResponses = nextMsg?.role === 'tool'
      ? nextMsg.parts.filter(p => p.functionResponse).map(p => p.functionResponse!)
      : []

    return {
      nextMsg,
      functionCalls,
      functionResponses,
      hasFollowingToolMsg: nextMsg?.role === 'tool' && functionResponses.length > 0,
    }
  }, [messages])

  const renderToolCallItem = useCallback((
    call: FunctionCall,
    idx: number,
    callIdx: number,
    options: { hasFollowingContent: boolean }
  ) => {
    const toolKey = `${idx}-call-${callIdx}`
    const isExpanded = expandedTool === toolKey
    const viewMode = toolViewModes.get(toolKey) || 'default'

    let content: ReactNode
    if (viewMode === 'json') {
      content = (
        <pre className="whitespace-pre-wrap break-all cursor-text text-gray-600 dark:text-gray-300">
          {JSON.stringify(call, null, 2)}
        </pre>
      )
    } else {
      const renderer = toolCallRenderers[call.name] || defaultToolCallRenderer
      content = renderer({ call, isExpanded, viewMode, callIdx }).content
    }

    const roundedClass = callIdx === 0 ? 'rounded-t' : ''
    const borderClass = options.hasFollowingContent ? 'border-b-0' : ''

    return (
      <div key={toolKey} className={`text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 ${roundedClass} p-2 ${borderClass} relative group`}>
        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {call.name === 'edit' || call.name === 'apply_patch' ? (
            <>
              <MiniToggleButton
                onClick={(e) => {
                  e.stopPropagation()
                  if (diffViewMode !== 'unified') toggleDiffView()
                  setToolView(toolKey, 'default')
                }}
                active={viewMode !== 'json' && diffViewMode === 'unified'}
                title="Unified"
              >
                Unified
              </MiniToggleButton>
              <MiniToggleButton
                onClick={(e) => {
                  e.stopPropagation()
                  if (diffViewMode !== 'split') toggleDiffView()
                  setToolView(toolKey, 'default')
                }}
                active={viewMode !== 'json' && diffViewMode === 'split'}
                title="Split"
              >
                Split
              </MiniToggleButton>
              <MiniToggleButton
                onClick={(e) => {
                  e.stopPropagation()
                  setToolView(toolKey, 'json')
                }}
                active={viewMode === 'json'}
                title="JSON"
              >
                JSON
              </MiniToggleButton>
            </>
          ) : (
            <>
              <IconToggleButton
                onClick={(e) => {
                  e.stopPropagation()
                  setToolView(toolKey, 'default')
                }}
                active={viewMode === 'default'}
                title="Default"
              >
                <Eye size={12} />
              </IconToggleButton>
              <IconToggleButton
                onClick={(e) => {
                  e.stopPropagation()
                  setToolView(toolKey, 'json')
                }}
                active={viewMode === 'json'}
                title="JSON"
              >
                <FileJson size={14} />
              </IconToggleButton>
            </>
          )}
        </div>
        <div
          className="font-mono text-gray-500 dark:text-gray-400 cursor-pointer hover:text-gray-700 dark:hover:text-gray-200"
          onClick={() => setExpandedTool(isExpanded ? null : toolKey)}
        >
          <div style={isExpanded ? undefined : clampContentStyle(1, 0.25)}>{content}</div>
        </div>
      </div>
    )
  }, [defaultToolCallRenderer, diffViewMode, expandedTool, setToolView, toggleDiffView, toolCallRenderers, toolViewModes])

  const renderToolResponseItem = useCallback((
    resp: FunctionResponse,
    idx: number,
    respIdx: number,
    options: { hasPrecedingCall: boolean; isLast: boolean }
  ) => {
    const toolKey = `${idx}-resp-${respIdx}`
    const isExpanded = expandedTool === toolKey
    const viewMode = toolViewModes.get(toolKey) || 'default'
    const responseStatus = getToolResponseStatus(resp)
    const isError = responseStatus === 'error'

    let content: ReactNode | null
    if (viewMode === 'json') {
      content = (
        <pre className="whitespace-pre-wrap break-all cursor-text text-green-700 dark:text-green-300">
          {JSON.stringify(resp, null, 2)}
        </pre>
      )
    } else {
      const renderer = toolResponseRenderers[resp.name] || defaultToolResponseRenderer
      content = renderer({ resp, isExpanded }).content
    }

    const roundedClass = options.hasPrecedingCall ? '' : 'rounded-t'
    const roundedBottomClass = options.isLast ? 'rounded-b' : ''
    const borderClass = options.isLast ? '' : 'border-b-0'

    return (
      <div key={toolKey} className={`text-xs ${isError ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800' : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'} border ${roundedClass} ${roundedBottomClass} p-2 ${borderClass} relative group`}>
        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <IconToggleButton
            onClick={(e) => {
              e.stopPropagation()
              setToolView(toolKey, 'default')
            }}
            active={viewMode === 'default'}
            title="Default"
          >
            <Eye size={12} />
          </IconToggleButton>
          <IconToggleButton
            onClick={(e) => {
              e.stopPropagation()
              setToolView(toolKey, 'json')
            }}
            active={viewMode === 'json'}
            title="JSON"
          >
            <FileJson size={14} />
          </IconToggleButton>
        </div>
        <div
          className={`font-mono cursor-pointer ${isError ? 'text-red-600 dark:text-red-400 hover:text-red-800 dark:hover:text-red-300' : 'text-green-600 dark:text-green-400 hover:text-green-800 dark:hover:text-green-300'}`}
          onClick={() => setExpandedTool(isExpanded ? null : toolKey)}
        >
          <span className="inline-flex items-center gap-1.5">
            {isError ? <X size={12} /> : <Check size={12} />}
            <span>{resp.name}</span>
          </span>
        </div>
        {content && (
          <div
            className={`font-mono mt-1 ${isError ? 'text-red-700 dark:text-red-300' : 'text-green-700 dark:text-green-300'}`}
            style={isExpanded ? undefined : clampContentStyle(3)}
          >
            {content}
          </div>
        )}
      </div>
    )
  }, [defaultToolResponseRenderer, expandedTool, getToolResponseStatus, setToolView, toolResponseRenderers, toolViewModes])

  const renderInterleavedToolGroup = useCallback((idx: number) => {
    const { nextMsg, functionCalls, functionResponses, hasFollowingToolMsg } = getToolGroupMessages(idx)
    if (!hasFollowingToolMsg || !nextMsg) return null

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

    const renderedResponseIndexes = new Set<number>()

    return (
      <div>
        {functionCalls.map((call, callIdx) => {
          const toolId = call.id
          const responseEntries = toolId ? (responseEntriesById.get(toolId) || []) : []
          const imageParts = toolId ? (imageEntriesById.get(toolId) || []) : []
          const hasFollowingContent = responseEntries.length > 0 || imageParts.length > 0

          responseEntries.forEach(({ respIdx }) => renderedResponseIndexes.add(respIdx))

          return (
            <div key={`${idx}-group-${toolId || callIdx}`}>
              {renderToolCallItem(call, idx, callIdx, { hasFollowingContent })}
              {responseEntries.map(({ resp, respIdx }, entryIdx) =>
                renderToolResponseItem(resp, idx + 1, respIdx, {
                  hasPrecedingCall: true,
                  isLast: entryIdx === responseEntries.length - 1 && imageParts.length === 0,
                })
              )}
              {imageParts.length > 0 && (
                <div className="rounded-b border border-t-0 border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-2 pb-2">
                  {renderImageParts(imageParts, `${idx + 1}-tool-image-${toolId || callIdx}`)}
                </div>
              )}
            </div>
          )
        })}
        {unmatchedResponses
          .filter(({ respIdx }) => !renderedResponseIndexes.has(respIdx))
          .map(({ resp, respIdx }, orphanIdx) =>
            renderToolResponseItem(resp, idx + 1, respIdx, {
              hasPrecedingCall: false,
              isLast: orphanIdx === unmatchedResponses.length - 1 && unmatchedImageParts.length === 0,
            })
          )}
        {Array.from(imageEntriesById.entries())
          .filter(([toolId]) => !functionCalls.some(call => call.id === toolId))
          .map(([toolId, imageParts], orphanIdx, orphaned) => (
            <div
              key={`${idx + 1}-orphan-matched-tool-image-${toolId}`}
              className={`border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-2 pb-2 ${orphanIdx === orphaned.length - 1 && unmatchedImageParts.length === 0 ? 'rounded-b' : ''}`}
            >
              {renderImageParts(imageParts, `${idx + 1}-orphan-matched-tool-image-${toolId}`)}
            </div>
          ))}
        {unmatchedImageParts.length > 0 && (
          <div className="rounded-b border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 px-2 pb-2">
            {renderImageParts(unmatchedImageParts, `${idx + 1}-orphan-tool-image`)}
          </div>
        )}
      </div>
    )
  }, [getToolGroupMessages, renderImageParts, renderToolCallItem, renderToolResponseItem])

  const renderToolCalls = useCallback((msg: Message, idx: number) => {
    const functionCalls = msg.parts.filter(p => p.functionCall).map(p => p.functionCall!)
    if (functionCalls.length === 0) return null

    const nextMsg = idx < messages.length - 1 ? messages[idx + 1] : null
    const hasFollowingToolMsg = nextMsg?.role === 'tool'

    return (
      <div>
        {functionCalls.map((call, callIdx) => renderToolCallItem(call, idx, callIdx, {
          hasFollowingContent: callIdx < functionCalls.length - 1 || hasFollowingToolMsg,
        }))}
      </div>
    )
  }, [messages, renderToolCallItem])

  const renderToolGroupSummary = useCallback((idx: number) => {
    const toolNames = toolGroupMeta.summaryTagsByIndex[idx]
    if (toolNames.length === 0) return null

    return (
      <div
        className="text-xs bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
        onClick={() => setExpandedToolGroups(prev => new Set(prev).add(toolGroupMeta.groupKeyByIndex[idx]))}
      >
        <div className="flex items-start gap-2">
          <ToolTagList names={toolNames} />
        </div>
      </div>
    )
  }, [toolGroupMeta.groupKeyByIndex, toolGroupMeta.summaryTagsByIndex])

  const renderToolResponses = useCallback((msg: Message, idx: number) => {
    const functionResponses = msg.parts.filter(p => p.functionResponse).map(p => p.functionResponse!)
    if (functionResponses.length === 0) return null

    const prevMsg = idx > 0 ? messages[idx - 1] : null
    const hasPrecedingCallMsg = prevMsg?.role === 'model' && prevMsg.parts.some(p => p.functionCall)

    if (!verbose) {
      const groupKey = toolGroupMeta.groupKeyByIndex[idx]
      if (!expandedToolGroups.has(groupKey)) {
        return null
      }
    }

    return (
      <div>
        {functionResponses.map((resp, respIdx) => renderToolResponseItem(resp, idx, respIdx, {
          hasPrecedingCall: respIdx === 0 && hasPrecedingCallMsg,
          isLast: respIdx === functionResponses.length - 1,
        }))}
      </div>
    )
  }, [expandedToolGroups, messages, renderToolResponseItem, toolGroupMeta.groupKeyByIndex, verbose])

  return (
    <>
      {messages.map((msg, idx) => {
        if (toolGroupMeta.handledByPreviousGroup[idx]) {
          return null
        }

        const textLikeParts = msg.parts.filter(p => p.text || p.system || p.thinking)
        const systemLikeMessage = isSystemLikeMessage(msg)
        const interleavedToolGroup = renderInterleavedToolGroup(idx)
        const prevMsg = idx > 0 ? messages[idx - 1] : null
        const shouldSkipMargin = !systemLikeMessage && (msg.role === 'model' || msg.role === 'tool') &&
          (prevMsg?.role === 'model' || prevMsg?.role === 'tool')
        const isInToolGroup = toolGroupMeta.summaryTagsByIndex[idx].length > 0
        const groupKey = toolGroupMeta.groupKeyByIndex[idx]
        const isCollapsedToolGroup = !verbose && isInToolGroup && !expandedToolGroups.has(groupKey)

        return (
          <div
            key={idx}
            className={`flex ${systemLikeMessage ? 'justify-start' : (msg.role === 'user' ? 'justify-end' : 'justify-start')} ${shouldSkipMargin ? '' : 'mt-4'}`}
          >
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
              {systemLikeMessage ? renderSystemLikeMessage(msg, `msg-${idx}`) : msg.role === 'user' ? (
                <div className="flex flex-col">
                  {textLikeParts.map((part, partIdx) => {
                    const messageKey = `${idx}-${partIdx}`

                    if (part.system) {
                      return renderInlineMetaPart(formatStructuredSystemText(part.system), messageKey, true)
                    }

                    const text = part.text || ''
                    const isSystemMessage = isCollapsibleSystemText(text)
                    const isExpanded = expandedSystemMessages.has(messageKey)
                    const shouldCollapse = isSystemMessage && !isExpanded

                    return (
                      <div key={partIdx}>
                        <div
                          className={`${shouldCollapse ? 'overflow-hidden' : ''}`}
                          style={shouldCollapse ? { maxHeight: 'calc(1.5em * 4)' } : {}}
                        >
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
                            onClick={() => {
                              const newExpanded = new Set(expandedSystemMessages)
                              if (isExpanded) {
                                newExpanded.delete(messageKey)
                              } else {
                                newExpanded.add(messageKey)
                              }
                              setExpandedSystemMessages(newExpanded)
                            }}
                            className="text-xs text-blue-200 hover:text-white mt-1 text-left"
                          >
                            {isExpanded ? '▲ Show less' : '▼ Show more'}
                          </button>
                        )}
                      </div>
                    )
                  })}
                  {renderImages(msg, `user-${idx}`)}
                </div>
              ) : (
                <div className="flex flex-col">
                  {textLikeParts.map((part, partIdx) => {
                    const messageKey = `${idx}-${partIdx}`
                    if (part.system) {
                      return renderInlineMetaPart(formatStructuredSystemText(part.system), messageKey, false)
                    }
                    if (part.thinking) {
                      if (!verbose && !hasTextContent(msg) && isInToolGroup && !expandedToolGroups.has(groupKey)) {
                        return null
                      }
                      const isExpanded = expandedReasoningSummaries.has(messageKey)
                      return (
                        <ReasoningSummaryCard
                          key={messageKey}
                          thinking={part.thinking}
                          tone="message"
                          isExpanded={isExpanded}
                          onToggle={() => {
                            const next = new Set(expandedReasoningSummaries)
                            if (isExpanded) {
                              next.delete(messageKey)
                            } else {
                              next.add(messageKey)
                            }
                            setExpandedReasoningSummaries(next)
                          }}
                        />
                      )
                    }

                    const text = part.text || ''
                    const viewMode = messageViewModes.get(idx) || 'rendered'
                    const paddingClass = viewMode === 'rendered' ? 'px-2' : 'px-2 py-2'
                    const copied = copiedMessageKey === messageKey

                    return (
                      <div key={partIdx} className={`bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 ${paddingClass} rounded-lg cursor-text relative group`}>
                        <div className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <IconToggleButton
                            onClick={() => setMessageView(idx, 'rendered')}
                            active={viewMode === 'rendered'}
                            title="Rendered (Markdown)"
                          >
                            <Eye size={12} />
                          </IconToggleButton>
                          <IconToggleButton
                            onClick={() => setMessageView(idx, 'raw')}
                            active={viewMode === 'raw'}
                            title="Raw Text"
                          >
                            <Code size={12} />
                          </IconToggleButton>
                          <IconToggleButton
                            onClick={() => setMessageView(idx, 'json')}
                            active={viewMode === 'json'}
                            title="JSON"
                          >
                            <FileJson size={14} />
                          </IconToggleButton>
                          <IconToggleButton
                            onClick={(e) => {
                              e.preventDefault()
                              e.stopPropagation()
                              void handleCopyRawText(messageKey, text)
                            }}
                            active={copied}
                            title={copied ? 'Copied' : 'Copy Raw Text'}
                          >
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
                          <pre className="whitespace-pre-wrap font-mono text-sm text-gray-900 dark:text-gray-100 overflow-x-auto pr-32">
                            {JSON.stringify(msg, null, 2)}
                          </pre>
                        )}
                      </div>
                    )
                  })}
                  {renderImages(msg, `message-${idx}`)}
                  {!verbose && toolGroupMeta.shouldRenderSummary[idx] && !expandedToolGroups.has(groupKey) && renderToolGroupSummary(idx)}
                  {isCollapsedToolGroup ? null : (interleavedToolGroup || renderToolCalls(msg, idx))}
                  {isCollapsedToolGroup ? null : (interleavedToolGroup ? null : renderToolResponses(msg, idx))}
                </div>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
})

export default ChatTimeline
