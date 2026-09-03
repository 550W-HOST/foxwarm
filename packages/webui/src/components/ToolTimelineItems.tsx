import { memo, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Code2, Eye, FileJson, Download } from 'lucide-react'
import {
  IconToggleButton,
  MiniToggleButton,
  ToolTag,
  ToolTagList,
  THREAD_CARD_HEADER_PREVIEW_CLASS,
  THREAD_CARD_HEADER_ROW_CLASS,
  SessionHashLink,
  buildPatchHunkSnippets,
  clampContentStyle,
  formatToolLabel,
  getToolResponseStatus,
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
import { getLegacyEditLineCounts } from './legacyEditCounts'
import { useThreadCardOverflowFade } from './useThreadCardOverflowFade'

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
      className="inline-flex items-center gap-1 rounded-lg border border-fw-accent-border bg-fw-accent-surface px-2 py-1 text-xs font-medium text-fw-accent hover:bg-fw-accent-surface dark:border-fw-accent-border dark:bg-fw-accent-surface-strong/20 dark:text-fw-accent dark:hover:bg-fw-accent-surface-strong/30"
      title={fileName ? `Download ${fileName}` : 'Download file'}
    >
      <Download size={12} />
      <span>{fileName ? `Download ${fileName}` : 'Download file'}</span>
    </button>
  )
})

type ToolThreadTone = 'neutral' | 'success' | 'error'

const toolThreadLineToneClasses: Record<ToolThreadTone, string> = {
  neutral: 'text-fw-text hover:text-fw-text-muted focus-visible:text-fw-text-muted dark:text-fw-text dark:hover:text-fw-text-muted dark:focus-visible:text-fw-text-muted',
  success: 'text-fw-success hover:text-fw-success focus-visible:text-fw-success dark:text-fw-success dark:hover:text-fw-success dark:focus-visible:text-fw-success',
  error: 'text-fw-danger hover:text-fw-danger focus-visible:text-fw-danger dark:text-fw-danger dark:hover:text-fw-danger dark:focus-visible:text-fw-danger',
}

const toolSurfaceToneClasses: Record<ToolThreadTone, string> = {
  neutral: 'my-0.5 bg-fw-neutral-surface/45 dark:bg-fw-surface/20',
  success: 'my-0.5 bg-fw-success-surface/55 dark:bg-fw-success-surface/10',
  error: 'my-0.5 bg-fw-danger-surface/55 dark:bg-fw-danger-surface-strong/10',
}

const toolHeaderToneClasses: Record<ToolThreadTone, string> = {
  neutral: '-ml-2 bg-fw-neutral-border/80 pl-2 pr-0 py-1 dark:bg-fw-surface-raised/25',
  success: '-ml-2 bg-fw-success-surface/80 pl-2 pr-0 py-1 dark:bg-fw-success-surface/20',
  error: '-ml-2 bg-fw-danger-surface/85 pl-2 pr-0 py-1 dark:bg-fw-danger-surface-strong/20',
}

export const ToolGroupSummaryCard = memo(function ToolGroupSummaryCard({ items, onExpand }: { items: ToolTagItem[]; onExpand: () => void }) {
  return (
    <div
      className={`foxwarm-tool-card foxwarm-tool-tone-neutral group relative pl-2 text-xs cursor-pointer text-fw-text-muted hover:text-fw-text-muted dark:hover:text-fw-text-strong [&_*]:cursor-pointer ${toolSurfaceToneClasses.neutral}`}
      onClick={onExpand}
    >
      <ThreadLineButton
        expanded={false}
        onToggle={onExpand}
        label="Expand tool group"
        className={toolThreadLineToneClasses.neutral}
      />
      <div className={`foxwarm-tool-header flex items-start gap-2 ${toolHeaderToneClasses.neutral}`}>
        <ToolTagList items={items} />
      </div>
    </div>
  )
})


const getToolDisplayLabel = (call: FunctionCall): string => formatToolLabel(call.name, call.args)

export { getToolResponseStatus }

const getToolPairStatus = (responses: FunctionResponse[], imageParts: MessagePart[] = []): 'success' | 'error' | 'neutral' => {
  if (responses.some((resp) => getToolResponseStatus(resp) === 'error')) {
    return 'error'
  }
  if (responses.length > 0 || imageParts.length > 0) {
    return 'success'
  }
  return 'neutral'
}

