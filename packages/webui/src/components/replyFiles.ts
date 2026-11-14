import { parseFileDeliveryArtifact, type FileDeliveryArtifact } from '../../../shared/src/fileDelivery'
import type { FunctionCall, Message } from './chatShared'

export type ReplyFile = Omit<FileDeliveryArtifact, 'sizeBytes'> & { sizeBytes?: number }
export interface ReplyFileGroup { key: string; files: ReplyFile[]; startIndex: number; endIndex: number }

const localTarget = (file: FileDeliveryArtifact, sessionId: string) => file.targetKind === 'session'
  ? file.targetId === sessionId : file.targetId === `webui:${sessionId}`
const isSend = (name: string) => name === 'send_file' || name === 'functions.send_file'
function sendArgs(call?: FunctionCall): Record<string, any> | undefined {
  if (!call) return undefined
  if (isSend(call.name)) return call.args
  if (call.name === 'call_tool' && (call.args?.toolId === 'builtin:send_file' || call.args?.source === 'builtin' && call.args.name === 'send_file')) return call.args.args
  return undefined
}

/** Read receipt objects only, never stdout/JSON strings or model-authored file links. */
function receipts(value: unknown): FileDeliveryArtifact[] {
  const result: FileDeliveryArtifact[] = [], pending = [{ value, depth: 0 }]
  let visited = 0
  while (pending.length && visited++ < 512) {
    const { value: current, depth } = pending.pop()!
    if (!current || typeof current !== 'object' || depth > 8) continue
    const artifact = parseFileDeliveryArtifact((current as any).fileDelivery)
    if (artifact) result.push(artifact)
    const children = Array.isArray(current) ? current : Object.values(current)
    for (const child of children.slice(0, 128).reverse()) if (child && typeof child === 'object') pending.push({ value: child, depth: depth + 1 })
  }
  return result
}

function legacyFile(call: FunctionCall | undefined, response: any, id: string, sessionId: string): ReplyFile | undefined {
  const args = sendArgs(call)
  if (!args || response?.fileDelivery !== undefined || typeof response?.fullPath !== 'string' || !/^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(response.fullPath)) return
  if (args.sessionId && args.sessionId !== sessionId || args.channelTargetId && args.channelTargetId !== `webui:${sessionId}`) return
  const fileName = (typeof args.filePath === 'string' ? args.filePath : response.fullPath).split(/[\\/]/).filter(Boolean).at(-1)
  if (!fileName) return
  const ext = fileName.split('.').at(-1)?.toLowerCase()
  const mimeType = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[ext || ''] || 'application/octet-stream'
  return { version: 1, deliveryId: id, targetKind: 'session', targetId: sessionId, fileName, mimeType, downloadPath: response.fullPath, downloadNodeId: 'master', sourceNodeId: typeof args.node === 'string' ? args.node : 'unknown' }
}

/** An input-bounded reply span owns its files; internal notices do not start a new span. */
function inputBoundary(message: Message) {
  if (message.__meta?.contextBlock) return true
  if (message.role !== 'user' || message.parts.some(part => part.functionResponse)) return false
  return message.parts.some(part => part.text !== undefined || part.inlineData || part.inlineDataRef || part.inlineDataUnavailable
    || part.system && !/^\s*<foxwarm-system\b/.test(part.system))
}

export function buildReplyFileGroups(messages: readonly Message[], sessionId: string): ReplyFileGroup[] {
  const calls = new Map<string, FunctionCall>(), seen = new Set<string>(), groups: ReplyFileGroup[] = []
  let startIndex = 0, files: ReplyFile[] = []
  const flush = (endIndex: number) => {
    if (files.length) groups.push({ key: `reply-files:${files[0].deliveryId}`, files, startIndex, endIndex })
    files = []
  }
  messages.forEach((message, index) => {
    if (inputBoundary(message)) { flush(index - 1); startIndex = index }
    if (message.__meta?.queuedPreview) return
    for (const part of message.parts) if (part.functionCall?.id) calls.set(part.functionCall.id, part.functionCall)
    if (message.role === 'model') return
    for (const part of message.parts) {
      const resp = part.functionResponse
      if (!resp || resp.response?.error || (resp.response as any)?.isError) continue
      const call = resp.tool_use_id ? calls.get(resp.tool_use_id) : undefined
      if (!isSend(resp.name) && !sendArgs(call) && !['run_script', 'continue_script', 'call_tool'].includes(resp.name.replace(/^functions\./, ''))) continue
      let found: ReplyFile[] = receipts(resp.response).filter(file => localTarget(file, sessionId))
      if (!found.length && (isSend(resp.name) || sendArgs(call))) {
        const old = legacyFile(call, resp.response, `legacy:${resp.tool_use_id}`, sessionId)
        if (old) found = [old]
      }
      for (const file of found) if (!seen.has(file.deliveryId)) { seen.add(file.deliveryId); files.push(file) }
    }
  })
  flush(messages.length - 1)
  return groups
}
