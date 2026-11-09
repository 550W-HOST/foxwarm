import { API_BASE_PATH } from './config'
import { formatCompactDuration } from './usageTiming'

/** One turn's text redaction summary, as saved with its reply (`__meta.textRedaction`). */
export type TextRedactionTurn = {
  replaced: number
  labels: Record<string, { detected: number; literal: number }>
  slots: number
  cachedSlots: number
  detectorCalls: number
  detectionMs: number
  omitted?: boolean
}

export type TextRedactionSummary = {
  replaced: number
  /** Replacements per label, largest first. */
  labels: Array<{ label: string; detected: number; literal: number }>
  slots: number
  cachedSlots: number
  detectionMs: number
}

const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Validated summary, or null for replies whose request did not use text redaction. */
export function readTextRedaction(value: unknown): TextRedactionTurn | null {
  if (!record(value) || !count(value.replaced) || !count(value.slots) || !count(value.cachedSlots)
    || typeof value.detectionMs !== 'number' || !Number.isFinite(value.detectionMs) || value.detectionMs < 0 || !record(value.labels)) return null
  const labels: TextRedactionTurn['labels'] = {}
  for (const [label, item] of Object.entries(value.labels)) {
    if (!record(item) || !count(item.detected) || !count(item.literal)) return null
    labels[label] = { detected: item.detected, literal: item.literal }
  }
  return {
    replaced: value.replaced,
    labels,
    slots: value.slots,
    cachedSlots: value.cachedSlots,
    detectorCalls: count(value.detectorCalls) ? value.detectorCalls : 0,
    detectionMs: value.detectionMs,
    ...(value.omitted === true ? { omitted: true } : {}),
  }
}

/** Sums the turns that used redaction; null when none did. */
export function summarizeTextRedaction(turns: ReadonlyArray<TextRedactionTurn | null | undefined>): TextRedactionSummary | null {
  const used = turns.filter((turn): turn is TextRedactionTurn => !!turn)
  if (!used.length) return null
  const labels = new Map<string, { detected: number; literal: number }>()
  for (const turn of used) {
    for (const [label, item] of Object.entries(turn.labels)) {
      const current = labels.get(label) || { detected: 0, literal: 0 }
      labels.set(label, { detected: current.detected + item.detected, literal: current.literal + item.literal })
    }
  }
  return {
    replaced: used.reduce((sum, turn) => sum + turn.replaced, 0),
    labels: [...labels].map(([label, item]) => ({ label, ...item }))
      .filter(item => item.detected + item.literal > 0)
      .sort((left, right) => (right.detected + right.literal) - (left.detected + left.literal) || left.label.localeCompare(right.label)),
    slots: used.reduce((sum, turn) => sum + turn.slots, 0),
    cachedSlots: used.reduce((sum, turn) => sum + turn.cachedSlots, 0),
    detectionMs: used.reduce((sum, turn) => sum + turn.detectionMs, 0),
  }
}

export const sameTextRedaction = (left: TextRedactionTurn | null, right: TextRedactionTurn | null) =>
  left === right || (!!left && !!right && JSON.stringify(left) === JSON.stringify(right))

/** Detector labels read as words: `private_person` → `person`. */
export const formatRedactionLabel = (label: string) => label.replace(/^private_/, '').replace(/_/g, ' ').trim() || 'other'

export const formatDetectionTime = (milliseconds: number) =>
  milliseconds < 1000 ? `${Math.round(milliseconds)}ms`
    : milliseconds < 10_000 ? `${(milliseconds / 1000).toFixed(1)}s`
      : formatCompactDuration(milliseconds)

/** Rows for the usage details: what was replaced, then how long detection took. */
export function textRedactionRows(summary: TextRedactionSummary): Array<[string, string]> {
  const labels = summary.labels.map(item => `${formatRedactionLabel(item.label)} ${item.detected + item.literal}`).join(', ')
  const cached = summary.slots ? ` · ${Math.round(summary.cachedSlots / summary.slots * 100)}% cached` : ''
  return [
    ['Redacted', summary.replaced ? `${summary.replaced.toLocaleString('en')}${labels ? ` · ${labels}` : ''}` : 'None'],
    ['Detection', `${formatDetectionTime(summary.detectionMs)}${cached}`],
  ]
}

/** Installation-wide redaction statistics in a usage report row (`usage.redaction`). */
export type UsageRedaction = {
  attempts: number
  replacements: number
  detected: number
  literal: number
  labels: Record<string, number>
  slots: number
  cachedSlots: number
  detectorCalls: number
  detectionMs: number
  failures: Record<string, number>
  omitted: number
}

