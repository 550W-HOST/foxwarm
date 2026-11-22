import registry from '../../../dotnet/Foxwarm/Tools/Ctl/CtlCommands.json'

/**
 * Display-only reading of a `ctl` call: the canonical tool it names, in the shape of the
 * former unified `call_tool` descriptor, so existing timeline, activity and card projections
 * apply unchanged. Main resolves and authorizes commands; this grants nothing.
 */
interface Parameter { name: string; arg?: string; type: string; items?: string; kind?: string; variadic?: boolean }
interface Command { path: string; aliases?: string[]; ingress?: string[]; target: { source?: string; name?: string; fixed?: Record<string, unknown>; local?: string }; params?: Parameter[] }

const commands = (registry as { commands: Command[] }).commands
const kebab = (name: string) => name.replace(/_/g, '-').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

function words(text: string): string[] | null {
  const result: string[] = []
  let index = 0
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index++
    if (index >= text.length) break
    let word = ''
    while (index < text.length && !/\s/.test(text[index])) {
      const char = text[index]
      if (char === "'") {
        const end = text.indexOf("'", index + 1)
        if (end < 0) return null
        word += text.slice(index + 1, end)
        index = end + 1
      } else if (char === '"') {
        index++
        let closed = false
        while (index < text.length) {
          if (text[index] === '"') { closed = true; index++; break }
          if (text[index] === '\\' && (text[index + 1] === '"' || text[index + 1] === '\\')) { word += text[index + 1]; index += 2; continue }
          word += text[index++]
        }
        if (!closed) return null
      } else if (char === '\\') {
        if (index + 1 >= text.length) return null
        word += text[index + 1]
        index += 2
      } else {
        word += char
        index++
      }
    }
    result.push(word)
  }
  return result
}

const valueOf = (token: string, values: Record<string, unknown>): unknown => {
  if (token.startsWith('@@')) return token.slice(1)
  if (/^@[A-Za-z_][A-Za-z0-9_-]*$/.test(token)) return values[token.slice(1)]
  return token
}

const typed = (parameter: Parameter, value: unknown, element = false): unknown => {
  if (typeof value !== 'string') return value
  const type = element ? parameter.items : parameter.type
  if (type === 'boolean') return value === 'true' ? true : value === 'false' ? false : value
  if (type === 'integer' || type === 'number') return Number.isFinite(Number(value)) && value.trim() ? Number(value) : value
  if (type === 'object' || type === 'json') { try { return JSON.parse(value) } catch { return value } }
  return value
}

/**
 * The value of JSON text that may still be arriving: complete text as it is, otherwise the
 * longest readable prefix with its open strings, arrays and objects closed. A string value
 * keeps the characters received so far; an unfinished key, number or literal is dropped.
 */
export function partialJson(text: string): unknown {
  try { return JSON.parse(text) } catch { /* Read the received prefix. */ }
  const stack: Array<{ close: '}' | ']'; key: boolean }> = []
  const closers = () => stack.map(frame => frame.close).reverse().join('')
  let safe = '', inString = false, isKey = false, escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    const top = stack[stack.length - 1]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') {
        inString = false
        if (!isKey) safe = text.slice(0, index + 1) + closers()
      }
    } else if (char === '"') {
      inString = true
      isKey = top?.close === '}' && top.key
    } else if (char === '{' || char === '[') {
      stack.push({ close: char === '{' ? '}' : ']', key: char === '{' })
      safe = text.slice(0, index + 1) + closers()
    } else if (char === '}' || char === ']') {
      stack.pop()
      safe = text.slice(0, index + 1) + closers()
    } else if (char === ',') {
      safe = text.slice(0, index) + closers()
      if (top?.close === '}') top.key = true
    } else if (char === ':' && top) top.key = false
  }
  const candidates = inString && !isKey
    ? [text.slice(0, escaped ? -1 : undefined).replace(/\\u[0-9a-fA-F]{0,3}$/, '') + '"' + closers()]
    : [text + closers()]
  for (const candidate of [...candidates, safe]) {
    try { return JSON.parse(candidate) } catch { /* Try the last complete prefix. */ }
  }
  return undefined
}

