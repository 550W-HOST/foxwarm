import { readFileSync } from 'node:fs'

// Mock-model tool calls for host e2e tests. Models reach every builtin outside the native
// declarations, and the generic dispatch and discovery front ends, through `ctl`.
export const NATIVE_TOOLS = new Set([
  'read', 'write', 'edit', 'exec', 'run_script', 'continue_script', 'wait', 'ask_user',
  'send_to_session', 'create_child_session', 'task', 'submit_compact_plan', 'ctl', 'generate_image',
])

// Builtins reachable through a specific ctl command; other names (retired or unknown tools in
// negative cases) stay direct so their errors are unchanged.
const registry = JSON.parse(readFileSync(new URL('../../../dotnet/Foxwarm/Tools/Ctl/CtlCommands.json', import.meta.url), 'utf8'))
export const CTL_BUILTINS = new Set(registry.commands.filter(command => command.ingress.includes('model') && command.target?.source === 'builtin').map(command => command.target.name))

const quote = value => {
  const text = String(value).startsWith('@') ? '@' + value : String(value)
  return text.length > 0 && /^[A-Za-z0-9_./:#%+=,@-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

// Control arguments the framework reads on any tool call, kept on the ctl call itself.
const CONTROL = ['__cancelTool', '__cancelAllToolsThisTurn']

function control(args) {
  const rest = { ...args }
  const kept = {}
  for (const key of CONTROL) if (key in rest) { kept[key] = rest[key]; delete rest[key] }
  return [rest, kept]
}

/** `ctl tool call` arguments for a former unified descriptor (toolId or source/name/server/nodeId, args or argsJson). */
export function ctlToolCall(descriptor) {
  const [plain, kept] = control(descriptor || {})
  const words = ['tool', 'call']
  if (typeof plain.toolId === 'string') words.push(quote(plain.toolId))
  for (const [key, flag] of [['source', 'source'], ['name', 'name'], ['server', 'server'], ['nodeId', 'node-id']]) {
    if (typeof plain[key] === 'string') words.push(`--${flag}`, quote(plain[key]))
  }
  const values = {}
  if (typeof plain.argsJson === 'string') {
    words.push('--args', quote(plain.argsJson))
  } else if (plain.args !== undefined) {
    words.push('--args', '@args')
    values.args = plain.args
  }
  return { command: words.join(' '), ...(Object.keys(values).length ? { values } : {}), ...kept }
}

/** `ctl tool search` arguments for former search_tools arguments. */
export function ctlToolSearch(args) {
  const [plain, kept] = control(args || {})
  const words = ['tool', 'search']
  if (typeof plain.query === 'string' && plain.query.trim()) words.push(...plain.query.trim().split(/\s+/).map(quote))
  for (const source of plain.sources || []) words.push('--source', quote(source))
  if (typeof plain.server === 'string') words.push('--server', quote(plain.server))
  if (typeof plain.nodeId === 'string') words.push('--node-id', quote(plain.nodeId))
  if (plain.limit !== undefined) words.push('--limit', String(plain.limit))
  if (plain.includeSchema === false) words.push('--no-schema')
  return { command: words.join(' '), ...kept }
}

/**
 * The call a mock model makes for a tool name and arguments written in the former direct form:
 * native declarations stay as they are; call_tool, search_tools and builtins with a ctl command
 * go through ctl with the same target and arguments.
 */
export function modelCall(name, args = {}) {
  if (NATIVE_TOOLS.has(name) || !(CTL_BUILTINS.has(name) || name === 'call_tool' || name === 'search_tools')) return { name, args }
  if (name === 'call_tool') return { name: 'ctl', args: ctlToolCall(args) }
  if (name === 'search_tools') return { name: 'ctl', args: ctlToolSearch(args) }
  const [plain, kept] = control(args)
  return { name: 'ctl', args: { ...ctlToolCall({ toolId: `builtin:${name}`, args: plain }), ...kept } }
}

/** A Responses `function_call` output item for a mock model call in the former direct form. */
export function functionCall(id, name, args = {}) {
  const call = modelCall(name, args)
  return { type: 'function_call', call_id: id, name: call.name, arguments: JSON.stringify(call.args) }
}

/** A Responses `function_call` item with the name and arguments exactly as given. */
export function directFunctionCall(id, name, args = {}) {
  return { type: 'function_call', call_id: id, name, arguments: JSON.stringify(args) }
}

/**
 * The call builder for a Main runtime: the retained TypeScript reference (`source`) still
 * declares the former tools directly; the C# Main reaches them through ctl.
 */
export const functionCallFor = runtime => (runtime === 'source' ? directFunctionCall : functionCall)

/** Maps `{ id, name, args }` call plans written in the former direct form to their model calls. */
export const ctlCalls = calls => calls.map(call => ({ ...call, ...modelCall(call.name, call.args) }))

/** Splits a ctl command hint into words (single and double quotes, backslash escapes). */
export function ctlWords(command) {
  const words = []
  let word = null, quote = null
  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (quote === "'") { if (char === "'") quote = null; else word += char; continue }
    if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '\\' && index + 1 < command.length && '"\\$`'.includes(command[index + 1])) word += command[++index]
      else word += char
      continue
    }
    if (/\s/.test(char)) { if (word !== null) words.push(word); word = null; continue }
    word ??= ''
    if (char === "'" || char === '"') quote = char
    else if (char === '\\' && index + 1 < command.length) word += command[++index]
    else word += char
  }
  if (word !== null) words.push(word)
  return words
}

/** Positional words and `--flag value` options of a ctl command hint. */
export function ctlHint(command) {
  const words = ctlWords(command), positional = [], options = {}
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    if (word.startsWith('--')) {
      const equals = word.indexOf('=')
      if (equals > 0) options[word.slice(2, equals)] = word.slice(equals + 1)
      else options[word.slice(2)] = words[++index]
    } else positional.push(word)
  }
  return { positional, options }
}