const COLLAPSED_TOOL_RESULT_PREVIEW_MAX_CHARS = 800

const truncateToolResultPreview = (text: string): string => {
  if (text.length <= COLLAPSED_TOOL_RESULT_PREVIEW_MAX_CHARS) return text
  return `${text.slice(0, COLLAPSED_TOOL_RESULT_PREVIEW_MAX_CHARS)}...`
}

export type OpenCodeFileHandler = (filePath: string, lines?: { startLine?: number; endLine?: number }) => void

const ToolCodePath = memo(function ToolCodePath({ filePath, lines, onOpenCodeFile, prefix, collapsed = false }: {
  filePath: string
  lines?: { startLine?: number; endLine?: number }
  onOpenCodeFile?: OpenCodeFileHandler
  prefix?: string
  collapsed?: boolean
}) {
  const pathFade = useThreadCardOverflowFade<HTMLSpanElement>('right', collapsed)
  const layoutClass = collapsed
    ? 'foxwarm-tool-code-path-collapsed min-w-0 max-w-full truncate whitespace-nowrap'
    : 'min-w-0 max-w-full whitespace-normal break-words'
  const pathClass = collapsed
    ? 'foxwarm-tool-code-path min-w-0 truncate whitespace-nowrap'
    : 'foxwarm-tool-code-path whitespace-normal break-words'
  if (!onOpenCodeFile) return <span ref={pathFade.ref} {...pathFade.overflowFadeProps} className={`${layoutClass} ${pathClass}`}>{prefix}{filePath}</span>
  return (
    <span className={`foxwarm-tool-code-path-wrap ${layoutClass} ${collapsed ? 'inline-flex items-center gap-1' : ''}`}>
      {prefix}
      <button
        type="button"
        className={`foxwarm-tool-code-open inline-flex shrink-0 p-0 ${collapsed ? 'self-center' : 'align-text-top'} leading-none text-current hover:opacity-70 focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-1`}
        title={`Open ${filePath} in Code`}
        aria-label={`Open ${filePath} in Code`}
        onClick={(event) => {
          event.stopPropagation()
          onOpenCodeFile(filePath, lines)
        }}
      >
        <Code2 size={13} aria-hidden="true" />
      </button>
      <span ref={pathFade.ref} {...pathFade.overflowFadeProps} className={pathClass}>{filePath}</span>
    </span>
  )
})


const isLegacyDiffToolName = (name: string): boolean => name === 'edit' || name === 'edit_memory'
const isPatchToolName = (name: string): boolean => name === 'apply_patch' || name === 'apply_patch_memory'
const isInterSessionToolName = (name: string): boolean => name === 'send_to_session' || name === 'create_child_session'
const isSpecialSessionAlias = (sessionId: string): boolean => sessionId === '<main>' || sessionId === '<parent>'

const hasLegacyDiffPayload = (call: FunctionCall): boolean => (
  typeof call.args.oldText === 'string' && typeof call.args.newText === 'string'
)

