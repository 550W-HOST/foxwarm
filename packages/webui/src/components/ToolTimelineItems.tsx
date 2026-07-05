import { memo, useCallback, useContext, useMemo, useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'
import { Eye, FileJson, Download } from 'lucide-react'
import {
  IconToggleButton,
  MiniToggleButton,
  ToolTag,
  ToolTagList,
  SessionHashLink,
  buildPatchHunkSnippets,
  clampContentStyle,
  formatToolLabel,
  formatCompactObjectPreview,
  renderSystemTextWithSessionLinks,
  parseApplyPatchPreview,
  type FunctionCall,
  type FunctionResponse,
  type Message,
  type MessagePart,
  type ToolScriptSubCall,
  type ToolTagItem,
  type ToolViewMode,
} from './chatShared'
import { ToolScriptProgressContext } from './ToolScriptProgressContext'
import { shouldUseStreamingToolPlaceholder } from '../../../shared/src/webuiToolRendering'
import ImageParts from './ImageParts'
import { SyntaxHighlightedText } from './SyntaxHighlightedText'
import { buildPathDownloadUrl, triggerBrowserDownload } from './downloadShared'
import DiffPreview from './DiffPreview'
import { ExecCommandText, ExecOutputText } from './ToolExecText'
import ThreadLineButton from './ThreadLineButton'

const formatToolResponseText = (resp: { response: unknown }): string => formatCompactObjectPreview(resp.response)

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
    url: buildPathDownloadUrl(resolvedPath),
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

export const ToolGroupSummaryCard = memo(function ToolGroupSummaryCard({ items, onExpand }: { items: ToolTagItem[]; onExpand: () => void }) {
  return (
    <div
      className={`group relative pl-2 text-xs cursor-pointer text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 [&_*]:cursor-pointer ${toolSurfaceToneClasses.neutral}`}
      onClick={onExpand}
    >
      <ThreadLineButton
        expanded={false}
        onToggle={onExpand}
        label="Expand tool group"
        className={toolThreadLineToneClasses.neutral}
      />
      <div className={`flex items-start gap-2 ${toolHeaderToneClasses.neutral}`}>
        <ToolTagList items={items} />
      </div>
    </div>
  )
})


const getToolDisplayLabel = (call: FunctionCall): string => formatToolLabel(call.name, call.args)

export const getToolResponseStatus = (resp: FunctionResponse): 'success' | 'error' => {
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
const isPatchToolName = (name: string): boolean => name === 'apply_patch' || name === 'apply_patch_memory'
const isInterSessionToolName = (name: string): boolean => name === 'send_to_session' || name === 'create_child_session'
const isSpecialSessionAlias = (sessionId: string): boolean => sessionId === '<main>' || sessionId === '<parent>'

const hasLegacyDiffPayload = (call: FunctionCall): boolean => (
  typeof call.args.oldText === 'string' && typeof call.args.newText === 'string'
)

const renderToolCallPreview = (call: FunctionCall, options: { partial?: boolean } = {}): ReactNode => {
  if (options.partial) {
    return <span className="text-gray-500 dark:text-gray-400">streaming tool call…</span>
  }

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
        <span className="shrink-0">{isSpecialSessionAlias(targetSessionId) ? <span className="font-mono">{targetSessionId}</span> : <SessionHashLink sessionId={targetSessionId} />}</span>
        <span className="truncate">: {preview}</span>
      </span>
    )
  }

  if (call.name === 'session') {
    const action = typeof call.args?.action === 'string' && call.args.action.trim() ? call.args.action.trim() : 'status'
    const suffix = action === 'list'
      ? ` start=${call.args?.start ?? 0} count=${call.args?.count ?? 20}`
      : ''
    return <span className="truncate font-mono">session {action}{suffix}</span>
  }

  if (call.name === 'create_child_session') {
    const suffix = typeof call.args.suffix === 'string' && call.args.suffix.trim() ? call.args.suffix.trim() : '[auto]'
    const mode = call.args.fork ? 'fork' : 'new'
    const hasInitialMessage = typeof call.args.message === 'string' && call.args.message.trim().length > 0
    return (
      <span className="flex items-center gap-1 min-w-0" title={`create ${mode} child session ${suffix}${hasInitialMessage ? ' with initial message' : ''}`}>
        <span className="shrink-0 text-gray-500 dark:text-gray-400">child</span>
        <span className="truncate font-mono">{suffix}</span>
        <span className="shrink-0 text-gray-500 dark:text-gray-400">({mode}{hasInitialMessage ? ', message' : ''})</span>
      </span>
    )
  }

  const argsFormatted = formatCompactObjectPreview(call.args)
  const preview = argsFormatted.length > 200 ? `${argsFormatted.substring(0, 200)}...` : argsFormatted
  return <span className="truncate break-all">{preview}</span>
}