/** The arguments object of a ctl call, also while its JSON text is still streaming. */
const ctlArguments = (args: unknown): Record<string, unknown> | undefined => {
  const value = typeof args === 'string' ? partialJson(args) : args
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** The unified descriptor (toolId plus args) a ctl call names, or undefined for help and malformed commands. */
export function ctlDescriptor(args: Record<string, unknown> | string | undefined): Record<string, unknown> | undefined {
  return parse(args)?.descriptor
}

/** The registry command a ctl call runs and the descriptor it names; undefined for help, discovery and malformed commands. */
function parse(stored: Record<string, unknown> | string | undefined): { entry: Command; descriptor: Record<string, unknown> } | undefined {
  const args = ctlArguments(stored)
  if (!args || typeof args.command !== 'string') return undefined
  let values: Record<string, unknown> = {}
  if (args.values && typeof args.values === 'object' && !Array.isArray(args.values)) values = args.values as Record<string, unknown>
  else if (typeof args.valuesJson === 'string') values = ctlArguments(args.valuesJson) ?? {}
  let command = args.command.trimStart()
  if (/^ctl(\s|$)/.test(command)) command = command.slice(3).trimStart()
  const head = command.match(/^(\S+)\s+(\S+)/)
  if (!head) return undefined
  const entry = commands.find(item => item.path.split(' ')[0] === head[1] && (item.path.split(' ')[1] === head[2] || item.aliases?.includes(head[2])))
  if (!entry) return undefined
  const params = entry.params || []
  const restParam = params.find(parameter => parameter.kind === 'rest')
  const positionals = params.filter(parameter => parameter.kind === 'positional')
  const assigned: Record<string, unknown> = {}
  let remaining = command.slice(head[0].length)
  let next = 0, flagsEnded = false
  const fill = (parameter: Parameter, value: unknown) => {
    if (parameter.type === 'array') {
      const list = Array.isArray(assigned[parameter.name]) ? assigned[parameter.name] as unknown[] : []
      if (typeof value === 'string' && value.trim().startsWith('[')) { try { list.push(...JSON.parse(value)) } catch { list.push(value) } }
      else if (Array.isArray(value)) list.push(...value)
      else list.push(typed(parameter, value, true))
      assigned[parameter.name] = list
    } else assigned[parameter.name] = typed(parameter, value)
  }
  while (remaining.trim()) {
    remaining = remaining.trimStart()
    // A positional already given as an option is filled; use the next one.
    while (next < positionals.length && !positionals[next].variadic && positionals[next].name in assigned) next++
    if (restParam && next >= positionals.length && (flagsEnded || !remaining.startsWith('--'))) {
      const raw = remaining.trimEnd()
      assigned[restParam.name] = /^@[A-Za-z_][A-Za-z0-9_-]*$/.test(raw) ? values[raw.slice(1)] : raw.startsWith('@@') ? remaining.slice(1) : remaining
      break
    }
    const match = remaining.match(/^(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|\S)+/)
    if (!match) break
    remaining = remaining.slice(match[0].length)
    const token = words(match[0])?.[0]
    if (token === undefined) return undefined
    // An option needs its `--name=` prefix unquoted; quoting only its value keeps it an option.
    const quoteAt = match[0].search(/['"\\]/)
    const plain = quoteAt < 0 ? match[0].length : quoteAt
    const nameEnd = token.indexOf('=', 2) < 0 ? token.length : token.indexOf('=', 2) + 1
    if (!flagsEnded && quoteAt < 0 && token === '--') { flagsEnded = true; continue }
    if (!flagsEnded && token.startsWith('--') && token.length > 2 && plain >= nameEnd) {
      const body = token.slice(2), equals = body.indexOf('=')
      const flag = equals < 0 ? body : body.slice(0, equals)
      let parameter = params.find(item => kebab(item.name) === flag || item.name === flag)
      let value: unknown = equals < 0 ? undefined : valueOf(body.slice(equals + 1), values)
      if (!parameter && flag.startsWith('no-')) {
        parameter = params.find(item => item.type === 'boolean' && (kebab(item.name) === flag.slice(3) || item.name === flag.slice(3)))
        if (parameter) value = false
      }
      if (!parameter) return undefined
      if (value === undefined) {
        if (parameter.type === 'boolean') value = true
        else {
          remaining = remaining.trimStart()
          const following = remaining.match(/^(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|\S)+/)
          if (!following) return undefined
          remaining = remaining.slice(following[0].length)
          const word = words(following[0])?.[0]
          if (word === undefined) return undefined
          value = valueOf(word, values)
        }
      }
      fill(parameter, value)
      continue
    }
    const slot = positionals[next]
    if (!slot) return undefined
    const value = valueOf(token, values)
    if (slot.variadic) assigned[slot.name] = typeof assigned[slot.name] === 'string' ? `${assigned[slot.name]} ${value}` : value
    else { fill(slot, value); next++ }
  }
  const mapped: Record<string, unknown> = { ...(entry.target.fixed || {}) }
  for (const parameter of params) if (parameter.name in assigned) setPath(mapped, parameter.arg || parameter.name, assigned[parameter.name])
  if (entry.target.local === 'tool-call') return { entry, descriptor: { ...mapped, args: mapped.args ?? {} } }
  if (entry.target.local) return undefined
  return { entry, descriptor: { toolId: `${entry.target.source}:${entry.target.name}`, args: mapped } }
}

/** The identity and arguments a unified descriptor names. */
function target(descriptor: Record<string, unknown>): { source: string; name: string; args: Record<string, unknown> } {
  const toolId = typeof descriptor.toolId === 'string' ? descriptor.toolId.trim() : ''
  const colon = toolId.indexOf(':')
  const source = colon > 0 ? toolId.slice(0, colon) : String(descriptor.source ?? '').trim()
  const rest = toolId.slice(colon + 1)
  const name = colon <= 0 ? String(descriptor.name ?? '')
    : source === 'builtin' ? rest.trim()
      : rest.slice((source === 'mcp' ? rest.indexOf('/') : rest.lastIndexOf('/')) + 1).trim()
  const args = descriptor.args && typeof descriptor.args === 'object' && !Array.isArray(descriptor.args) ? descriptor.args as Record<string, unknown> : {}
  return { source, name, args }
}

const sameJson = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/** The model command that runs a builtin with these arguments: the one whose fixed arguments they carry, or its only command. */
function commandFor(builtin: string, args: Record<string, unknown>): Command | undefined {
  const candidates = commands.filter(item => item.target.source === 'builtin' && item.target.name === builtin && (item.ingress ?? ['model']).includes('model'))
  return candidates.find(item => item.target.fixed && Object.keys(item.target.fixed).length > 0
    && Object.entries(item.target.fixed).every(([key, value]) => sameJson(value, args[key])))
    ?? (candidates.length === 1 ? candidates[0] : undefined)
}

/**
 * The tag name of a stored ctl call: the command path (`memory edit`) of a command naming a
 * capability, the command path (or name) of a builtin given to `tool call`, and undefined for
 * an MCP or Node tool, which is shown like a direct call. `ctl` for help, discovery and
 * malformed commands. Display only, like `CtlParser.DisplayName` on Main.
 */
export function ctlCommandName(args: Record<string, unknown> | string | undefined): string | undefined {
  const parsed = parse(args)
  if (!parsed) return 'ctl'
  if (parsed.entry.target.local !== 'tool-call') return parsed.entry.path
  const { source, name, args: targetArgs } = target(parsed.descriptor)
  if (source !== 'builtin') return undefined
  return commandFor(name, targetArgs)?.path ?? name
}

/** Sets a target argument; a dotted path such as `model.modelId` fills a nested object. */
function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const parts = path.split('.')
  let current = target
  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== 'object' || Array.isArray(current[part])) current[part] = {}
    current = current[part] as Record<string, unknown>
  }
  current[parts[parts.length - 1]] = value
}

