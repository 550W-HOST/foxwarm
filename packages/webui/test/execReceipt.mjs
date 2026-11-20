// Structure of Main's exec receipts and completion events, without their editorial wording.
// A background receipt starts with `[execId] ` and the partial output follows its first line.
// A completion event starts with `[execId] <state>: exit code <n>, <duration>`; Main persists
// it inside a background-process-finished framing element, whose attributes (seq) vary.
import assert from 'node:assert/strict'

const leading = /^\[([A-Za-z0-9_-]+)\] \S/
const framing = /^<foxwarm-system kind="event" type="background-process-finished"[^>\n]*>\n/
const completionHeader = /^\[([A-Za-z0-9_-]+)\] ([^:\n]+): exit code (-?\d+|unknown), \S/

// Model requests may put a time reminder line before a tool result; it is not part of the receipt.
const reminder = /^(?:<foxwarm-system kind="time"[^>\n]*\/>\n)+/
const receiptBody = text => String(text ?? '').replace(reminder, '')

// The execId in the first line of a background receipt, or undefined when it is not one.
export const receiptExecId = text => leading.exec(receiptBody(text))?.[1]

export function requireReceiptExecId(text) {
  const execId = receiptExecId(text)
  assert(execId, `Expected a receipt starting with [execId], got: ${String(text).slice(0, 250)}`)
  return execId
}

// The log file line of a receipt or completion event footer.
export const receiptLogPath = text => /^Log file: (.+)$/m.exec(String(text ?? ''))?.[1]

// A persisted or wire completion event as { execId, state, exitCode }, or undefined when the text
// is not an execId-first completion event. exitCode is null when the Node reported it unknown.
export function completionEvent(system) {
  const text = String(system ?? '')
  const match = completionHeader.exec(text.replace(framing, ''))
  if (!match) return undefined
  return { execId: match[1], state: match[2], exitCode: match[3] === 'unknown' ? null : Number(match[3]) }
}

// Whether a message part is the framed completion event of this execId.
export const isCompletionFor = (part, execId) => typeof part?.system === 'string'
  && framing.test(part.system) && completionEvent(part.system)?.execId === execId
