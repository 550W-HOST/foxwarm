import type { ModelStreamToolCall } from './components/chatShared'

/** Read string fields from a JSON prefix without treating text inside strings as structure. */
function stringFields(raw: string): Map<string, string> {
  const fields = new Map<string, string>()
  let offset = 0
  const space = () => { while (/\s/.test(raw[offset] || '') && offset < raw.length) offset++ }
  const string = (): { value: string; complete: boolean } | undefined => {
    if (raw[offset] !== '"') return undefined
    const start = offset++
    let end = offset
    while (offset < raw.length) {
      const char = raw[offset++]
      if (char === '"') {
        try { return { value: JSON.parse(raw.slice(start, offset)), complete: true } } catch { return undefined }
      }
      if (char === '\\') {
        if (offset >= raw.length) break
        const escape = raw[offset++]
        if (escape === 'u') {
          if (!/^[\da-fA-F]{4}$/.test(raw.slice(offset, offset + 4))) break
          offset += 4
        } else if (!'"\\/bfnrt'.includes(escape)) return undefined
      } else if (char.charCodeAt(0) < 32) return undefined
      end = offset
    }
    try { return { value: JSON.parse(raw.slice(start, end) + '"'), complete: false } } catch { return undefined }
  }
  const value = (path: string[]): boolean => {
    space()
    if (raw[offset] === '"') {
      const result = string()
      // argsJson is itself a JSON document. Its decoded prefix may already contain a complete summary.
      if (result && (result.complete || path.length === 1 && path[0] === 'argsJson')) fields.set(JSON.stringify(path), result.value)
      return !!result?.complete
    }
    const opening = raw[offset]
    if (opening === '{' || opening === '[') {
      offset++
      space()
      const closing = opening === '{' ? '}' : ']'
      if (raw[offset] === closing) { offset++; return true }
      let index = 0
      while (offset < raw.length) {
        space()
        const key = opening === '{' ? string() : { value: String(index++), complete: true }
        if (!key?.complete) return false
        space()
        if (opening === '{' && raw[offset++] !== ':') return false
        if (!value([...path, key.value])) return false
        space()
        if (raw[offset] === closing) { offset++; return true }
        if (raw[offset++] !== ',') return false
      }
      return false
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|[,}\]]|$)/.exec(raw.slice(offset))
    if (!token) return false
    offset += token[0].length
    return true
  }
  space()
  if (raw[offset] === '{') value([])
  return fields
}

export function getStreamingToolSummary(call: ModelStreamToolCall): string | undefined {
  // Direct model tool names are exact registry names; arbitrary namespace/MCP suffixes are not aliases.
  if (!['exec', 'run_script', 'call_tool'].includes(call.name || '')) return undefined
  const fields = stringFields(call.arguments || '')
  const field = (...path: string[]) => fields.get(JSON.stringify(path))
  if (call.name !== 'call_tool') return field('summary')?.trim() || undefined
  const id = field('toolId')
  let source = field('source'), name = field('name')
  if (id) {
    if (id.startsWith('builtin:')) { source = 'builtin'; name = id.slice(8).trim() }
    else if (id.startsWith('node:') && id.lastIndexOf('/') > 5) { source = 'node'; name = id.slice(id.lastIndexOf('/') + 1) }
    else return undefined
  }
  if (!(source === 'node' && name === 'exec' || source === 'builtin' && name === 'run_script')) return undefined
  const summary = field('args', 'summary') ?? stringFields(field('argsJson') || '').get('["summary"]')
  return summary?.trim() || undefined
}
