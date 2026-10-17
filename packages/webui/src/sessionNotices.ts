import { parseSessionNotice, type SessionNotice } from '../../shared/src/sessionNotice'
import type { Message } from './components/chatShared'

export function getSessionNotice(message: Message): SessionNotice | null {
  if (message.role !== 'model' || message.modelVisible !== false) return null
  if (message.__meta?.noticeType === 'system-event') return parseSessionNotice(message.__meta.sessionNotice)
  // Existing first-party retry metadata remains recognizable after an upgrade.
  // Text, prefixes and arbitrary JSON inside a message never establish event identity.
  if (message.__meta?.noticeType !== 'llm-retry' || !message.parts.every(part => typeof part.text === 'string' && Object.keys(part).every(key => key === 'text'))) return null
  const retry = message.__meta.retry
  const final = retry?.final === true
  const details = message.parts.map(part => part.text).join('\n').slice(0, 32768)
  return {
    version: 1, id: `retry:${message.__meta.seq || message.__meta.timestamp || 'legacy'}`,
    source: 'model-request', severity: final ? 'error' : 'warning', title: final ? 'Request failed' : 'Request retry',
    summary: final ? 'The model request did not complete.' : 'A model request attempt failed.',
    ...(details ? { details } : {}),
  }
}

export function getLastSessionFailure(messages: readonly Message[]): { title: string; details?: string } | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.__meta?.temporary || message.__meta?.optimistic || message.__meta?.compactPreview) continue
    const notice = getSessionNotice(message)
    if (notice) return notice.severity === 'error' ? { title: notice.title, details: notice.details } : null
    if (message.modelVisible === false) continue
    return null
  }
  return null
}

export function createLocalSessionNotice(title: string, summary: string, details: string): Message {
  const id = globalThis.crypto?.randomUUID?.() || `notice-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return { role: 'model', modelVisible: false, parts: [{ text: details }], __meta: {
    temporary: true, timestamp: Date.now(), noticeType: 'system-event',
    sessionNotice: { version: 1, id, source: 'session', severity: 'error', title: title.slice(0, 100), summary: summary.slice(0, 300), details: details.slice(0, 32768) },
  } }
}
