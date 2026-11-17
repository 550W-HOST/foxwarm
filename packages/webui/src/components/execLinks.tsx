import { createContext, memo, useContext, type MouseEvent, type ReactNode } from 'react'
import type { Message } from './chatShared'

/**
 * Cross-links between a background command's receipt (`[execId] Still running…`) and its
 * completion event (`[execId] Finished: …`). Only a leading `[execId]` of those two items is a
 * link; earlier history without the header renders as plain text.
 */
export type ExecLinkRole = 'receipt' | 'completion'

// Petname IDs and the longer legacy `exec_…` IDs.
const LEADING_EXEC_ID = /^\[([a-z]+-[a-z]+|exec_[A-Za-z0-9_-]{8,160})\] /
const COMPLETION_FRAME = /<foxwarm-system kind="event" type="background-process-finished"[^>]*>\n\[([a-z]+-[a-z]+|exec_[A-Za-z0-9_-]{8,160})\] /

export const leadingExecId = (text: string | undefined | null): string | null =>
  typeof text === 'string' ? LEADING_EXEC_ID.exec(text)?.[1] ?? null : null

const receiptText = (response: unknown): string | null => {
  if (typeof response === 'string') return response
  if (response && typeof response === 'object' && !Array.isArray(response)) {
    const output = (response as { output?: unknown }).output
    if (typeof output === 'string') return output
  }
  return null
}

export interface ExecLinkIndex {
  receipts: Set<string>
  completions: Set<string>
}

/** Which receipts and completion events are present in the loaded messages. */
export const indexExecLinks = (messages: readonly Message[]): ExecLinkIndex => {
  const receipts = new Set<string>()
  const completions = new Set<string>()
  for (const message of messages) {
    for (const part of message.parts) {
      const receipt = part.functionResponse ? leadingExecId(receiptText(part.functionResponse.response)) : null
      if (receipt) receipts.add(receipt)
      const completion = part.system ? COMPLETION_FRAME.exec(part.system)?.[1] : null
      if (completion) completions.add(completion)
    }
  }
  return { receipts, completions }
}

export interface ExecLinkController {
  /** Whether the counterpart of this item is in loaded history. */
  hasCounterpart: (execId: string, role: ExecLinkRole) => boolean
  /** Moves to and highlights the counterpart; does nothing when it is not loaded. */
  jump: (execId: string, role: ExecLinkRole) => void
}

export const ExecLinkContext = createContext<ExecLinkController | null>(null)

/** A mounted link of the given item, inside one timeline. */
export const findExecLink = (root: ParentNode | null | undefined, execId: string, role: ExecLinkRole): HTMLElement | null =>
  root?.querySelector<HTMLElement>(`[data-exec-link][data-exec-ref="${CSS.escape(execId)}"][data-exec-role="${role}"]`) ?? null

/** Briefly highlights a link that was jumped to. */
export const flashExecLink = (element: HTMLElement) => {
  element.classList.remove('fw-exec-link-flash')
  void element.offsetWidth
  element.classList.add('fw-exec-link-flash')
  window.setTimeout(() => element.classList.remove('fw-exec-link-flash'), 1900)
}

export const counterpartRole = (role: ExecLinkRole): ExecLinkRole => role === 'receipt' ? 'completion' : 'receipt'

export const ExecIdLink = memo(function ExecIdLink({ execId, role }: { execId: string; role: ExecLinkRole }) {
  const controller = useContext(ExecLinkContext)
  const text = `[${execId}]`
  if (!controller) return <>{text}</>
  const present = controller.hasCounterpart(execId, role)
  const title = present
    ? role === 'receipt' ? 'Show when it finished' : 'Show where it started'
    : role === 'receipt' ? 'Not finished yet' : 'Start is not loaded'
  const onClick = (event: MouseEvent) => {
    event.stopPropagation()
    event.preventDefault()
    controller.jump(execId, role)
  }
  return <span role="link" tabIndex={0} data-exec-link data-exec-ref={execId} data-exec-role={role} title={title}
    onClick={onClick}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.stopPropagation(); event.preventDefault(); controller.jump(execId, role) } }}
    className={`fw-exec-link rounded-sm font-mono ${present ? 'cursor-pointer underline decoration-dotted underline-offset-2 hover:text-fw-accent' : 'cursor-default'}`}>{text}</span>
})

/** Renders `text`, turning its leading `[execId]` into a link when present. */
export const withLeadingExecLink = (text: string, role: ExecLinkRole, rest: (remaining: string) => ReactNode): ReactNode => {
  const execId = leadingExecId(text)
  if (!execId) return rest(text)
  return <><ExecIdLink execId={execId} role={role} />{rest(text.slice(execId.length + 2))}</>
}