/**
 * The call a ctl command runs, for capability-specific rendering: builtin and Node tools under
 * their own name and arguments, MCP tools as a unified descriptor. Other calls are unchanged.
 */
export function ctlConcrete<T extends { name: string; args?: any }>(call: T): T {
  if (call.name !== 'ctl') return call
  const descriptor = ctlDescriptor(call.args)
  if (!descriptor) return call
  const { source, name, args } = target(descriptor)
  if ((source === 'builtin' || source === 'node') && name) return { ...call, name, args }
  return { ...call, name: 'call_tool', args: descriptor }
}

/** The command of a stored ctl call, shown beside the concrete call it runs. */
export const ctlCommandText = (call: { name: string; args?: any } | undefined): string | undefined => {
  const command = call?.name === 'ctl' ? ctlArguments(call.args)?.command : undefined
  return typeof command === 'string' ? command.replace(/\s+/g, ' ').trim() : undefined
}

/**
 * The summary a ctl call shows: its own `summary`, unless the tool it runs states one itself
 * (Node `exec`, builtin `run_script`), which the concrete card already shows. Display only, like
 * `ToolActivity.CaptionSummary` on Main.
 */
export function ctlSummary(call: { name: string; args?: any } | undefined): string | undefined {
  if (call?.name !== 'ctl') return undefined
  const summary = ctlArguments(call.args)?.summary
  if (typeof summary !== 'string' || !summary.trim()) return undefined
  const descriptor = ctlDescriptor(call.args)
  if (descriptor) {
    const { source, name, args } = target(descriptor)
    const own = (source === 'node' && name === 'exec') || (source === 'builtin' && name === 'run_script')
    if (own && typeof args.summary === 'string' && args.summary.trim()) return undefined
  }
  return summary
}

/** A ctl call naming a capability, shown through the former unified-call projection. */
export function ctlAsUnified<T extends { name: string; args?: any }>(call: T): T {
  if (call.name !== 'ctl') return call
  const descriptor = ctlDescriptor(call.args)
  return descriptor ? { ...call, name: 'call_tool', args: descriptor } : call
}
