// YAML text for tool results, shared by model requests and the WebUI.
//
// This is the js-yaml 4.1.1 dumper restricted to JSON values and the options the formatter uses
// (indent 2, lineWidth -1, noRefs, unsorted keys, single quoting, compat mode), with two changes:
//   - the layout of each collection is decided per node (see `ToolYamlLayout`), and
//   - a multi-line string in a block position is always a literal block, even when it contains
//     characters js-yaml would only write escaped (tabs, carriage returns, control characters).
// The C# port in dotnet/Foxwarm/Tools/ToolResponseFormatting.cs must produce identical text;
// toolResponseFormatting.fixtures.json is run against both implementations.

/**
 * `readable`: the root collection is block; a top-level mapping entry whose value is a non-empty
 * array is a block sequence; each top-level entry, top-level sequence item or item of such an
 * entry sequence that contains a multi-line string is block all the way down; everything else is
 * flow. A number is js-yaml's `flowLevel`: block below that depth, flow from it (-1: all block).
 */
export type ToolYamlLayout = 'readable' | number

type Style = { block: boolean; full: boolean }

const ESCAPE_SEQUENCES: Record<number, string> = {
  0x00: '\\0',
  0x07: '\\a',
  0x08: '\\b',
  0x09: '\\t',
  0x0A: '\\n',
  0x0B: '\\v',
  0x0C: '\\f',
  0x0D: '\\r',
  0x1B: '\\e',
  0x22: '\\"',
  0x5C: '\\\\',
  0x85: '\\N',
  0xA0: '\\_',
  0x2028: '\\L',
  0x2029: '\\P',
}