const renderToolCallExpandedContent = (call: FunctionCall, diffViewMode: 'unified' | 'split', options: { partial?: boolean } = {}) => {
  if (options.partial) {
    return <div className="text-gray-500 dark:text-gray-400">Streaming tool call. Full arguments will appear after the model finishes emitting the call.</div>
  }

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
        {typeof call.args.content === 'string' && (
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
        <div className="whitespace-pre-wrap break-all"><span className="mr-1 text-gray-500 dark:text-gray-400">To</span>{isSpecialSessionAlias(targetSessionId) ? <span className="font-mono">{targetSessionId}</span> : <SessionHashLink sessionId={targetSessionId} />}<span>:</span></div>
        <div className="whitespace-pre-wrap break-all">{message}</div>
      </div>
    )
  }

  if (call.name === 'session') {
    return <div className="whitespace-pre-wrap break-all">{formatCompactObjectPreview(call.args || { action: 'status' })}</div>
  }

  if (call.name === 'create_child_session') {
    const suffix = typeof call.args.suffix === 'string' && call.args.suffix.trim() ? call.args.suffix.trim() : '[auto]'
    const mode = call.args.fork ? 'forked from parent' : 'new session'
    const initialMessage = typeof call.args.message === 'string' ? call.args.message : ''
    return (
      <div className="space-y-1">
        <div className="whitespace-pre-wrap break-all"><span className="mr-1 text-gray-500 dark:text-gray-400">Child suffix</span><span className="font-mono">{suffix}</span><span className="ml-1 text-gray-500 dark:text-gray-400">({mode})</span></div>
        {initialMessage && <div className="whitespace-pre-wrap break-all"><span className="mr-1 text-gray-500 dark:text-gray-400">Initial message:</span>{initialMessage}</div>}
      </div>
    )
  }

  return <div className="whitespace-pre-wrap break-all">{formatCompactObjectPreview(call.args)}</div>
}

