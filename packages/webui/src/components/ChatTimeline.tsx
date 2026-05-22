import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent, ReactNode, UIEvent } from 'react'
import { Eye, Code, FileJson, Copy, Check, Download } from 'lucide-react'
import {
  Diff,
  IconToggleButton,
  MiniToggleButton,
  ToolTag,
  ToolTagList,
  SessionHashLink,
  buildPatchHunkSnippets,
  clampContentStyle,
  copyTextToClipboard,
  formatToolLabel,
  formatCompactObjectPreview,
  formatStructuredSystemText,
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
import { formatToolResponsePayload } from '../../../shared/src/toolResponseFormatting'
import ReasoningCard from './ReasoningCard'
import { SyntaxHighlightedText } from './SyntaxHighlightedText'
import { buildWorkspaceDownloadUrl, triggerBrowserDownload } from './workspaceShared'

const formatToolResponseText = (resp: { response: unknown }): string => formatToolResponsePayload(resp.response)

const getMessageStableKey = (msg: Message, idx: number): string => {
  const meta = msg.__meta || {}
  if (meta.synthetic) return `synthetic-${String(meta.synthetic)}`
  if (meta.id) return `id-${String(meta.id)}`
  if (meta.timestamp !== undefined) return `ts-${String(meta.timestamp)}`
  return `idx-${idx}`
}

const getSendFileDownload = (call: FunctionCall | undefined, resp: FunctionResponse): { url: string; fileName?: string } | null => {
  if (resp.name !== 'send_file') {
    return null
  }

  const response = resp.response
  const fullPath = response && typeof response === 'object' && !Array.isArray(response)
    ? (response as { fullPath?: unknown }).fullPath
    : undefined

  const resolvedPath = typeof fullPath === 'string' && fullPath.trim()
    ? fullPath.trim()
    : (typeof call?.args?.filePath === 'string' && call.args.filePath.trim() ? call.args.filePath.trim() : null)

  if (!resolvedPath) {
    return null
  }

  const fileName = resolvedPath.split(/[\\/]/).filter(Boolean).pop()
  return {
    url: buildWorkspaceDownloadUrl(resolvedPath),
    fileName,
  }
}

const ToolDownloadButton = memo(function ToolDownloadButton({ url, fileName }: { url: string; fileName?: string }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        triggerBrowserDownload(url)
      }}
      className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-200 dark:hover:bg-blue-900/30"
      title={fileName ? `Download ${fileName}` : 'Download file'}
    >
      <Download size={12} />
      <span>{fileName ? `Download ${fileName}` : 'Download file'}</span>
    </button>
  )
})

type ToolThreadTone = 'neutral' | 'success' | 'error'

const toolThreadLineToneClasses: Record<ToolThreadTone, string> = {
  neutral: 'text-slate-300 hover:text-slate-500 focus-visible:text-slate-500 dark:text-slate-600 dark:hover:text-slate-400 dark:focus-visible:text-slate-400',
  success: 'text-emerald-300 hover:text-emerald-500 focus-visible:text-emerald-500 dark:text-emerald-700 dark:hover:text-emerald-400 dark:focus-visible:text-emerald-400',
  error: 'text-red-300 hover:text-red-500 focus-visible:text-red-500 dark:text-red-700 dark:hover:text-red-400 dark:focus-visible:text-red-400',
}

const toolSurfaceToneClasses: Record<ToolThreadTone, string> = {
  neutral: 'my-0.5 bg-slate-100/45 dark:bg-slate-800/20',
  success: 'my-0.5 bg-emerald-50/55 dark:bg-emerald-900/10',
  error: 'my-0.5 bg-red-50/55 dark:bg-red-900/10',
}

const toolHeaderToneClasses: Record<ToolThreadTone, string> = {
  neutral: '-ml-2 bg-slate-200/80 pl-2 pr-0 py-1 dark:bg-slate-700/25',
  success: '-ml-2 bg-emerald-100/80 pl-2 pr-0 py-1 dark:bg-emerald-800/20',
  error: '-ml-2 bg-red-100/85 pl-2 pr-0 py-1 dark:bg-red-800/20',
}

const ToolThreadLineButton = memo(function ToolThreadLineButton({
  expanded,
  onToggle,
  tone = 'neutral',
  label,
}: {
  expanded: boolean
  onToggle: () => void
  tone?: ToolThreadTone
  label: string
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
      className={`absolute bottom-0 -left-2 top-0 flex w-4 cursor-pointer items-stretch justify-start rounded-md transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 sm:-left-2.5 sm:w-5 ${toolThreadLineToneClasses[tone]}`}
    >
      <span className="ml-2 block w-[2px] bg-current opacity-80 transition-opacity group-hover:opacity-100 sm:ml-2.5" />
    </button>
  )
})

interface ChatTimelineProps {
  messages: Message[]
  isMobile: boolean
  groupTools: boolean
  showUsageBadge: boolean
}

interface TokenUsage {
  cachedTokens?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
  cachedContentTokenCount?: number | null
  promptTokenCount?: number | null
  candidatesTokenCount?: number | null
}

type NormalizedTokenUsage = {
  cachedTokens: number
  inputTokens: number
  outputTokens: number
}

const toTokenCount = (value: unknown): number | null => {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

const normalizeMessageUsage = (value: unknown): NormalizedTokenUsage | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const raw = value as TokenUsage
  const cached = toTokenCount(raw.cachedTokens) ?? toTokenCount(raw.cachedContentTokenCount)
  const input = toTokenCount(raw.inputTokens) ?? toTokenCount(raw.promptTokenCount)
  const output = toTokenCount(raw.outputTokens) ?? toTokenCount(raw.candidatesTokenCount)

  if (cached === null && input === null && output === null) return null

  return {
    cachedTokens: cached ?? 0,
    inputTokens: input ?? 0,
    outputTokens: output ?? 0,
  }
}