const DEPRECATED_BOOLEANS = new Set([
  'y', 'Y', 'yes', 'Yes', 'YES', 'on', 'On', 'ON',
  'n', 'N', 'no', 'No', 'NO', 'off', 'Off', 'OFF',
])
const DEPRECATED_BASE60 = /^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$/
const YAML_FLOAT = /^(?:[-+]?(?:[0-9][0-9_]*)(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/
const YAML_DATE = /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/
const YAML_TIMESTAMP = /^[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?$/
const SCIENTIFIC_WITHOUT_DOT = /^[-+]?[0-9]+e/

export function dumpToolYaml(value: unknown, layout: ToolYamlLayout): string {
  return writeNode(layout, 0, value, true, true, false, decide(layout, 0, value, false, false)) ?? ''
}

export function containsMultilineString(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('\n')
  if (Array.isArray(value)) return value.some(containsMultilineString)
  if (value !== null && typeof value === 'object') return Object.values(value).some(containsMultilineString)
  return false
}

function decide(layout: ToolYamlLayout, level: number, value: unknown, parentIsSequence: boolean, full: boolean): Style {
  if (layout !== 'readable') return { block: layout < 0 || layout > level, full: false }
  if (full || level === 0) return { block: true, full }
  if (level === 1 && !parentIsSequence && Array.isArray(value)) return { block: true, full: false }
  if (containsMultilineString(value)) return { block: true, full: true }
  return { block: false, full: false }
}

function indent(level: number): string {
  return '\n' + ' '.repeat(2 * level)
}

function writeNode(layout: ToolYamlLayout, level: number, value: unknown, inblock: boolean, compact: boolean,
  iskey: boolean, style: Style): string | undefined {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return representNumber(value)
  if (typeof value === 'string') return writeScalar(value, level, inblock, iskey || !style.block)
  if (Array.isArray(value)) {
    return style.block && value.length !== 0
      ? writeBlockSequence(layout, level, value, compact, style.full)
      : writeFlowSequence(layout, level, value)
  }
  if (typeof value === 'object') {
    const object = value as Record<string, unknown>
    return style.block && Object.keys(object).length !== 0
      ? writeBlockMapping(layout, level, object, compact, style.full)
      : writeFlowMapping(layout, level, object)
  }
  return undefined
}

function writeFlowSequence(layout: ToolYamlLayout, level: number, items: unknown[]): string {
  const written: string[] = []
  for (const item of items) {
    const dump = writeNode(layout, level, item === undefined ? null : item, false, false, false, { block: false, full: false })
    if (dump !== undefined) written.push(dump)
  }
  return '[' + written.join(', ') + ']'
}

function writeBlockSequence(layout: ToolYamlLayout, level: number, items: unknown[], compact: boolean, full: boolean): string {
  let result = ''
  for (const original of items) {
    const item = original === undefined ? null : original
    const dump = writeNode(layout, level + 1, item, true, true, false, decide(layout, level + 1, item, true, full))
    if (dump === undefined) continue
    if (!compact || result !== '') result += indent(level)
    result += dump.charCodeAt(0) === 0x0A ? '-' : '- '
    result += dump
  }
  return result || '[]'
}

function writeFlowMapping(layout: ToolYamlLayout, level: number, object: Record<string, unknown>): string {
  let result = ''
  for (const key of Object.keys(object)) {
    let pair = result !== '' ? ', ' : ''
    const keyDump = writeNode(layout, level, key, false, false, false, { block: false, full: false })!
    if (keyDump.length > 1024) pair += '? '
    const valueDump = writeNode(layout, level, object[key], false, false, false, { block: false, full: false })
    if (valueDump === undefined) continue
    result += pair + keyDump + ': ' + valueDump
  }
  return '{' + result + '}'
}

function writeBlockMapping(layout: ToolYamlLayout, level: number, object: Record<string, unknown>, compact: boolean,
  full: boolean): string {
  let result = ''
  for (const key of Object.keys(object)) {
    let pair = !compact || result !== '' ? indent(level) : ''
    const value = object[key]
    const keyDump = writeNode(layout, level + 1, key, true, true, true, { block: false, full: false })!
    const explicitPair = keyDump.length > 1024
    if (explicitPair) pair += keyDump.charCodeAt(0) === 0x0A ? '?' : '? '
    pair += keyDump
    if (explicitPair) pair += indent(level)
    const valueDump = writeNode(layout, level + 1, value, true, explicitPair, false,
      decide(layout, level + 1, value, false, full))
    if (valueDump === undefined) continue
    pair += valueDump.charCodeAt(0) === 0x0A ? ':' : ': '
    result += pair + valueDump
  }
  return result || '{}'
}

function representNumber(value: number): string {
  if (value % 1 === 0 && !Object.is(value, -0)) return value.toString(10)
  if (Number.isNaN(value)) return '.nan'
  if (value === Number.POSITIVE_INFINITY) return '.inf'
  if (value === Number.NEGATIVE_INFINITY) return '-.inf'
  if (Object.is(value, -0)) return '-0.0'
  const text = value.toString(10)
  return SCIENTIFIC_WITHOUT_DOT.test(text) ? text.replace('e', '.e') : text
}

const enum ScalarStyle { Plain, Single, Literal, Double }

function writeScalar(text: string, level: number, inblock: boolean, singleLineOnly: boolean): string {
  if (text.length === 0) return "''"
  if (DEPRECATED_BOOLEANS.has(text) || DEPRECATED_BASE60.test(text)) return "'" + text + "'"
  switch (chooseScalarStyle(text, singleLineOnly, inblock)) {
    case ScalarStyle.Plain:
      return text
    case ScalarStyle.Single:
      return "'" + text.replace(/'/g, "''") + "'"
    case ScalarStyle.Literal:
      return '|' + blockHeader(text) + dropEndingNewline(indentString(text, 2 * Math.max(1, level)))
    default:
      return '"' + escapeString(text) + '"'
  }
}

function chooseScalarStyle(text: string, singleLineOnly: boolean, inblock: boolean): ScalarStyle {
  if (!singleLineOnly && text.includes('\n')) return ScalarStyle.Literal
  let plain = isPlainSafeFirst(codePointAt(text, 0)) && isPlainSafeLast(codePointAt(text, text.length - 1))
  let previous = -1
  for (let index = 0; index < text.length;) {
    const char = codePointAt(text, index)
    if (!isPrintable(char)) return ScalarStyle.Double
    plain = plain && isPlainSafe(char, previous, inblock)
    previous = char
    index += char >= 0x10000 ? 2 : 1
  }
  return plain && !testImplicitResolving(text) ? ScalarStyle.Plain : ScalarStyle.Single
}

function blockHeader(text: string): string {
  const indentIndicator = /^\n* /.test(text) ? '2' : ''
  const clip = text[text.length - 1] === '\n'
  const keep = clip && (text[text.length - 2] === '\n' || text === '\n')
  return indentIndicator + (keep ? '+' : clip ? '' : '-') + '\n'
}

function dropEndingNewline(text: string): string {
  return text[text.length - 1] === '\n' ? text.slice(0, -1) : text
}

// Indents every line; empty lines (\n only) are not indented.
function indentString(text: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  let result = ''
  let position = 0
  while (position < text.length) {
    const next = text.indexOf('\n', position)
    const line = next === -1 ? text.slice(position) : text.slice(position, next + 1)
    position = next === -1 ? text.length : next + 1
    if (line.length && line !== '\n') result += prefix
    result += line
  }
  return result
}

function escapeString(text: string): string {
  let result = ''
  for (let index = 0; index < text.length;) {
    const char = codePointAt(text, index)
    const escape = ESCAPE_SEQUENCES[char]
    if (!escape && isPrintable(char)) {
      result += text[index]
      if (char >= 0x10000) result += text[index + 1]
    } else {
      result += escape || encodeHex(char)
    }
    index += char >= 0x10000 ? 2 : 1
  }
  return result
}

function encodeHex(char: number): string {
  const hex = char.toString(16).toUpperCase()
  const [handle, length] = char <= 0xFF ? ['x', 2] : char <= 0xFFFF ? ['u', 4] : ['U', 8]
  return '\\' + handle + '0'.repeat(length - hex.length) + hex
}

function codePointAt(text: string, position: number): number {
  const first = text.charCodeAt(position)
  if (first >= 0xD800 && first <= 0xDBFF && position + 1 < text.length) {
    const second = text.charCodeAt(position + 1)
    if (second >= 0xDC00 && second <= 0xDFFF) return (first - 0xD800) * 0x400 + second - 0xDC00 + 0x10000
  }
  return first
}

function isWhitespace(char: number): boolean {
  return char === 0x20 || char === 0x09
}

function isPrintable(char: number): boolean {
  return (0x20 <= char && char <= 0x7E)
    || (0xA1 <= char && char <= 0xD7FF && char !== 0x2028 && char !== 0x2029)
    || (0xE000 <= char && char <= 0xFFFD && char !== 0xFEFF)
    || (0x10000 <= char && char <= 0x10FFFF)
}

function isNsCharOrWhitespace(char: number): boolean {
  return isPrintable(char) && char !== 0xFEFF && char !== 0x0D && char !== 0x0A
}

function isPlainSafe(char: number, previous: number, inblock: boolean): boolean {
  const charIsNsCharOrWhitespace = isNsCharOrWhitespace(char)
  const charIsNsChar = charIsNsCharOrWhitespace && !isWhitespace(char)
  return (
    (inblock
      ? charIsNsCharOrWhitespace
      : charIsNsCharOrWhitespace && char !== 0x2C && char !== 0x5B && char !== 0x5D && char !== 0x7B && char !== 0x7D)
    && char !== 0x23
    && !(previous === 0x3A && !charIsNsChar)
  )
    || (isNsCharOrWhitespace(previous) && !isWhitespace(previous) && char === 0x23)
    || (previous === 0x3A && charIsNsChar)
}

function isPlainSafeFirst(char: number): boolean {
  return isPrintable(char) && char !== 0xFEFF && !isWhitespace(char)
    && !'-?:,[]{}#&*!|=>\'"%@`'.includes(String.fromCharCode(char))
}

function isPlainSafeLast(char: number): boolean {
  return !isWhitespace(char) && char !== 0x3A
}

function testImplicitResolving(text: string): boolean {
  return text === '~' || text === 'null' || text === 'Null' || text === 'NULL'
    || text === 'true' || text === 'True' || text === 'TRUE'
    || text === 'false' || text === 'False' || text === 'FALSE'
    || resolvesInteger(text)
    || (YAML_FLOAT.test(text) && text[text.length - 1] !== '_')
    || YAML_DATE.test(text) || YAML_TIMESTAMP.test(text)
    || text === '<<'
}

function resolvesInteger(text: string): boolean {
  const max = text.length
  let index = 0
  let hasDigits = false
  if (!max) return false
  let char = text[index]
  if (char === '-' || char === '+') char = text[++index]
  if (char === '0') {
    if (index + 1 === max) return true
    char = text[++index]
    const radix = char === 'b' ? /[01]/ : char === 'x' ? /[0-9A-Fa-f]/ : char === 'o' ? /[0-7]/ : undefined
    if (radix) {
      for (index++; index < max; index++) {
        char = text[index]
        if (char === '_') continue
        if (!radix.test(char)) return false
        hasDigits = true
      }
      return hasDigits && char !== '_'
    }
  }
  if (char === '_') return false
  for (; index < max; index++) {
    char = text[index]
    if (char === '_') continue
    if (!(char >= '0' && char <= '9')) return false
    hasDigits = true
  }
  return hasDigits && char !== '_'
}