const counts = (value: unknown) => record(value) && Object.values(value).every(count)

export function isUsageRedaction(value: unknown): value is UsageRedaction {
  return record(value) && count(value.attempts) && count(value.replacements) && count(value.detected) && count(value.literal)
    && count(value.slots) && count(value.cachedSlots) && count(value.detectorCalls) && count(value.omitted)
    && typeof value.detectionMs === 'number' && Number.isFinite(value.detectionMs) && value.detectionMs >= 0
    && counts(value.labels) && counts(value.failures)
}

export const REDACTION_FAILURE_LABELS: Record<string, string> = {
  busy: 'Service busy',
  timeout: 'Timed out',
  connection: 'Connection failed',
  'too-large': 'Text too long',
  'invalid-response': 'Invalid response',
  config: 'Setup or key',
  'service-error': 'Service error',
  other: 'Other',
}

export const formatRedactionFailure = (kind: string) => REDACTION_FAILURE_LABELS[kind] || kind

export const redactionFailureCount = (redaction: UsageRedaction) => Object.values(redaction.failures).reduce((sum, value) => sum + value, 0)

/** One replaced range of a slot text, in UTF-16 code units. */
export type SentVersionRange = { start: number; length: number; label: string; source: 'detected' | 'literal' }

export type SentVersionSlot = {
  kind: 'text' | 'system' | 'content' | 'argument' | 'arguments' | 'output'
  part: number
  path?: string
  name?: string
  callId?: string
  text: string
  available: boolean
  ranges?: SentVersionRange[]
}

export type SentVersion =
  | { enabled: false; seq: number }
  | { enabled: true; seq: number; state: 'available' | 'partial' | 'unavailable' | 'empty'; slots: SentVersionSlot[] }

function isSlot(value: unknown): value is SentVersionSlot {
  return record(value) && typeof value.kind === 'string' && typeof value.part === 'number' && typeof value.text === 'string' && typeof value.available === 'boolean'
    && (value.path === undefined || typeof value.path === 'string') && (value.name === undefined || typeof value.name === 'string')
    && (value.callId === undefined || typeof value.callId === 'string')
    && (value.ranges === undefined || (Array.isArray(value.ranges) && value.ranges.every(range => record(range) && count(range.start) && count(range.length)
      && typeof range.label === 'string' && (range.source === 'detected' || range.source === 'literal'))))
}

export function isSentVersion(value: unknown): value is SentVersion {
  if (!record(value) || typeof value.enabled !== 'boolean') return false
  if (!value.enabled) return true
  return ['available', 'partial', 'unavailable', 'empty'].includes(value.state as string) && Array.isArray(value.slots) && value.slots.every(isSlot)
}

export const sentVersionUrl = (sessionId: string, seq: number) =>
  `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/messages/${seq}/redaction`

export async function loadSentVersion(sessionId: string, seq: number, signal?: AbortSignal): Promise<SentVersion> {
  const response = await fetch(sentVersionUrl(sessionId, seq), { signal })
  const payload: unknown = await response.json().catch(() => null)
  if (!response.ok || !isSentVersion(payload)) throw new Error('The sent version could not be loaded.')
  return payload
}

/** Plain and replaced pieces of a slot text, in order; overlapping or invalid ranges are skipped. */
export function sentVersionSegments(text: string, ranges: readonly SentVersionRange[] = []): Array<{ text: string; range?: SentVersionRange }> {
  const segments: Array<{ text: string; range?: SentVersionRange }> = []
  let cursor = 0
  for (const range of [...ranges].sort((left, right) => left.start - right.start)) {
    const end = range.start + range.length
    if (range.length <= 0 || range.start < cursor || end > text.length) continue
    if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start) })
    segments.push({ text: text.slice(range.start, end), range })
    cursor = end
  }
  if (cursor < text.length || !segments.length) segments.push({ text: text.slice(cursor) })
  return segments
}

/** Heading for one slot of a message: its text, a tool argument or a tool result. */
export function sentVersionSlotLabel(slot: SentVersionSlot): string {
  switch (slot.kind) {
    case 'argument': return slot.path ? `${slot.name || 'Tool'} · ${slot.path}` : slot.name || 'Tool input'
    case 'arguments': return `${slot.name || 'Tool'} · input`
    case 'output': return `${slot.name || 'Tool'} · result`
    default: return 'Text'
  }
}
