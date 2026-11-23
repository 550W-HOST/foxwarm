import { createContext, memo, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { API_BASE_PATH } from '../config'
import { computeLinkBases, decodeLinkBase, resolveFileLink, type CodeLinkBase } from '../codeFileLinks'
import { makeVscodeWebUrl, normalizeCodePath, type CodeFileTarget } from '../vscodeWeb'
import type { Message } from './chatShared'
import type { FileLinkRenderer } from './markdownRenderer'

export type CodeLines = { startLine?: number; endLine?: number }
export type ResolvedCodePath = { nodeId: string; resolvedPath: string }
export type OpenCodeFileHandler = (filePath: string, lines?: CodeLines, target?: ResolvedCodePath) => void

/** Shared by reply file links and expanded file-tool paths. */
export const CODE_LINK_CLASS = 'foxwarm-code-link'

/** Code URL for a file target; the native fallback for new-tab gestures on a Code link. */
export function codeFileHref(target: CodeFileTarget): string {
  const folder = target.path.slice(0, target.path.lastIndexOf('/')) || '/'
  return makeVscodeWebUrl(API_BASE_PATH, window.location.origin, { nodeId: target.nodeId, path: folder }, { openFile: target }).toString()
}

const lineData = (lines?: CodeLines): Record<string, string> => ({
  ...(lines?.startLine !== undefined ? { 'data-code-start-line': String(lines.startLine) } : {}),
  ...(lines?.endLine !== undefined ? { 'data-code-end-line': String(lines.endLine) } : {}),
})

const readLines = (anchor: HTMLElement): CodeLines | undefined => {
  const line = (value: string | undefined) => value && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
  const startLine = line(anchor.dataset.codeStartLine)
  const endLine = line(anchor.dataset.codeEndLine)
  return startLine === undefined && endLine === undefined ? undefined : { ...(startLine !== undefined ? { startLine } : {}), ...(endLine !== undefined ? { endLine } : {}) }
}

/**
 * The one activation path for Code links. A plain click or tap opens Code in the app; new-tab
 * gestures on a link with an href stay native. The surrounding card never sees the click.
 */
export function activateCodeLink(event: MouseEvent | KeyboardEvent, anchor: HTMLElement, onOpen: OpenCodeFileHandler | undefined): void {
  event.stopPropagation()
  const mouse = 'button' in event ? event : null
  if (anchor.hasAttribute('href') && (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || (mouse && mouse.button !== 0))) return
  event.preventDefault()
  const label = anchor.dataset.codeLabel
  if (!onOpen || label === undefined) return
  const { codeNode: nodeId, codePath: resolvedPath } = anchor.dataset
  onOpen(label, readLines(anchor), nodeId && resolvedPath ? { nodeId, resolvedPath } : undefined)
}

/** Delegated handler for rendered Markdown: true when the click was on a Code link. */
export function handleRenderedCodeLinkClick(event: MouseEvent<HTMLElement>, onOpen: OpenCodeFileHandler | undefined): boolean {
  const anchor = (event.target as HTMLElement).closest?.(`a.${CODE_LINK_CLASS}`) as HTMLElement | null
  if (!anchor || !event.currentTarget.contains(anchor)) return false
  activateCodeLink(event, anchor, onOpen)
  return true
}

/** Rendering of reply link destinations against the reply's link base. */
export function codeFileLinkRenderer(base: CodeLinkBase | undefined): FileLinkRenderer {
  return (href) => {
    const target = resolveFileLink(href, base)
    if (!target) return target
    return {
      href: codeFileHref(target),
      attributes: {
        'data-code-label': href,
        'data-code-node': target.nodeId,
        'data-code-path': target.path,
        ...lineData(target),
      },
    }
  }
}

/**
 * A path rendered as a Code link. Without a known Node it has no href and the app's
 * handler supplies the fallback target.
 */
export const CodeFileLink = memo(function CodeFileLink({ label, lines, target, onOpen, className = '', children }: {
  label: string
  lines?: CodeLines
  target?: ResolvedCodePath
  onOpen: OpenCodeFileHandler
  className?: string
  children: ReactNode
}) {
  const path = target ? normalizeCodePath(target.resolvedPath) : null
  const href = target && path ? codeFileHref({ kind: 'openFile', nodeId: target.nodeId, path, ...lines }) : undefined
  return (
    <a
      className={`${CODE_LINK_CLASS} ${className}`}
      href={href}
      target={href ? '_blank' : undefined}
      rel={href ? 'noopener noreferrer' : undefined}
      role={href ? undefined : 'link'}
      tabIndex={href ? undefined : 0}
      title={`Open ${label} in Code`}
      data-code-label={label}
      data-code-node={target?.nodeId}
      data-code-path={target?.resolvedPath}
      {...lineData(lines)}
      onClick={(event) => activateCodeLink(event, event.currentTarget, onOpen)}
      onKeyDown={href ? undefined : (event) => { if (event.key === 'Enter') activateCodeLink(event, event.currentTarget, onOpen) }}
    >
      {children}
    </a>
  )
})

type LinkBaseStore = {
  bases: Map<Message, string>
  listeners: Set<() => void>
  subscribe: (listener: () => void) => () => void
}

const CodeLinkBaseContext = createContext<LinkBaseStore | null>(null)
const noSubscription = () => () => {}

/**
 * Supplies each model message's link base from the complete loaded timeline. Rows read their
 * own base, so a history change rerenders only replies whose base changed.
 */
export function CodeLinkBaseProvider({ messages, children }: { messages: readonly Message[]; children: ReactNode }) {
  const storeRef = useRef<LinkBaseStore | null>(null)
  if (!storeRef.current) {
    const listeners = new Set<() => void>()
    storeRef.current = { bases: new Map(), listeners, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener) } }
  }
  const store = storeRef.current
  const bases = useMemo(() => computeLinkBases(messages), [messages])
  // Rows rendered in this pass read the new map; memoized rows are notified after commit.
  store.bases = bases
  useEffect(() => { for (const listener of [...store.listeners]) listener() }, [bases, store])
  return <CodeLinkBaseContext.Provider value={store}>{children}</CodeLinkBaseContext.Provider>
}

/** The link base of a model message, or undefined when no earlier tool call records one. */
export function useCodeLinkBase(message: Message): CodeLinkBase | undefined {
  const store = useContext(CodeLinkBaseContext)
  const key = useSyncExternalStore(store?.subscribe ?? noSubscription, () => store?.bases.get(message) ?? '')
  return useMemo(() => decodeLinkBase(key), [key])
}

/** Whether a timeline already receives link bases from an enclosing timeline. */
export const useHasCodeLinkBases = (): boolean => useContext(CodeLinkBaseContext) !== null
