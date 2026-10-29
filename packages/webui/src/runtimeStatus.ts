import type { SessionRuntimeState, SessionRuntimeRetryDetails } from './sessionRuntimeState'
import type { RuntimeFoxKind } from './components/RuntimeFox'

export interface RuntimeStatusView {
  kind: RuntimeFoxKind
  tone: 'accent' | 'special' | 'warning' | 'danger' | 'muted'
  label: string
  playful?: boolean
  secondary?: boolean
  details: Array<[string, string]>
}

export function retryLabel(retry: SessionRuntimeRetryDetails, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil(((retry.retryAt || 0) - now) / 1000))
  return `${seconds ? `Retrying in ${seconds}s` : 'Retrying'} · ${retry.nextAttempt || retry.attempt}/${retry.maxAttempts}`
}

export function describeRuntimeTool(runtime: SessionRuntimeState): { label: string; details: Array<[string, string]> } {
  const tool = runtime.tool
  if (!tool) return { label: 'Executing tool…', details: [] }
  const name = tool.name.split(/[.:/]/).at(-1) || tool.name
  const details: Array<[string, string]> = [['Tool', tool.name]]
  if (tool.invocationName) details.push(['Invocation', tool.invocationName])
  if (tool.source) details.push(['Source', tool.source])
  if (tool.server) details.push(['MCP server', tool.server])
  let label = name === 'exec' ? 'Executing exec' : name === 'run_script' || name === 'continue_script' ? 'Running script' : `Executing ${name}`
  if (tool.source !== 'mcp' && name === 'node' && tool.action === 'list') label = 'Listing nodes'
  if (tool.source !== 'mcp' && name === 'node' && tool.action === 'select') label = 'Selecting node'
  if (tool.source !== 'mcp' && name === 'read') label = tool.target ? `Reading ${tool.target}` : 'Reading file'
  if (tool.executionNode) details.push(['Node', tool.executionNode])
  if (typeof tool.index === 'number' && typeof tool.total === 'number') details.push(['Batch', `${tool.index + 1}/${tool.total}`])
  if (tool.argsPreview) details.push(['Arguments', tool.argsPreview])
  return { label: tool.executionNode && tool.executionNode !== 'master' ? `${label} · ${tool.executionNode}` : label, details }
}

export function describeRuntimeWaiting(runtime: SessionRuntimeState): { label: string; details: Array<[string, string]> } {
  const wait = runtime.waiting
  if (!wait) return { label: 'Waiting', details: [] }
  const details: Array<[string, string]> = []
  if (wait.reason) details.push(['Reason', wait.reason])
  if (wait.waitAllSessions?.length) details.push(['Sessions', `${wait.satisfiedSessions?.length || 0}/${wait.waitAllSessions.length} received`])
  if (wait.pendingSessions?.length) details.push(['Pending', wait.pendingSessions.join('\n')])
  if (wait.waitAnySessions?.length) details.push(['Expected sessions', wait.waitAnySessions.join('\n')])
  if (wait.waitExecIds?.length) details.push(['Commands', wait.waitExecIds.join('\n')])
  if (wait.waitForInput) details.push(['Input', 'Waiting for external activity'])
  if (wait.timeoutAt) details.push(['Wake deadline', new Date(wait.timeoutAt).toLocaleString()])
  if (wait.waitingFor === 'all-sessions') {
    const count = wait.pendingSessions?.length ?? Math.max(0, (wait.waitAllSessions?.length || 0) - (wait.satisfiedSessions?.length || 0))
    return { label: count ? `Waiting for ${count} session${count === 1 ? '' : 's'}` : 'Waiting for sessions', details }
  }
  if (wait.waitingFor === 'any-session') return { label: 'Waiting for a session reply', details }
  if (wait.waitingFor === 'exec') { const count = wait.waitExecIds?.length || 1; return { label: count > 1 ? `Waiting for ${count} commands` : 'Waiting for command', details } }
  if (wait.waitingFor === 'input') return { label: 'Waiting for input', details }
  return { label: 'Waiting for wake-up', details }
}

export function getRuntimeStatusView(runtime: SessionRuntimeState | undefined, fallbackBusy = false, now = Date.now()): RuntimeStatusView | null {
  const state = runtime?.state || (fallbackBusy ? 'requesting-model' : 'idle')
  const details: Array<[string, string]> = []
  if (runtime?.active?.modelKey) details.push(['Model', runtime.active.modelKey])
  if (runtime?.note) details.push(['State', runtime.note])
  const compact = runtime?.compaction
  if (compact) {
    details.push(['Compaction', `${compact.background ? 'Background · ' : ''}${compact.phase}`])
    if (compact.retry) {
      details.push(['Compaction retry', retryLabel(compact.retry, now)])
      if (compact.retry.reason) details.push(['Compaction error', compact.retry.reason])
    }
  }
  if (state === 'llm-failed') return { kind: 'error', tone: 'danger', label: 'Request failed', details }
  if (runtime?.stopping) return { kind: 'stopping', tone: 'warning', label: 'Stopping…', details }
  if (runtime?.active?.phase === 'compaction') {
    const retry = compact?.retry
    return { kind: retry ? 'retry' : 'compact', tone: retry ? 'warning' : 'accent', label: retry ? `Compacting context · ${retryLabel(retry, now)}` : compact?.phase === 'committing' ? 'Applying compacted context…' : compact?.phase === 'ready' || compact?.phase === 'enqueueing' ? 'Waiting to apply compaction…' : 'Compacting context…', details }
  }
  if (runtime?.retry) {
    if (runtime.retry.final) return { kind: 'error', tone: 'danger', label: 'Request failed', details: [...details, ...(runtime.retry.reason ? [['Error', runtime.retry.reason] as [string,string]] : [])] }
    if (runtime.retry.reason) details.push(['Last error', runtime.retry.reason])
    return { kind: 'retry', tone: 'warning', label: retryLabel(runtime.retry, now), details }
  }
  if (state === 'requesting-model') return !runtime || runtime.active?.phase === 'unknown'
    ? { kind: 'unknown', tone: 'muted', label: 'Running…', details }
    : { kind: 'request', tone: 'accent', label: 'Requesting model…', playful: true, details }
  if (state === 'running-tool' && runtime) { const tool = describeRuntimeTool(runtime); return { kind: 'tool', tone: 'special', label: tool.label, details: [...tool.details, ...details] } }
  if (state === 'waiting' && runtime) { const wait = describeRuntimeWaiting(runtime); return { kind: 'waiting', tone: 'warning', label: wait.label, details: [...wait.details, ...details] } }
  if (compact) return { kind: 'compact', tone: 'muted', label: 'Compacting in background…', secondary: true, details }
  if (state === 'idle' && runtime?.processing) return { kind: 'unknown', tone: 'muted', label: 'Running…', details }
  return null
}