const renderToolResponseContent = (resp: FunctionResponse, expanded: boolean, call?: FunctionCall): ReactNode | null => {
  if (resp.name === 'read') {
    const rawContent = resp.response?.content ?? resp.response?.output
    const fileContent = typeof rawContent === 'string'
      ? rawContent
      : rawContent !== undefined
        ? formatCompactObjectPreview(rawContent)
        : formatToolResponseText(resp)
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
    if (typeof resp.response?.output === 'string') {
      const output = resp.response.output
      const preview = truncatePreviewText(output, 400)
      const displayStr = expanded ? output : preview
      return <div className="whitespace-pre-wrap break-all cursor-text" style={{ lineHeight: '1.3em' }}><ExecOutputText text={displayStr} command={call?.args?.command} /></div>
    }
    const raw = formatToolResponseText(resp)
    const preview = truncatePreviewText(raw, 400)
    return <div className="whitespace-pre-wrap break-all cursor-text">{expanded ? raw : preview}</div>
  }

  const download = getSendFileDownload(call, resp)
  const primaryText = formatToolResponseText(resp)
  if (primaryText && isInterSessionToolName(resp.name)) {
    const preview = truncatePreviewText(primaryText, 400)
    return <div className="whitespace-pre-wrap break-all cursor-text">{renderSystemTextWithSessionLinks(expanded ? primaryText : preview)}</div>
  }

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

const TOOLSCRIPT_TOOL_NAMES = new Set(['run_script', 'start_toolscript_run', 'continue_script'])

const ToolScriptSubCallsTags = memo(function ToolScriptSubCallsTags({ subCalls }: { subCalls: ToolScriptSubCall[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 py-0.5">
      {subCalls.map((sc) => (
        <span key={sc.id} className="inline-flex items-center gap-0.5">
          {sc.status === 'running' && (
            <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
          )}
          <ToolTag
            name={sc.name}
            label={sc.name}
            tone={sc.status === 'failed' ? 'error' : sc.status === 'completed' ? 'success' : 'neutral'}
          />
        </span>
      ))}
    </div>
  )
})

const ToolScriptSubCallsList = memo(function ToolScriptSubCallsList({ subCalls }: { subCalls: ToolScriptSubCall[] }) {
  return (
    <div className="ml-3 border-l-2 border-blue-200 dark:border-blue-800 pl-2 space-y-0.5 py-1">
      {subCalls.map((sc) => (
        <div key={sc.id} className="flex items-center gap-2 text-xs">
          {sc.status === 'running' && (
            <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
          )}
          <ToolTag
            name={sc.name}
            label={sc.name}
            tone={sc.status === 'failed' ? 'error' : sc.status === 'completed' ? 'success' : 'neutral'}
          />
          {sc.argsSummary && (
            <span className="text-gray-500 dark:text-gray-400 truncate max-w-[200px]">{sc.argsSummary}</span>
          )}
          {sc.durationMs !== undefined && (
            <span className="text-gray-400 dark:text-gray-500 shrink-0">{sc.durationMs}ms</span>
          )}
          {sc.error && (
            <span className="text-red-500 dark:text-red-400 truncate max-w-[150px]">{sc.error}</span>
          )}
        </div>
      ))}
    </div>
  )
})

const stripToolScriptSubCallsFromResponse = (response: unknown): unknown => {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return response
  }
  const { subCalls: _subCalls, ...rest } = response as Record<string, unknown>
  return rest
}

const renderToolScriptResultContent = (resp: FunctionResponse, expanded: boolean): ReactNode | null => {
  const strippedResponse = stripToolScriptSubCallsFromResponse(resp.response)
  const primaryText = formatCompactObjectPreview(strippedResponse)
  if (!primaryText) {
    return null
  }
  const displayText = expanded ? primaryText : truncatePreviewText(primaryText, 400)
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">ToolScript result</div>
      <div className="whitespace-pre-wrap break-all cursor-text">{displayText}</div>
    </div>
  )
}

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

  // ToolScript progress: show sub-calls when tool is still running (no response yet)
  // or from response result when completed
  const progressMap = useContext(ToolScriptProgressContext)
  const isToolScriptTool = !!call && TOOLSCRIPT_TOOL_NAMES.has(call.name)
  const responseSubCalls = isToolScriptTool && responses.length > 0
    ? (responses[0]?.response as any)?.subCalls as ToolScriptSubCall[] | undefined
    : undefined
  const progressSubCalls = isToolScriptTool && call?.id ? progressMap[call.id] : undefined
  const toolScriptSubCalls = responseSubCalls || progressSubCalls
  const hasToolScriptProgress = !!toolScriptSubCalls && toolScriptSubCalls.length > 0

  const pairStatus = getToolPairStatus(responses, imageParts)
  const isError = pairStatus === 'error'
  const tagTone = pairStatus === 'error' ? 'error' : pairStatus === 'success' ? 'success' : 'neutral'
  const partialToolCall = shouldUseStreamingToolPlaceholder({
    modelMessageMeta: modelMessage?.__meta,
    hasCall: !!call,
    responseCount: responses.length,
    imagePartCount: imageParts.length,
  })
  const primaryResponse = responses[0]
  const primaryName = call?.name || primaryResponse?.name || (imageParts.length > 0 ? 'image' : 'tool')
  const primaryLabel = call ? getToolDisplayLabel(call) : primaryName
  const hasResponseContent = responses.length > 0 || imageParts.length > 0
  const showDiffToggles = !!call && !partialToolCall && (isLegacyDiffToolName(call.name) || isPatchToolName(call.name))

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
  const hasBody = expanded || !!responsePreview || hasToolScriptProgress

  const header = (extraClass = '', onClick?: (e: MouseEvent<HTMLDivElement>) => void, includeCallPreview = false) => (
    <div
      className={`flex items-center gap-2 min-w-0 ${toolHeaderToneClasses[tagTone]} ${extraClass}`.trim()}
      onClick={onClick}
    >
      <ToolTag name={primaryName} label={primaryLabel} tone={tagTone} />
      {includeCallPreview && call && <div className="min-w-0 flex-1 truncate">{renderToolCallPreview(call, { partial: partialToolCall })}</div>}
    </div>
  )

  return (
    <div
      className={`text-xs relative group pl-2 ${toolSurfaceToneClasses[tagTone]} ${hasBody ? 'pb-1' : ''} ${!expanded ? 'cursor-pointer [&_*]:cursor-pointer' : ''}`}
      onClick={!expanded ? () => setExpanded(true) : undefined}
    >
      <ThreadLineButton
        expanded={expanded}
        onToggle={() => setExpanded(current => !current)}
        label={expanded ? `Collapse ${primaryName} tool` : `Expand ${primaryName} tool`}
        className={toolThreadLineToneClasses[tagTone]}
      />
      <div className="absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <IconToggleButton onClick={(e) => { e.stopPropagation(); setToolViewMode('default') }} active={viewMode === 'default'} title="Default"><Eye size={12} /></IconToggleButton>
        <IconToggleButton onClick={(e) => { e.stopPropagation(); setToolViewMode('json') }} active={viewMode === 'json'} title="JSON"><FileJson size={14} /></IconToggleButton>
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
            {responsePreview && !hasToolScriptProgress && <div className="pr-2 text-gray-700 dark:text-gray-300" style={clampContentStyle(3)}>{responsePreview}</div>}
            {hasToolScriptProgress && <ToolScriptSubCallsTags subCalls={toolScriptSubCalls!} />}
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
                {renderToolCallExpandedContent(call, diffViewMode, { partial: partialToolCall })}
              </div>
            )}

            {call && hasResponseContent && (
              <div className={`my-2 border-t ${isError ? 'border-red-200 dark:border-red-800' : 'border-green-200 dark:border-green-800'} opacity-70`} />
            )}

            {hasResponseContent && !hasToolScriptProgress && (
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

            {hasToolScriptProgress && <ToolScriptSubCallsList subCalls={toolScriptSubCalls!} />}

            {hasToolScriptProgress && hasResponseContent && (
              <div className="text-gray-700 dark:text-gray-300">
                {responses.length > 0 && responses.map((resp, idx) => {
                  const content = renderToolScriptResultContent(resp, true)
                  return content ? (
                    <div key={`${resp.tool_use_id || call?.id || call?.name || resp.name}-toolscript-result-${idx}`} className={idx > 0 ? `pt-2 border-t ${isError ? 'border-red-100 dark:border-red-900/40' : 'border-green-100 dark:border-green-900/40'}` : ''}>
                      {content}
                    </div>
                  ) : null
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

interface ToolTimelineEntry {
  key: string
  call?: FunctionCall
  responses: FunctionResponse[]
  imageParts: MessagePart[]
  modelMessage?: Message
}

const getGroupedToolEntries = (msg: Message, nextMsg: Message, messageKeyPrefix: string): ToolTimelineEntry[] => {
  const functionCalls = msg.parts.filter(p => p.functionCall).map(p => p.functionCall!)
  const responseEntriesById = new Map<string, FunctionResponse[]>()
  const imageEntriesById = new Map<string, MessagePart[]>()
  const unmatchedResponses: FunctionResponse[] = []
  const unmatchedImageParts: MessagePart[] = []

  nextMsg.parts.filter(p => p.functionResponse).forEach((resp) => {
    const toolId = resp.functionResponse!.tool_use_id
    if (!toolId) {
      unmatchedResponses.push(resp.functionResponse!)
      return
    }
    const entries = responseEntriesById.get(toolId) || []
    entries.push(resp.functionResponse!)
    responseEntriesById.set(toolId, entries)
  })

  nextMsg.parts.filter(p => p.inlineData).forEach(part => {
    if (part.toolUseId) {
      const entries = imageEntriesById.get(part.toolUseId) || []
      entries.push(part)
      imageEntriesById.set(part.toolUseId, entries)
    } else {
      unmatchedImageParts.push(part)
    }
  })

  const callIds = new Set(functionCalls.map(call => call.id).filter((id): id is string => !!id))
  const orphanToolIds = Array.from(new Set([...responseEntriesById.keys(), ...imageEntriesById.keys()])).filter(toolId => !callIds.has(toolId))

  return [
    ...functionCalls.map((call, callIdx) => {
      const toolId = call.id
      return {
        key: `${messageKeyPrefix}-group-${toolId || callIdx}`,
        call,
        responses: toolId ? (responseEntriesById.get(toolId) || []) : [],
        imageParts: toolId ? (imageEntriesById.get(toolId) || []) : [],
        modelMessage: msg,
      }
    }),
    ...orphanToolIds.map((toolId) => ({
      key: `${messageKeyPrefix}-orphan-tool-${toolId}`,
      responses: responseEntriesById.get(toolId) || [],
      imageParts: imageEntriesById.get(toolId) || [],
    })),
    ...unmatchedResponses.map((resp, idx) => ({
      key: `${messageKeyPrefix}-orphan-resp-${idx}`,
      responses: [resp],
      imageParts: [],
    })),
    ...(unmatchedImageParts.length > 0 ? [{
      key: `${messageKeyPrefix}-orphan-image`,
      responses: [],
      imageParts: unmatchedImageParts,
    }] : []),
  ]
}

export const InterleavedToolGroup = memo(function InterleavedToolGroup({ msg, nextMsg, messageKeyPrefix }: { msg: Message; nextMsg: Message; messageKeyPrefix: string }) {
  const entries = useMemo(() => getGroupedToolEntries(msg, nextMsg, messageKeyPrefix), [messageKeyPrefix, msg, nextMsg])

  return (
    <div>
      {entries.map((entry) => (
        <ToolCallResponseItem
          key={entry.key}
          call={entry.call}
          responses={entry.responses}
          imageParts={entry.imageParts}
          modelMessage={entry.modelMessage}
        />
      ))}
    </div>
  )
})

export const ToolCallsBlock = memo(function ToolCallsBlock({ msg }: { msg: Message }) {
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

export const ToolResponsesBlock = memo(function ToolResponsesBlock({ msg }: { msg: Message }) {
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