const renderToolCallPreview = (call: FunctionCall, options: { partial?: boolean; onOpenCodeFile?: OpenCodeFileHandler } = {}): ReactNode => {
  if (options.partial) {
    const argsFormatted = typeof call.args === 'string' ? call.args : formatCompactObjectPreview(call.args)
    const preview = argsFormatted.length > 200 ? `${argsFormatted.slice(0, 200)}...` : argsFormatted
    return <span className="truncate break-all text-fw-text-muted">{preview || 'streaming tool call…'}</span>
  }

  if (call.name === 'read') {
    const extra = (call.args.startLine || call.args.endLine)
      ? ` (lines ${call.args.startLine || 1}-${call.args.endLine || 'end'})`
      : ''
    return <span title={`${call.args.filePath}${extra}`} className="flex min-w-0 max-w-full flex-1 items-center gap-x-1 overflow-hidden whitespace-nowrap leading-[18px]"><ToolCodePath collapsed filePath={call.args.filePath} lines={{ startLine: call.args.startLine, endLine: call.args.endLine }} onOpenCodeFile={options.onOpenCodeFile} />{extra && <span className="foxwarm-tool-read-range shrink-0">{extra}</span>}</span>
  }

  if (call.name === 'write') {
    return <ToolCodePath collapsed filePath={call.args.filePath} onOpenCodeFile={options.onOpenCodeFile} />
  }

  if (isLegacyDiffToolName(call.name)) {
    const hasLegacyDiff = hasLegacyDiffPayload(call)
    const lineCounts = hasLegacyDiff ? getLegacyEditLineCounts(call.args.oldText, call.args.newText) : null
    return (
      <span className="flex items-center gap-2 min-w-0">
        {lineCounts ? (
          (lineCounts.removed > 0 || lineCounts.added > 0) && (
            <span className="shrink-0 text-xs">
              {lineCounts.removed > 0 && <span className="foxwarm-diff-removed-count text-fw-warning">-{lineCounts.removed}</span>}
              {lineCounts.removed > 0 && lineCounts.added > 0 && <span className="foxwarm-diff-count-separator mx-1 text-fw-text-muted">/</span>}
              {lineCounts.added > 0 && <span className="foxwarm-diff-added-count text-fw-accent">+{lineCounts.added}</span>}
            </span>
          )
        ) : (
          <span className="shrink-0 text-xs text-fw-text-muted">legacy payload unavailable</span>
        )}
        {call.name === 'edit' ? <ToolCodePath collapsed filePath={call.args.filePath} onOpenCodeFile={options.onOpenCodeFile} /> : <span className="truncate">{call.args.filePath}</span>}
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
          <span className="shrink-0 text-xs text-fw-text-muted">{operations.length} op{operations.length > 1 ? 's' : ''}{totalHunks > 0 ? ` • ${totalHunks} hunk${totalHunks > 1 ? 's' : ''}` : ''}</span>
          {call.name === 'apply_patch' && operations.length === 1
            ? <ToolCodePath collapsed filePath={operations[0].filePath} onOpenCodeFile={options.onOpenCodeFile} />
            : <span className="truncate">{fileSummary}</span>}
        </span>
      )
    } catch {
      return <span className="text-fw-danger">invalid patch</span>
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
        <span className="foxwarm-tool-session-prefix shrink-0">To</span>
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
        <span className="shrink-0 text-fw-text-muted">child</span>
        <span className="truncate font-mono">{suffix}</span>
        <span className="shrink-0 text-fw-text-muted">({mode}{hasInitialMessage ? ', message' : ''})</span>
      </span>
    )
  }

  const argsFormatted = formatCompactObjectPreview(call.args)
  const preview = argsFormatted.length > 200 ? `${argsFormatted.substring(0, 200)}...` : argsFormatted
  return <span className="truncate break-all">{preview}</span>
}