const getModelMessageUsage = (msg: Message) => msg.role === 'model' ? normalizeMessageUsage(msg.__meta?.usage) : null

const getUsageTotalTokens = (usage: NormalizedTokenUsage) => (
  usage.cachedTokens + usage.inputTokens + usage.outputTokens
)

const formatTokenCount = (count: number): string => {
  if (count >= 1000000) return `${(count / 1000000).toFixed(count >= 10000000 ? 0 : 1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}K`
  return String(count)
}

const formatUsageTitle = (usage: NormalizedTokenUsage, callCount?: number) => {
  const total = getUsageTotalTokens(usage)
  return `Token usage: ${total} total • input ${usage.inputTokens} • output ${usage.outputTokens} • cached ${usage.cachedTokens}${callCount ? ` • calls ${callCount}` : ''}`
}

const ModelUsageRow = ({ label, value, tone }: { label: string; value: number; tone: 'muted' | 'normal' | 'warning' }) => {
  const colorClass = tone === 'warning'
    ? 'text-orange-600 dark:text-orange-400'
    : tone === 'muted'
      ? 'text-slate-400 dark:text-slate-500'
      : 'text-slate-500 dark:text-slate-400'

  return (
    <span className={`flex items-baseline justify-between gap-1 ${colorClass}`}>
      <span className="text-[10px] uppercase tracking-wide opacity-80">{label}</span>
      <span className="text-[10px] font-semibold tabular-nums">{formatTokenCount(value)}</span>
    </span>
  )
}

const ModelUsageBadge = memo(function ModelUsageBadge({ usage, isMobile, callCount }: { usage: NormalizedTokenUsage; isMobile: boolean; callCount?: number }) {
  return (
    <span
      className={`${isMobile ? 'gap-2' : 'gap-1.5'} inline-flex flex-row items-center rounded-md border border-slate-200 bg-white/85 px-2 py-1 font-mono leading-none shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/85`}
      title={formatUsageTitle(usage, callCount)}
    >
      {callCount ? <ModelUsageRow label="×" value={callCount} tone="normal" /> : null}
      <ModelUsageRow label="C" value={usage.cachedTokens} tone="muted" />
      <ModelUsageRow label="I" value={usage.inputTokens} tone={usage.inputTokens > 30000 ? 'warning' : 'normal'} />
      <ModelUsageRow label="O" value={usage.outputTokens} tone={usage.outputTokens > 3000 ? 'warning' : 'normal'} />
    </span>
  )
})

const ModelUsageAnchor = memo(function ModelUsageAnchor({ usage, isMobile, callCount }: { usage: NormalizedTokenUsage; isMobile: boolean; callCount?: number }) {
  if (isMobile) {
    return (
      <div className="pointer-events-none mb-2 mt-1 flex justify-end pr-1">
        <ModelUsageBadge usage={usage} isMobile={isMobile} callCount={callCount} />
      </div>
    )
  }

  return (
    <div className="pointer-events-none absolute bottom-0 right-0 z-10 translate-x-[calc(100%+0.5rem)]">
      <ModelUsageBadge usage={usage} isMobile={isMobile} callCount={callCount} />
    </div>
  )
})

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
      <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
        <pre className="whitespace-pre-wrap font-mono text-sm text-gray-900 dark:text-gray-100">{text}</pre>
      ) : (
        <pre className="whitespace-pre-wrap font-mono text-sm text-gray-900 dark:text-gray-100 overflow-x-auto">{jsonText}</pre>
      )}
    </div>
  )
})

const getToolDisplayLabel = (call: FunctionCall): string => formatToolLabel(call.name, call.args)

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


const getHeredocFilePathFromMarker = (marker: string): string | null => {
  const normalized = marker.toLowerCase()
  if (['py', 'python', 'python3'].includes(normalized)) return 'heredoc.py'
  if (['js', 'javascript', 'node'].includes(normalized)) return 'heredoc.js'
  if (['ts', 'typescript'].includes(normalized)) return 'heredoc.ts'
  if (['sh', 'bash', 'shell', 'zsh'].includes(normalized)) return 'heredoc.sh'
  if (normalized === 'json') return 'heredoc.json'
  if (['yaml', 'yml'].includes(normalized)) return 'heredoc.yaml'
  if (['html', 'xml', 'css', 'sql', 'go', 'rs', 'rust', 'java', 'php', 'rb', 'ruby'].includes(normalized)) {
    const extension = normalized === 'rust' ? 'rs' : normalized === 'ruby' ? 'rb' : normalized
    return `heredoc.${extension}`
  }
  return null
}

const getHeredocFilePathFromCommand = (line: string, marker: string): string => {
  const markerFilePath = getHeredocFilePathFromMarker(marker)
  if (markerFilePath) return markerFilePath

  const lower = line.toLowerCase()
  if (/\bpython(?:\d+(?:\.\d+)?)?\b/.test(lower)) return 'heredoc.py'
  if (/\b(?:node|bun|deno)\b/.test(lower)) return 'heredoc.js'
  if (/\b(?:tsx|ts-node)\b/.test(lower)) return 'heredoc.ts'
  if (/\b(?:bash|sh|zsh|fish)\b/.test(lower)) return 'heredoc.sh'
  if (/\bruby\b/.test(lower)) return 'heredoc.rb'
  if (/\bphp\b/.test(lower)) return 'heredoc.php'
  if (/\b(?:psql|sqlite3?|mysql)\b/.test(lower)) return 'heredoc.sql'
  return 'heredoc.sh'
}

