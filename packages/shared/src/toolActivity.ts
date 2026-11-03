export interface ActivityCall { name: string; args?: Record<string, unknown> }

/** Resolve only the display descriptor; this grants no execution authority. */
export function toolActivityTarget(call: ActivityCall): ActivityCall {
  if (call.name !== 'call_tool') return call
  const args = call.args || {}
  const id = typeof args.toolId === 'string' ? args.toolId : ''
  const separator = id.startsWith('builtin:') ? id.indexOf(':') : id.startsWith('mcp:') ? id.indexOf('/') : id.lastIndexOf('/')
  const name = separator >= 0 ? id.slice(separator + 1) : args.name
  if (typeof name !== 'string' || !name.trim()) return call
  let inner = args.args
  if (!inner && typeof args.argsJson === 'string') {
    try { inner = JSON.parse(args.argsJson) } catch { /* Keep the target label for malformed historical arguments. */ }
  }
  return { name, args: inner && typeof inner === 'object' && !Array.isArray(inner) ? inner as Record<string, unknown> : {} }
}

export function toolActivitySummary(call: ActivityCall): string {
  const { name, args = {} } = toolActivityTarget(call)
  const text = (key: string): string => typeof args[key] === 'string' ? args[key] as string : ''
  let summary: string
  if (name === 'exec' || name === 'run_script') {
    summary = text('summary').trim() || text(name === 'exec' ? 'command' : 'filePath')
  } else {
    const target = ['filePath', 'title', 'target', 'query', 'text_query', 'vector_query', 'sessionId', 'nodeId', 'skillName', 'taskId', 'url', 'reason'].map(text).find(value => value.trim())
    summary = [text('action'), target].filter(Boolean).join(' · ')
  }
  const line = summary.replace(/\s+/g, ' ').trim()
  if (line.length <= 200) return line
  const end = /[\uD800-\uDBFF]/.test(line[198]) ? 198 : 199
  return line.slice(0, end) + '…'
}