const renderToolCallExpandedContent = (call: FunctionCall, diffViewMode: 'unified' | 'split', options: { partial?: boolean; onOpenCodeFile?: OpenCodeFileHandler } = {}) => {
  if (options.partial) {
    return <pre className="whitespace-pre-wrap break-all text-xs text-fw-text-muted">{typeof call.args === 'string' ? call.args : JSON.stringify(call.args, null, 2)}</pre>
  }

  if (call.name === 'read') {
    const extra = (call.args.startLine || call.args.endLine)
      ? ` (lines ${call.args.startLine || 1}-${call.args.endLine || 'end'})`
      : ''
    return <div className="flex items-center gap-2 whitespace-pre-wrap break-all"><ToolCodePath filePath={call.args.filePath} lines={{ startLine: call.args.startLine, endLine: call.args.endLine }} onOpenCodeFile={options.onOpenCodeFile} />{extra && <span className="text-fw-text-muted">{extra}</span>}</div>
  }

  if (call.name === 'write') {
    return (
      <div className="space-y-2">
        <div className="whitespace-pre-wrap break-all"><ToolCodePath filePath={call.args.filePath} onOpenCodeFile={options.onOpenCodeFile} /></div>
        {typeof call.args.content === 'string' && (
          <pre className="whitespace-pre-wrap text-xs bg-fw-surface dark:bg-fw-canvas p-2 rounded border border-fw-border-strong dark:border-fw-border-strong cursor-text"><SyntaxHighlightedText text={call.args.content} filePath={call.args.filePath} /></pre>
        )}
      </div>
    )
  }

  if (isLegacyDiffToolName(call.name)) {
    const hasLegacyDiff = hasLegacyDiffPayload(call)
    return hasLegacyDiff ? (
      <div className="space-y-2">
        <div className="text-xs text-fw-text">{call.name === 'edit' ? <ToolCodePath filePath={call.args.filePath} onOpenCodeFile={options.onOpenCodeFile} /> : call.args.filePath}</div>
        <DiffPreview oldText={call.args.oldText} newText={call.args.newText} diffViewMode={diffViewMode} filePath={call.args.filePath} />
      </div>
    ) : (
      <pre className="whitespace-pre-wrap text-xs bg-fw-surface dark:bg-fw-canvas p-2 rounded border border-fw-border-strong dark:border-fw-border-strong cursor-text">{JSON.stringify(call.args, null, 2)}</pre>
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
                  <div className="text-xs font-semibold text-fw-text"><ToolCodePath prefix="Update " filePath={operation.filePath} onOpenCodeFile={call.name === 'apply_patch' ? options.onOpenCodeFile : undefined} /></div>
                  <div>
                    {operation.hunks.map((hunk, hunkIdx) => {
                      const snippets = buildPatchHunkSnippets(hunk)
                      return (
                        <div key={hunkIdx}>
                          {hunk.anchors.length > 0 && (
                            <div className="mb-1 text-[11px] text-fw-text-muted">{hunk.anchors.map((anchor, anchorIdx) => <div key={anchorIdx}>@@ {anchor}</div>)}</div>
                          )}
                          {snippets.oldText || snippets.newText ? (
                            <DiffPreview oldText={snippets.oldText} newText={snippets.newText} diffViewMode={diffViewMode} filePath={operation.filePath} />
                          ) : (
                            <div className="rounded border border-fw-border-strong bg-fw-surface-sunken px-2 py-1 font-mono text-[11px] text-fw-text-muted dark:border-fw-border-strong dark:bg-fw-canvas dark:text-fw-text-muted">anchor-only hunk</div>
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
                  <div className="text-xs font-semibold text-fw-success dark:text-fw-success"><ToolCodePath prefix="Add " filePath={operation.filePath} onOpenCodeFile={call.name === 'apply_patch' ? options.onOpenCodeFile : undefined} /></div>
                  <DiffPreview oldText="" newText={operation.lines.join('\n')} diffViewMode={diffViewMode} filePath={operation.filePath} />
                </div>
              )
            }
            return <div key={operationIdx} className="rounded border border-fw-danger-border dark:border-fw-danger-border bg-fw-danger-surface dark:bg-fw-danger-surface-strong/20 px-3 py-2 text-xs text-fw-danger dark:text-fw-danger">Delete {operation.filePath}</div>
          })}
        </div>
      )
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      return <pre className="whitespace-pre-wrap text-xs bg-fw-surface dark:bg-fw-canvas p-2 rounded border border-fw-border-strong dark:border-fw-border-strong cursor-text">{error}\n\n{call.args.input || JSON.stringify(call.args, null, 2)}</pre>
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
        <div className="whitespace-pre-wrap break-all"><span className="foxwarm-tool-session-prefix mr-1">To</span>{isSpecialSessionAlias(targetSessionId) ? <span className="font-mono">{targetSessionId}</span> : <SessionHashLink sessionId={targetSessionId} />}<span>:</span></div>
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
        <div className="whitespace-pre-wrap break-all"><span className="mr-1 text-fw-text-muted">Child suffix</span><span className="font-mono">{suffix}</span><span className="ml-1 text-fw-text-muted">({mode})</span></div>
        {initialMessage && <div className="whitespace-pre-wrap break-all"><span className="mr-1 text-fw-text-muted">Initial message:</span>{initialMessage}</div>}
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
      : <div className="whitespace-pre-wrap break-all cursor-text">{fileContent ? <SyntaxHighlightedText text={truncateToolResultPreview(fileContent)} filePath={call?.args?.filePath} /> : 'Completed'}</div>
  }

  if (resp.name === 'edit' && getToolResponseStatus(resp) !== 'success') {
    const raw = formatToolResponseText(resp)
    const preview = truncateToolResultPreview(raw)
    return <pre className="whitespace-pre-wrap break-all cursor-text text-fw-danger">{expanded ? raw : preview}</pre>
  }

  if (resp.name === 'exec') {
    if (typeof resp.response?.output === 'string') {
      const output = resp.response.output
      const preview = truncateToolResultPreview(output)
      const displayStr = expanded ? output : preview
      return <div className="whitespace-pre-wrap break-all cursor-text" style={{ lineHeight: '1.3em' }}><ExecOutputText text={displayStr} command={call?.args?.command} /></div>
    }
    const raw = formatToolResponseText(resp)
    const preview = truncateToolResultPreview(raw)
    return <div className="whitespace-pre-wrap break-all cursor-text">{expanded ? raw : preview}</div>
  }

  const download = getSendFileDownload(call, resp)
  const primaryText = formatToolResponseText(resp)
  if (primaryText && isInterSessionToolName(resp.name)) {
    const preview = truncateToolResultPreview(primaryText)
    return <div className="whitespace-pre-wrap break-all cursor-text">{renderSystemTextWithSessionLinks(expanded ? primaryText : preview)}</div>
  }

  if (download) {
    const preview = truncateToolResultPreview(primaryText)
    return (
      <div className="space-y-2">
        <ToolDownloadButton url={download.url} fileName={download.fileName} />
        {primaryText ? <div className="whitespace-pre-wrap break-all cursor-text">{expanded ? primaryText : preview}</div> : null}
      </div>
    )
  }

  if (primaryText) {
    const preview = truncateToolResultPreview(primaryText)
    return <div className="whitespace-pre-wrap break-all cursor-text">{expanded ? primaryText : preview}</div>
  }

  if (getToolResponseStatus(resp) === 'success') {
    return expanded ? <div className="text-fw-text-muted">Completed</div> : <div>Completed</div>
  }

  const respFormatted = formatToolResponseText(resp)
  const preview = truncateToolResultPreview(respFormatted)
  return <div className="whitespace-pre-wrap break-all cursor-text">{expanded ? respFormatted : preview}</div>
}

const TOOLSCRIPT_TOOL_NAMES = new Set(['run_script', 'start_toolscript_run', 'continue_script'])

const ToolScriptSubCallsTags = memo(function ToolScriptSubCallsTags({ subCalls }: { subCalls: ToolScriptSubCall[] }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 py-0.5">
      {subCalls.map((sc) => (
        <span key={sc.id} className="inline-flex items-center gap-0.5">
          {sc.status === 'running' && (
            <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-fw-accent shrink-0" />
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
    <div className="ml-3 border-l-2 border-fw-accent-border dark:border-fw-accent-border pl-2 space-y-0.5 py-1">
      {subCalls.map((sc) => (
        <div key={sc.id} className="flex items-center gap-2 text-xs">
          {sc.status === 'running' && (
            <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-fw-accent shrink-0" />
          )}
          <ToolTag
            name={sc.name}
            label={sc.name}
            tone={sc.status === 'failed' ? 'error' : sc.status === 'completed' ? 'success' : 'neutral'}
          />
          {sc.argsSummary && (
            <span className="text-fw-text-muted truncate max-w-[200px]">{sc.argsSummary}</span>
          )}
          {sc.durationMs !== undefined && (
            <span className="text-fw-text-muted shrink-0">{sc.durationMs}ms</span>
          )}
          {sc.error && (
            <span className="text-fw-danger dark:text-fw-danger truncate max-w-[150px]">{sc.error}</span>
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
  const displayText = expanded ? primaryText : truncateToolResultPreview(primaryText)
  return (
    <div className="space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-fw-text-muted">ToolScript result</div>
      <div className="whitespace-pre-wrap break-all cursor-text">{displayText}</div>
    </div>
  )
}

const ToolCallResponseItem = memo(function ToolCallResponseItem({
  call,
  responses,
  imageParts,
  modelMessage,
  onOpenCodeFile,
}: {
  call?: FunctionCall
  responses: FunctionResponse[]
  imageParts: MessagePart[]
  modelMessage?: Message
  onOpenCodeFile?: OpenCodeFileHandler
}) {
  const [expanded, setExpanded] = useState(false)
  const [viewMode, setViewMode] = useState<ToolViewMode>('default')
  const headerFade = useThreadCardOverflowFade<HTMLDivElement>('right', !expanded && viewMode === 'default' && call?.name !== 'read' && call?.name !== 'write' && call?.name !== 'edit' && call?.name !== 'apply_patch')
  const resultFade = useThreadCardOverflowFade<HTMLDivElement>('bottom', !expanded && viewMode === 'default')
  const jsonFade = useThreadCardOverflowFade<HTMLPreElement>('bottom', !expanded && viewMode === 'json')
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
  const baseTextClass = 'font-mono text-fw-text'
  const hasBody = expanded || !!responsePreview || hasToolScriptProgress

  const actionButtonsToneClass = `foxwarm-tool-action-buttons-${tagTone}`

  const expandedCallContent = call ? (
    <div className={`text-fw-text ${showDiffToggles ? 'relative' : ''}`}>
      {showDiffToggles && (
        <div className={`foxwarm-tool-action-buttons ${actionButtonsToneClass} absolute top-1 right-0 flex gap-1`} onClick={(e) => e.stopPropagation()}>
          <MiniToggleButton onClick={(e) => { e.stopPropagation(); setDiffMode('unified') }} active={diffViewMode === 'unified'} title="Unified">Unified</MiniToggleButton>
          <MiniToggleButton onClick={(e) => { e.stopPropagation(); setDiffMode('split') }} active={diffViewMode === 'split'} title="Split">Split</MiniToggleButton>
        </div>
      )}
      {renderToolCallExpandedContent(call, diffViewMode, { partial: partialToolCall, onOpenCodeFile })}
    </div>
  ) : null

  const header = (includeCallPreview = false, includeExpandedCall = false) => (
    <div className={`foxwarm-tool-header min-w-0 ${toolHeaderToneClasses[tagTone]}`}>
      <div
        className={`foxwarm-tool-header-toggle cursor-pointer ${THREAD_CARD_HEADER_ROW_CLASS}`}
        onClick={(e) => {
          e.stopPropagation()
          setExpanded(current => !current)
        }}
      >
        <ToolTag name={primaryName} label={primaryLabel} tone={tagTone} className="foxwarm-tool-tag" />
        {includeCallPreview && call && <div ref={headerFade.ref} {...headerFade.overflowFadeProps} className={`foxwarm-tool-call-summary min-w-0 max-w-full flex-1 ${call.name === 'read' ? 'flex text-[13px] leading-[18px]' : THREAD_CARD_HEADER_PREVIEW_CLASS}`}>{renderToolCallPreview(call, { partial: partialToolCall, onOpenCodeFile })}</div>}
      </div>
      {includeExpandedCall && expandedCallContent && (
        <div className="foxwarm-tool-call-args min-w-0 max-w-full pt-1 pr-2" onClick={(e) => e.stopPropagation()}>
          {expandedCallContent}
        </div>
      )}
    </div>
  )

  return (
    <div
      className={`foxwarm-tool-card foxwarm-tool-tone-${tagTone} min-w-0 max-w-full text-xs relative group pl-2 ${toolSurfaceToneClasses[tagTone]} ${hasBody ? 'pb-1' : ''}`}
    >
      <ThreadLineButton
        expanded={expanded}
        onToggle={() => setExpanded(current => !current)}
        label={expanded ? `Collapse ${primaryName} tool` : `Expand ${primaryName} tool`}
        className={`foxwarm-tool-thread-line ${toolThreadLineToneClasses[tagTone]}`}
      />
      <div className={`foxwarm-tool-action-buttons ${actionButtonsToneClass} absolute right-1 top-1 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100`}>
        <IconToggleButton onClick={(e) => { e.stopPropagation(); setToolViewMode('default') }} active={viewMode === 'default'} title="Default"><Eye size={12} /></IconToggleButton>
        <IconToggleButton onClick={(e) => { e.stopPropagation(); setToolViewMode('json') }} active={viewMode === 'json'} title="JSON"><FileJson size={14} /></IconToggleButton>
      </div>

      {viewMode === 'json' ? (
        <div className={baseTextClass}>
          {header()}
          <pre ref={jsonFade.ref} {...jsonFade.overflowFadeProps} className="mt-2 whitespace-pre-wrap break-all cursor-text" onClick={(e) => e.stopPropagation()} style={expanded ? undefined : { ...clampContentStyle(6), ...jsonFade.overflowFadeProps.style }}>{jsonText}</pre>
        </div>
      ) : !expanded ? (
        <div className={baseTextClass}>
          <div className="space-y-1">
            {header(true)}
            {responsePreview && !hasToolScriptProgress && <div ref={resultFade.ref} {...resultFade.overflowFadeProps} className="foxwarm-tool-result-preview pr-2 text-fw-text" style={{ ...clampContentStyle(3), ...resultFade.overflowFadeProps.style }}>{responsePreview}</div>}
            {hasToolScriptProgress && <ToolScriptSubCallsTags subCalls={toolScriptSubCalls!} />}
          </div>
        </div>
      ) : (
        <div className={baseTextClass}>
          {header(false, true)}

          {(hasResponseContent || hasToolScriptProgress) && (
            <div className="foxwarm-tool-expanded-content foxwarm-tool-result-content mt-1 min-w-0 max-w-full cursor-default pr-2" onClick={(e) => e.stopPropagation()}>
              {hasResponseContent && !hasToolScriptProgress && (
                <div className="text-fw-text">
                  {responses.length > 0 && responses.map((resp, idx) => (
                    <div key={`${resp.tool_use_id || call?.id || call?.name || resp.name}-${idx}`} className={idx > 0 ? `pt-2 border-t ${isError ? 'border-fw-danger-border dark:border-fw-danger-border/40' : 'border-fw-success-border dark:border-fw-success-border/40'}` : ''}>
                      {renderToolResponseContent(resp, true, call)}
                    </div>
                  ))}

                  {imageParts.length > 0 && (
                    <div className={responses.length > 0 ? `pt-2 border-t ${isError ? 'border-fw-danger-border dark:border-fw-danger-border/40' : 'border-fw-success-border dark:border-fw-success-border/40'}` : ''}>
                      <ImageParts imageParts={imageParts} keyPrefix={`tool-pair-${call?.id || primaryName}`} />
                    </div>
                  )}
                </div>
              )}

              {hasToolScriptProgress && <ToolScriptSubCallsList subCalls={toolScriptSubCalls!} />}

              {hasToolScriptProgress && hasResponseContent && (
                <div className="text-fw-text">
                  {responses.length > 0 && responses.map((resp, idx) => {
                    const content = renderToolScriptResultContent(resp, true)
                    return content ? (
                      <div key={`${resp.tool_use_id || call?.id || call?.name || resp.name}-toolscript-result-${idx}`} className={idx > 0 ? `pt-2 border-t ${isError ? 'border-fw-danger-border dark:border-fw-danger-border/40' : 'border-fw-success-border dark:border-fw-success-border/40'}` : ''}>
                        {content}
                      </div>
                    ) : null
                  })}
                </div>
              )}
            </div>
          )}
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

  nextMsg.parts.filter(p => p.inlineData || p.inlineDataRef || p.inlineDataUnavailable).forEach(part => {
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

export const InterleavedToolGroup = memo(function InterleavedToolGroup({ msg, nextMsg, messageKeyPrefix, onOpenCodeFile }: { msg: Message; nextMsg: Message; messageKeyPrefix: string; onOpenCodeFile?: OpenCodeFileHandler }) {
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
          onOpenCodeFile={onOpenCodeFile}
        />
      ))}
    </div>
  )
})

export const ToolCallsBlock = memo(function ToolCallsBlock({ msg, onOpenCodeFile }: { msg: Message; onOpenCodeFile?: OpenCodeFileHandler }) {
  const functionCalls = useMemo(() => msg.parts.filter(p => p.functionCall).map(p => p.functionCall!), [msg.parts])
  if (functionCalls.length === 0) return null

  return (
    <div>
      {functionCalls.map((call, callIdx) => (
        <ToolCallResponseItem key={`call-${call.id || callIdx}`} call={call} responses={[]} imageParts={[]} modelMessage={msg} onOpenCodeFile={onOpenCodeFile} />
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