const ExecCommandText = memo(function ExecCommandText({ command, heredocBodyBlock = true }: { command: string; heredocBodyBlock?: boolean }) {
  const segments = useMemo(() => {
    const lines = command.match(/[^\n]*\n|[^\n]+$/g) || (command ? [command] : [])
    const result: Array<{ text: string; filePath: string; heredocBody?: boolean }> = []
    let heredocMarker: string | null = null
    let heredocFilePath = 'heredoc.sh'

    const pushSegment = (text: string, filePath: string, options: { heredocBody?: boolean } = {}) => {
      const { heredocBody = false } = options
      const previous = result[result.length - 1]
      if (previous && previous.filePath === filePath && previous.heredocBody === heredocBody) {
        previous.text += text
      } else {
        result.push({ text, filePath, heredocBody })
      }
    }

    lines.forEach((line) => {
      if (heredocMarker) {
        if (line.trim() === heredocMarker) {
          pushSegment(line, 'command.sh')
          heredocMarker = null
          heredocFilePath = 'heredoc.sh'
          return
        }
        pushSegment(line, heredocFilePath, { heredocBody: true })
        return
      }

      const heredocMatch = line.match(/<<-?\s*['"]?([A-Za-z_][\w-]*)['"]?/)
      pushSegment(line, 'command.sh')
      if (heredocMatch) {
        heredocMarker = heredocMatch[1]
        heredocFilePath = getHeredocFilePathFromCommand(line, heredocMarker)
      }
    })

    return result
  }, [command])

  return (
    <>
      {segments.map((segment, idx) => segment.heredocBody && heredocBodyBlock ? (
        <div key={`${segment.filePath}-${idx}`} className="bg-sky-50/80 px-2 py-1 dark:bg-sky-900/20">
          <SyntaxHighlightedText text={segment.text} filePath={segment.filePath} />
        </div>
      ) : segment.heredocBody ? (
        <span key={`${segment.filePath}-${idx}`} className="bg-sky-50/80 px-0.5 dark:bg-sky-900/20">
          <SyntaxHighlightedText text={segment.text} filePath={segment.filePath} />
        </span>
      ) : (
        <SyntaxHighlightedText key={`${segment.filePath}-${idx}`} text={segment.text} filePath={segment.filePath} />
      ))}
    </>
  )
})

const hasAnsiEscape = (text: string): boolean => /\x1B\[[0-?]*[ -/]*[@-~]/.test(text)

const codeLikePathPattern = /(?:^|\s|[=:])['"]?((?:\.?\.?\/|~\/)?[\w@%+=:,./-]+(?:\.(?:tsx?|jsx?|mjs|cjs|jsonc?|css|scss|sass|less|html?|svelte|vue|mdx?|markdown|ya?ml|bash|zsh|fish|sh|pyw?|go|rs|c|cc|cpp|cxx|h|hpp|cs|java|php|rb|sql|xml|svg)|\/(?:Dockerfile|Containerfile|Makefile)|\/(?:package|tsconfig|jsconfig|composer)\.json|(?:Dockerfile|Containerfile|Makefile)|(?:package|tsconfig|jsconfig|composer)\.json))['"]?(?=$|\s|[;&|)])/gi

const extractCodeLikePaths = (text: string): string[] => {
  const paths: string[] = []
  let match: RegExpExecArray | null
  codeLikePathPattern.lastIndex = 0
  while ((match = codeLikePathPattern.exec(text)) !== null) {
    const path = match[1]
    if (path && !paths.includes(path)) paths.push(path)
  }
  return paths
}

const inferExecOutputFilePath = (command?: string, output?: string): string | null => {
  const cmd = command || ''
  const codeReaderCommand = /\b(?:cat|sed|head|tail|nl|awk)\b/.test(cmd)
  if (codeReaderCommand) {
    const [path] = extractCodeLikePaths(cmd)
    if (path) return path
  }

  const trimmed = (output || '').trim()
  if (!trimmed) return null
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      JSON.parse(trimmed)
      return 'output.json'
    } catch {
      // Not JSON; keep falling through to other lightweight heuristics.
    }
  }
  if (/^\s*(?:import|export)\s/m.test(trimmed) || /^\s*(?:const|let|var|function|class)\s+/m.test(trimmed)) return 'output.ts'
  if (/^\s*(?:def|class|from|import)\s+/m.test(trimmed)) return 'output.py'
  if (/^\s*<\/?[A-Za-z][\s\S]*>\s*$/.test(trimmed)) return 'output.html'
  return null
}

const ExecOutputText = memo(function ExecOutputText({ text, command }: { text: string; command?: string }) {
  const filePath = useMemo(() => inferExecOutputFilePath(command, text), [command, text])
  if (!filePath || hasAnsiEscape(text)) return <>{parseAnsi(text)}</>
  return <SyntaxHighlightedText text={text} filePath={filePath} />
})

const isLegacyDiffToolName = (name: string): boolean => name === 'edit' || name === 'edit_memory'
const isPatchToolName = (name: string): boolean => name === 'apply_patch' || name === 'apply_patch_memory'

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

  if (isPatchToolName(call.name)) {
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
    const cmd = call.args?.command ?? ''
    const preview = cmd.length > 200 ? `${cmd.substring(0, 200)}...` : cmd
    return <span className="truncate font-mono" title={cmd}><ExecCommandText command={preview} heredocBodyBlock={false} /></span>
  }

  if (call.name === 'send_to_session') {
    const targetSessionId = String(call.args.sessionId || '')
    const message = typeof call.args.message === 'string' ? call.args.message : formatCompactObjectPreview(call.args.message)
    const preview = message.length > 160 ? `${message.slice(0, 160)}...` : message
    return (
      <span className="flex items-center gap-1 min-w-0" title={`${targetSessionId}: ${message}`}>
        <span className="shrink-0 text-gray-500 dark:text-gray-400">To</span>
        <span className="shrink-0"><SessionHashLink sessionId={targetSessionId} /></span>
        <span className="truncate">: {preview}</span>
      </span>
    )
  }

  const argsFormatted = formatCompactObjectPreview(call.args)
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
          <pre className="whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text"><SyntaxHighlightedText text={call.args.content} filePath={call.args.filePath} /></pre>
        )}
      </div>
    )
  }

  if (isLegacyDiffToolName(call.name)) {
    const hasLegacyDiff = hasLegacyDiffPayload(call)
    return hasLegacyDiff ? (
      <div className="space-y-2">
        <div className="text-xs text-gray-600 dark:text-gray-300">{call.args.filePath}</div>
        <DiffPreview oldText={call.args.oldText} newText={call.args.newText} diffViewMode={diffViewMode} filePath={call.args.filePath} />
      </div>
    ) : (
      <pre className="whitespace-pre-wrap text-xs bg-white dark:bg-gray-900 p-2 rounded border border-gray-300 dark:border-gray-600 cursor-text">{JSON.stringify(call.args, null, 2)}</pre>
    )
  }

  if (isPatchToolName(call.name)) {
    try {
      const operations = parseApplyPatchPreview(call.args.input)
      return (
        <div className="space-y-4">
          {operations.map((operation, operationIdx) => {
            if (operation.action === 'update') {
              return (
                <div key={operationIdx} className="">
                  <div className="text-xs font-semibold text-gray-600 dark:text-gray-300">Update {operation.filePath}</div>
                  <div>
                    {operation.hunks.map((hunk, hunkIdx) => {
                      const snippets = buildPatchHunkSnippets(hunk)
                      return (
                        <div key={hunkIdx}>
                          {hunk.anchors.length > 0 && (
                            <div className="mb-1 text-[11px] text-gray-500 dark:text-gray-400">{hunk.anchors.map((anchor, anchorIdx) => <div key={anchorIdx}>@@ {anchor}</div>)}</div>
                          )}
                          {snippets.oldText || snippets.newText ? (
                            <DiffPreview oldText={snippets.oldText} newText={snippets.newText} diffViewMode={diffViewMode} filePath={operation.filePath} />
                          ) : (
                            <div className="rounded border border-gray-300 bg-gray-50 px-2 py-1 font-mono text-[11px] text-gray-500 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-400">anchor-only hunk</div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            }
            if (operation.action === 'add') {
              return (
                <div key={operationIdx} className="space-y-1">
                  <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Add {operation.filePath}</div>
                  <DiffPreview oldText="" newText={operation.lines.join('\n')} diffViewMode={diffViewMode} filePath={operation.filePath} />
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
    const cmd = call.args?.command ?? ''
    return <div className="whitespace-pre-wrap break-all"><ExecCommandText command={cmd} /></div>
  }

  if (call.name === 'send_to_session') {
    const targetSessionId = String(call.args.sessionId || '')
    const message = typeof call.args.message === 'string' ? call.args.message : formatCompactObjectPreview(call.args.message)
    return (
      <div className="space-y-1">
        <div className="whitespace-pre-wrap break-all"><span className="mr-1 text-gray-500 dark:text-gray-400">To</span><SessionHashLink sessionId={targetSessionId} /><span>:</span></div>
        <div className="whitespace-pre-wrap break-all">{message}</div>
      </div>
    )
  }

  return <div className="whitespace-pre-wrap break-all">{formatCompactObjectPreview(call.args)}</div>
}

const renderToolResponseContent = (resp: FunctionResponse, expanded: boolean, call?: FunctionCall): ReactNode | null => {
  if (resp.name === 'read') {
    const fileContent = resp.response.content || resp.response.output || JSON.stringify(resp.response)
    return expanded
      ? <pre className="whitespace-pre-wrap text-xs overflow-x-auto cursor-text"><SyntaxHighlightedText text={fileContent} filePath={call?.args?.filePath} /></pre>
      : <div className="whitespace-pre-wrap break-all cursor-text">{fileContent ? <SyntaxHighlightedText text={truncatePreviewText(fileContent, 400)} filePath={call?.args?.filePath} /> : 'Completed'}</div>
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
    return <div className="whitespace-pre-wrap break-all cursor-text" style={{ lineHeight: '1.3em' }}><ExecOutputText text={displayStr} command={call?.args?.command} /></div>
  }

  const download = getSendFileDownload(call, resp)
  const primaryText = formatToolResponseText(resp)
  if (download) {
    const preview = truncatePreviewText(primaryText, 400)
    return (
      <div className="space-y-2">
        <ToolDownloadButton url={download.url} fileName={download.fileName} />
        {primaryText ? <div className="whitespace-pre-wrap break-all cursor-text">{expanded ? primaryText : preview}</div> : null}
      </div>
    )
  }

  if (primaryText) {
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

const DiffPreview = memo(function DiffPreview({ oldText, newText, diffViewMode, filePath }: { oldText: string; newText: string; diffViewMode: 'unified' | 'split'; filePath?: string }) {
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
              ? <span key={j} className="bg-orange-200/60 dark:bg-orange-700/60 text-orange-900 dark:text-orange-200"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span>
              : !part.added ? <span key={j} className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span> : null)}
          </div>
        )
        elements.push(
          <div key={i + 1} className="bg-blue-100 dark:bg-blue-900/40 pl-2">
            {charDiff.map((part, j) => part.added
              ? <span key={j} className="bg-blue-200/60 dark:bg-blue-700/60 text-blue-900 dark:text-blue-200"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span>
              : !part.removed ? <span key={j} className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span> : null)}
          </div>
        )
        i += 2
      } else if (change.removed) {
        elements.push(<div key={i} className="bg-orange-100 dark:bg-orange-900/40 pl-2"><span className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={change.value} filePath={filePath} /></span></div>)
        i++
      } else if (change.added) {
        elements.push(<div key={i} className="bg-blue-100 dark:bg-blue-900/40 pl-2"><span className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={change.value} filePath={filePath} /></span></div>)
        i++
      } else {
        elements.push(<div key={i} className="pl-2"><span className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={change.value} filePath={filePath} /></span></div>)
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
                ? <span key={j} className="bg-orange-200/60 dark:bg-orange-700/60 text-orange-900 dark:text-orange-200"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span>
                : !part.added ? <span key={j} className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span> : null)}
            </div>
          )
          newElements.push(
            <div key={`${i}-new-${lineIdx}`} className="bg-blue-100 dark:bg-blue-900/40 block">
              {charDiff.map((part, j) => part.added
                ? <span key={j} className="bg-blue-200/60 dark:bg-blue-700/60 text-blue-900 dark:text-blue-200"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span>
                : !part.removed ? <span key={j} className="text-gray-900 dark:text-gray-100"><SyntaxHighlightedText text={part.value} filePath={filePath} /></span> : null)}
            </div>
          )
        } else if (removedLine !== undefined) {
          oldElements.push(<div key={`${i}-old-${lineIdx}`} className="bg-orange-100 dark:bg-orange-900/40 text-gray-900 dark:text-gray-100 block"><SyntaxHighlightedText text={removedLine || '\u00A0'} filePath={filePath} /></div>)
          newElements.push(<div key={`${i}-new-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>)
        } else if (addedLine !== undefined) {
          oldElements.push(<div key={`${i}-old-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>)
          newElements.push(<div key={`${i}-new-${lineIdx}`} className="bg-blue-100 dark:bg-blue-900/40 text-gray-900 dark:text-gray-100 block"><SyntaxHighlightedText text={addedLine || '\u00A0'} filePath={filePath} /></div>)
        }
      }

      i += 2
    } else if (change.removed) {
      const actualLines = change.value.endsWith('\n') ? change.value.split('\n').slice(0, -1) : change.value.split('\n')
      actualLines.forEach((line, lineIdx) => {
        oldElements.push(<div key={`${i}-${lineIdx}`} className="bg-orange-100 dark:bg-orange-900/40 text-gray-900 dark:text-gray-100 block"><SyntaxHighlightedText text={line || '\u00A0'} filePath={filePath} /></div>)
        newElements.push(<div key={`${i}-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>)
      })
      i++
    } else if (change.added) {
      const actualLines = change.value.endsWith('\n') ? change.value.split('\n').slice(0, -1) : change.value.split('\n')
      actualLines.forEach((line, lineIdx) => {
        oldElements.push(<div key={`${i}-pad-${lineIdx}`} className="bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 select-none block">&nbsp;</div>)
        newElements.push(<div key={`${i}-${lineIdx}`} className="bg-blue-100 dark:bg-blue-900/40 text-gray-900 dark:text-gray-100 block"><SyntaxHighlightedText text={line || '\u00A0'} filePath={filePath} /></div>)
      })
      i++
    } else {
      oldElements.push(<div key={i} className="text-gray-900 dark:text-gray-100 block"><SyntaxHighlightedText text={change.value} filePath={filePath} /></div>)
      newElements.push(<div key={i} className="text-gray-900 dark:text-gray-100 block"><SyntaxHighlightedText text={change.value} filePath={filePath} /></div>)
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

const ToolCallResponseItem = memo(function ToolCallResponseItem({
  call,
  responses,
  imageParts,
  modelMessage,
}: {
  call?: FunctionCall
  responses: FunctionResponse[]
  imageParts: MessagePart[]
  modelMessage?: Message
}) {
  const [expanded, setExpanded] = useState(false)
  const [viewMode, setViewMode] = useState<ToolViewMode>('default')
  const [diffViewMode, setDiffViewMode] = useState<'unified' | 'split'>(() => {
    return (localStorage.getItem('diffViewMode') as 'unified' | 'split') || 'unified'
  })

  const setToolViewMode = useCallback((mode: ToolViewMode) => {
    if (mode === 'json') {
      setExpanded(true)
    }
    setViewMode(mode)
  }, [])

  const setDiffMode = useCallback((mode: 'unified' | 'split') => {
    setDiffViewMode(mode)
    localStorage.setItem('diffViewMode', mode)
  }, [])

  const pairStatus = getToolPairStatus(responses, imageParts)
  const isError = pairStatus === 'error'
  const tagTone = pairStatus === 'error' ? 'error' : pairStatus === 'success' ? 'success' : 'neutral'
  const primaryResponse = responses[0]
  const primaryName = call?.name || primaryResponse?.name || (imageParts.length > 0 ? 'image' : 'tool')
  const primaryLabel = call ? getToolDisplayLabel(call) : primaryName
  const hasResponseContent = responses.length > 0 || imageParts.length > 0
  const showDiffToggles = !!call && (isLegacyDiffToolName(call.name) || isPatchToolName(call.name))

  const responsePreview = useMemo(() => {
    const firstResponse = responses[0]
    if (firstResponse) {
      const previewNode = renderToolResponseContent(firstResponse, false, call)
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
    return null
  }, [call, imageParts.length, responses])

  const jsonText = useMemo(() => JSON.stringify({ modelMessage, call, responses, imageParts }, null, 2), [call, imageParts, modelMessage, responses])
  const baseTextClass = 'font-mono text-gray-700 dark:text-gray-300'
  const hasBody = expanded || !!responsePreview

  const header = (extraClass = '', onClick?: (e: MouseEvent<HTMLDivElement>) => void, includeCallPreview = false) => (
    <div
      className={`flex items-center gap-2 min-w-0 ${toolHeaderToneClasses[tagTone]} ${extraClass}`.trim()}
      onClick={onClick}
    >
      <ToolTag name={primaryName} label={primaryLabel} tone={tagTone} />
      {includeCallPreview && call && <div className="min-w-0 flex-1 truncate">{renderToolCallPreview(call)}</div>}
    </div>
  )

  return (
    <div
      className={`text-xs relative group pl-2 ${toolSurfaceToneClasses[tagTone]} ${hasBody ? 'pb-1' : ''} ${!expanded ? 'cursor-pointer [&_*]:cursor-pointer' : ''}`}
      onClick={!expanded ? () => setExpanded(true) : undefined}
    >
      <ToolThreadLineButton
        expanded={expanded}
        onToggle={() => setExpanded(current => !current)}
        tone={tagTone}
        label={expanded ? `Collapse ${primaryName} tool` : `Expand ${primaryName} tool`}
      />
      <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        {showDiffToggles ? (
          <>
            <MiniToggleButton onClick={(e) => { e.stopPropagation(); setDiffMode('unified') }} active={viewMode !== 'json' && diffViewMode === 'unified'} title="Unified">Unified</MiniToggleButton>
            <MiniToggleButton onClick={(e) => { e.stopPropagation(); setDiffMode('split') }} active={viewMode !== 'json' && diffViewMode === 'split'} title="Split">Split</MiniToggleButton>
            <MiniToggleButton onClick={(e) => { e.stopPropagation(); setToolViewMode('json') }} active={viewMode === 'json'} title="JSON">JSON</MiniToggleButton>
          </>
        ) : (
          <>
            <IconToggleButton onClick={(e) => { e.stopPropagation(); setToolViewMode('default') }} active={viewMode === 'default'} title="Default"><Eye size={12} /></IconToggleButton>
            <IconToggleButton onClick={(e) => { e.stopPropagation(); setToolViewMode('json') }} active={viewMode === 'json'} title="JSON"><FileJson size={14} /></IconToggleButton>
          </>
        )}
      </div>

      {viewMode === 'json' ? (
        <div className={baseTextClass}>
          {header(expanded ? 'cursor-pointer hover:text-gray-900 dark:hover:text-gray-100' : '', expanded ? (e) => { e.stopPropagation(); setExpanded(false) } : undefined)}
          <pre className="mt-2 whitespace-pre-wrap break-all cursor-text" onClick={(e) => e.stopPropagation()} style={expanded ? undefined : clampContentStyle(6)}>{jsonText}</pre>
        </div>
      ) : !expanded ? (
        <div className={baseTextClass}>
          <div className="space-y-1">
            {header('', undefined, true)}
            {responsePreview && <div className="pr-2 text-gray-700 dark:text-gray-300" style={clampContentStyle(3)}>{responsePreview}</div>}
          </div>
        </div>
      ) : (
        <div className={baseTextClass}>
          {header('cursor-pointer hover:text-gray-900 dark:hover:text-gray-100', (e) => { e.stopPropagation(); setExpanded(false) })}

          <div className="mt-1 cursor-default pr-2" onClick={(e) => e.stopPropagation()}>
            {call && (
              <div className={`text-gray-700 dark:text-gray-300 ${showDiffToggles ? 'relative' : ''}`}>
                {showDiffToggles && (
                  <div className="absolute top-1 right-0 flex gap-1" onClick={(e) => e.stopPropagation()}>
                    <MiniToggleButton onClick={(e) => { e.stopPropagation(); setDiffMode('unified') }} active={diffViewMode === 'unified'} title="Unified">Unified</MiniToggleButton>
                    <MiniToggleButton onClick={(e) => { e.stopPropagation(); setDiffMode('split') }} active={diffViewMode === 'split'} title="Split">Split</MiniToggleButton>
                  </div>
                )}
                {renderToolCallExpandedContent(call, diffViewMode)}
              </div>
            )}

            {call && hasResponseContent && (
              <div className={`my-2 border-t ${isError ? 'border-red-200 dark:border-red-800' : 'border-green-200 dark:border-green-800'} opacity-70`} />
            )}

            {hasResponseContent && (
              <div className="text-gray-700 dark:text-gray-300">
                {responses.length > 0 && responses.map((resp, idx) => (
                  <div key={`${resp.tool_use_id || call?.id || call?.name || resp.name}-${idx}`} className={idx > 0 ? `pt-2 border-t ${isError ? 'border-red-100 dark:border-red-900/40' : 'border-green-100 dark:border-green-900/40'}` : ''}>
                    {renderToolResponseContent(resp, true, call)}
                  </div>
                ))}

                {imageParts.length > 0 && (
                  <div className={responses.length > 0 ? `pt-2 border-t ${isError ? 'border-red-100 dark:border-red-900/40' : 'border-green-100 dark:border-green-900/40'}` : ''}>
                    <ImageParts imageParts={imageParts} keyPrefix={`tool-pair-${call?.id || primaryName}`} />
                  </div>
                )}
              </div>
            )}
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
        responseEntries.forEach(({ respIdx }) => renderedResponseIndexes.add(respIdx))

        return (
          <div key={`${messageKeyPrefix}-group-${toolId || callIdx}`}>
            <ToolCallResponseItem
              call={call}
              responses={responseEntries.map(({ resp }) => resp)}
              imageParts={imageParts}
              modelMessage={msg}
            />
          </div>
        )
      })}
      {unmatchedResponses.filter(({ respIdx }) => !renderedResponseIndexes.has(respIdx)).map(({ resp }, orphanIdx) => (
        <ToolCallResponseItem
          key={`${messageKeyPrefix}-orphan-resp-${orphanIdx}`}
          responses={[resp]}
          imageParts={[]}
        />
      ))}
      {Array.from(imageEntriesById.entries()).filter(([toolId]) => !functionCalls.some(call => call.id === toolId)).map(([toolId, imageParts]) => (
        <ToolCallResponseItem key={`${messageKeyPrefix}-orphan-matched-tool-image-${toolId}`} responses={[]} imageParts={imageParts} />
      ))}
      {unmatchedImageParts.length > 0 && (
        <ToolCallResponseItem responses={[]} imageParts={unmatchedImageParts} />
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
        <ToolCallResponseItem key={`call-${call.id || callIdx}`} call={call} responses={[]} imageParts={[]} modelMessage={msg} />
      ))}
    </div>
  )
})

const ToolResponsesBlock = memo(function ToolResponsesBlock({ msg }: { msg: Message; hasPrecedingCallMsg: boolean }) {
  const functionResponses = useMemo(() => msg.parts.filter(p => p.functionResponse).map(p => p.functionResponse!), [msg.parts])
  if (functionResponses.length === 0) return null

  return (
    <div>
      {functionResponses.map((resp, respIdx) => (
        <ToolCallResponseItem
          key={`resp-${resp.tool_use_id || respIdx}`}
          responses={[resp]}
          imageParts={[]}
        />
      ))}
    </div>
  )
})

interface MessageRowProps {
  messageKey: string
  msg: Message
  prevMsg: Message | null
  nextMsg: Message | null
  isMobile: boolean
  groupTools: boolean
  showUsageBadge: boolean
  groupKey: string
  summaryTagItemsKey: string
  groupUsage: NormalizedTokenUsage | null
  groupUsageCallCount: number
  keepToolGroupExpanded: boolean
  showToolGroupSummary: boolean
  groupExpanded: boolean
  onExpandGroup: (groupKey: string) => void
}

const MessageRow = memo(function MessageRow({
  messageKey,
  msg,
  prevMsg,
  nextMsg,
  isMobile,
  groupTools,
  showUsageBadge,
  groupKey,
  summaryTagItemsKey,
  groupUsage,
  groupUsageCallCount,
  keepToolGroupExpanded,
  showToolGroupSummary,
  groupExpanded,
  onExpandGroup,
}: MessageRowProps) {
  const textLikeParts = useMemo(() => msg.parts.filter(p => p.text || p.system || p.thinking), [msg.parts])
  const imageParts = useMemo(() => msg.parts.filter(p => p.inlineData), [msg.parts])
  const usage = useMemo(() => getModelMessageUsage(msg), [msg])
  const summaryTagItems = useMemo<ToolTagItem[]>(() => {
    if (!summaryTagItemsKey) return []
    try {
      return JSON.parse(summaryTagItemsKey) as ToolTagItem[]
    } catch {
      return []
    }
  }, [summaryTagItemsKey])
  const isInToolGroup = summaryTagItems.length > 0
  const hasToolParts = useMemo(() => msg.parts.some(p => p.functionCall || p.functionResponse || p.thinking), [msg.parts])
  const hasVisibleTextContent = useMemo(() => msg.parts.some(p => (p.text && p.text.trim()) || (p.system && String(p.system).trim())), [msg.parts])
  const systemLikeMessage = useMemo(() => {
    if (msg.role === 'model') return false
    return (
      msg.parts.some(part => !!part.system && !isLightweightStructuredSystem(part.system)) ||
      msg.parts.some(part => !!part.text && part.text.split('\n').some(isHeavySystemTextLine))
    )
  }, [msg])
  const shouldSkipMargin = !systemLikeMessage && (msg.role === 'model' || msg.role === 'tool') && (prevMsg?.role === 'model' || prevMsg?.role === 'tool')
  const isCollapsedToolGroup = groupTools && isInToolGroup && !groupExpanded && !keepToolGroupExpanded
  const hasInterleavedToolGroup = !!(nextMsg && nextMsg.role === 'tool' && nextMsg.parts.some(p => p.functionResponse) && msg.parts.some(p => p.functionCall))
  const hasPrecedingCallMsg = !!(prevMsg?.role === 'model' && prevMsg.parts.some(p => p.functionCall))
  const displayUsage = showUsageBadge
    ? (isCollapsedToolGroup ? (showToolGroupSummary ? groupUsage : null) : usage)
    : null
  const displayUsageCallCount = isCollapsedToolGroup && showToolGroupSummary && groupUsageCallCount > 0 ? groupUsageCallCount : undefined
  const allowOverflow = (displayUsage && !isMobile) || hasToolParts || isInToolGroup

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
        } ${allowOverflow ? 'overflow-visible' : 'overflow-x-hidden'}`}
      >
        {systemLikeMessage ? (
          <SystemLikeMessageCard msg={msg} messageKey={messageKey} />
        ) : msg.role === 'user' ? (
          <div className="flex flex-col">
            {textLikeParts.map((part, partIdx) => (
              <div key={`user-part-${partIdx}`}>
                {part.system
                  ? <InlineMetaPart systemText={formatStructuredSystemText(part.system)} isUser={true} />
                  : <CollapsibleUserText text={part.text || ''} />}
              </div>
            ))}
            <ImageParts imageParts={imageParts} keyPrefix={`user-${messageKey}`} />
          </div>
        ) : (
          <div className={`flex flex-col ${displayUsage && !isMobile ? 'relative' : ''}`}>
            {textLikeParts.map((part, partIdx) => {
              if (part.system) {
                return <InlineMetaPart key={`model-system-${partIdx}`} systemText={formatStructuredSystemText(part.system)} isUser={false} />
              }
              if (part.thinking) {
                if (groupTools && !hasVisibleTextContent && isInToolGroup && !groupExpanded) {
                  return null
                }
                return <ReasoningCard key={`thinking-${partIdx}`} thinking={part.thinking} tone="message" />
              }
              return <AssistantTextCard key={`assistant-text-${partIdx}`} text={part.text || ''} message={msg} />
            })}
            <ImageParts imageParts={imageParts} keyPrefix={`message-${messageKey}`} />
            {groupTools && showToolGroupSummary && !groupExpanded && !keepToolGroupExpanded && (
              <div
                className={`group relative pl-2 text-xs cursor-pointer text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 [&_*]:cursor-pointer ${toolSurfaceToneClasses.neutral}`}
                onClick={() => onExpandGroup(groupKey)}
              >
                <ToolThreadLineButton
                  expanded={false}
                  onToggle={() => onExpandGroup(groupKey)}
                  tone="neutral"
                  label="Expand tool group"
                />
                <div className={`flex items-start gap-2 ${toolHeaderToneClasses.neutral}`}>
                  <ToolTagList items={summaryTagItems} />
                </div>
              </div>
            )}
            {isCollapsedToolGroup ? null : (hasInterleavedToolGroup && nextMsg ? <InterleavedToolGroup msg={msg} nextMsg={nextMsg} messageKeyPrefix={messageKey} /> : <ToolCallsBlock msg={msg} />)}
            {isCollapsedToolGroup ? null : (hasInterleavedToolGroup ? null : <ToolResponsesBlock msg={msg} hasPrecedingCallMsg={hasPrecedingCallMsg} />)}
            {displayUsage && <ModelUsageAnchor usage={displayUsage} isMobile={isMobile} callCount={displayUsageCallCount} />}
          </div>
        )}
      </div>
    </div>
  )
}, (prev, next) => (
  prev.msg === next.msg &&
  prev.messageKey === next.messageKey &&
  prev.prevMsg === next.prevMsg &&
  prev.nextMsg === next.nextMsg &&
  prev.isMobile === next.isMobile &&
  prev.groupTools === next.groupTools &&
  prev.showUsageBadge === next.showUsageBadge &&
  prev.groupKey === next.groupKey &&
  prev.summaryTagItemsKey === next.summaryTagItemsKey &&
  prev.groupUsage === next.groupUsage &&
  prev.groupUsageCallCount === next.groupUsageCallCount &&
  prev.keepToolGroupExpanded === next.keepToolGroupExpanded &&
  prev.showToolGroupSummary === next.showToolGroupSummary &&
  prev.groupExpanded === next.groupExpanded
))

const ChatTimeline = memo(function ChatTimeline({ messages, isMobile, groupTools, showUsageBadge }: ChatTimelineProps) {
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(new Set())

  const toolGroupMeta = useMemo(() => {
    const messageKeys = messages.map((msg, idx) => getMessageStableKey(msg, idx))
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
              label: formatToolLabel(p.functionCall.name, p.functionCall.args),
              tone: status === 'error' ? 'error' : status === 'success' ? 'success' : 'neutral',
            })
          }
        })
      }
      return items
    }

    const getToolGroupUsage = (startIdx: number): { usage: NormalizedTokenUsage | null; callCount: number } => {
      const total: NormalizedTokenUsage = { cachedTokens: 0, inputTokens: 0, outputTokens: 0 }
      let callCount = 0

      for (let i = startIdx; i < messages.length; i++) {
        if (shouldStopAtIdx(startIdx, i)) break
        const m = messages[i]
        if (m.role !== 'model' && m.role !== 'tool') break
        if (m.role === 'model' && hasTextContent(m) && i !== startIdx) break

        if (m.role === 'model') {
          const usage = getModelMessageUsage(m)
          if (usage) {
            total.cachedTokens += usage.cachedTokens
            total.inputTokens += usage.inputTokens
            total.outputTokens += usage.outputTokens
            callCount++
          }
        }
      }

      return { usage: callCount > 0 ? total : null, callCount }
    }

    const startIdxByIndex = messages.map((_, idx) => getToolGroupStartIdx(idx))
    const summaryTagItemsByStart = new Map<number, ToolTagItem[]>()
    const summaryTagItemsKeyByStart = new Map<number, string>()
    const groupUsageByStart = new Map<number, NormalizedTokenUsage | null>()
    const groupUsageCallCountByStart = new Map<number, number>()
    const keepExpandedByStart = new Map<number, boolean>()
    startIdxByIndex.forEach((startIdx) => {
      if (!summaryTagItemsKeyByStart.has(startIdx)) {
        const items = getToolGroupSummaryItems(startIdx)
        const groupUsage = getToolGroupUsage(startIdx)
        summaryTagItemsByStart.set(startIdx, items)
        summaryTagItemsKeyByStart.set(startIdx, JSON.stringify(items))
        groupUsageByStart.set(startIdx, groupUsage.usage)
        groupUsageCallCountByStart.set(startIdx, groupUsage.callCount)
        keepExpandedByStart.set(startIdx, startIdx === finalStandaloneStartIdx)
      }
    })

    return {
      handledByPreviousGroup: messages.map((msg, idx) => {
        if (msg.role !== 'tool' || idx === 0) return false
        const prevMsg = messages[idx - 1]
        return prevMsg?.role === 'model' && prevMsg.parts.some(p => p.functionCall)
      }),
      messageKeyByIndex: messageKeys,
      groupKeyByIndex: startIdxByIndex.map((startIdx) => `${messageKeys[startIdx] || `idx-${startIdx}`}-toolgroup`),
      summaryTagItemsKeyByIndex: startIdxByIndex.map((startIdx) => summaryTagItemsKeyByStart.get(startIdx) || ''),
      groupUsageByIndex: startIdxByIndex.map((startIdx) => groupUsageByStart.get(startIdx) || null),
      groupUsageCallCountByIndex: startIdxByIndex.map((startIdx) => groupUsageCallCountByStart.get(startIdx) || 0),
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
        const messageKey = toolGroupMeta.messageKeyByIndex[idx]
        return (
          <MessageRow
            key={messageKey}
            messageKey={messageKey}
            msg={msg}
            prevMsg={idx > 0 ? messages[idx - 1] : null}
            nextMsg={idx < messages.length - 1 ? messages[idx + 1] : null}
            isMobile={isMobile}
            groupTools={groupTools}
            showUsageBadge={showUsageBadge}
            groupKey={groupKey}
            summaryTagItemsKey={toolGroupMeta.summaryTagItemsKeyByIndex[idx]}
            groupUsage={toolGroupMeta.groupUsageByIndex[idx]}
            groupUsageCallCount={toolGroupMeta.groupUsageCallCountByIndex[idx]}
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
