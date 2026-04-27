import type { ReactNode } from 'react'
import { inferSimpleLanguage, type SimpleLanguage } from '../utils/languages'

const tokenClass = {
  comment: 'text-gray-500 dark:text-gray-500 italic',
  string: 'text-emerald-700 dark:text-emerald-300',
  number: 'text-blue-700 dark:text-blue-300',
  keyword: 'text-purple-700 dark:text-purple-300 font-semibold',
  literal: 'text-sky-700 dark:text-sky-300 font-semibold',
  heading: 'text-gray-950 dark:text-gray-100 font-semibold',
  tag: 'text-rose-700 dark:text-rose-300',
  attr: 'text-amber-700 dark:text-amber-300',
  property: 'text-cyan-700 dark:text-cyan-300',
} as const

type TokenKind = keyof typeof tokenClass

const keywordPattern = (words: string[]) => `\\b(?:${words.join('|')})\\b`

const JS_TS_KEYWORDS = [
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let', 'namespace', 'new', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'set', 'static', 'super', 'switch', 'throw', 'try', 'type', 'typeof', 'var', 'void', 'while', 'with', 'yield'
]
const PYTHON_KEYWORDS = ['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']
const GO_KEYWORDS = ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var']
const RUST_KEYWORDS = ['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'Self', 'static', 'struct', 'super', 'trait', 'type', 'unsafe', 'use', 'where', 'while']
const C_FAMILY_KEYWORDS = ['auto', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'do', 'else', 'enum', 'extern', 'false', 'finally', 'for', 'friend', 'if', 'inline', 'namespace', 'new', 'operator', 'private', 'protected', 'public', 'return', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typename', 'using', 'virtual', 'void', 'volatile', 'while']
const JAVA_KEYWORDS = ['abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while']
const SQL_KEYWORDS = ['alter', 'and', 'as', 'by', 'case', 'create', 'delete', 'desc', 'distinct', 'drop', 'else', 'end', 'from', 'group', 'having', 'in', 'insert', 'into', 'is', 'join', 'left', 'limit', 'not', 'null', 'on', 'or', 'order', 'outer', 'right', 'select', 'set', 'table', 'then', 'union', 'update', 'values', 'when', 'where']

function buildCodeRegex(language: SimpleLanguage): RegExp | null {
  if (language === 'plaintext') return null
  if (language === 'html' || language === 'xml') return /(<!--[\s\S]*?-->|<\/?[A-Za-z][^>\s/]*(?:\s+[^>]*)?\/?>|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g
  if (language === 'json') return /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b|\b(?:true|false|null)\b)/g
  if (language === 'css') return /(\/\*[\s\S]*?\*\/|#[0-9a-fA-F]{3,8}\b|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[.#]?[A-Za-z_-][\w-]*(?=\s*:)|-?\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|%|s|ms)?\b|\b(?:important|inherit|initial|unset|auto|none|block|inline|flex|grid|absolute|relative|fixed|sticky)\b)/g
  if (language === 'markdown') return /(<!--[\s\S]*?-->|`[^`]*`|\*\*[^*]+\*\*|^\s{0,3}#{1,6}\s.*$|\[[^\]]+\]\([^)]*\))/gm
  if (language === 'yaml') return /(#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|^\s*[A-Za-z0-9_.-]+(?=\s*:)|\b(?:true|false|null|yes|no|on|off)\b|-?\b\d+(?:\.\d+)?\b)/gm
  if (language === 'shell' || language === 'dockerfile') return /(#.*$|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$\{?[A-Za-z_][\w]*\}?|\b(?:ARG|CMD|COPY|DO|ELSE|ENV|EXPOSE|FI|FOR|FROM|RUN|WORKDIR|case|do|done|elif|else|esac|export|fi|for|function|if|in|local|then|while)\b|-?\b\d+(?:\.\d+)?\b)/gm

  const keywords = language === 'python'
    ? PYTHON_KEYWORDS
    : language === 'go'
      ? GO_KEYWORDS
      : language === 'rust'
        ? RUST_KEYWORDS
        : language === 'cpp' || language === 'csharp'
          ? C_FAMILY_KEYWORDS
          : language === 'java'
            ? JAVA_KEYWORDS
            : language === 'sql'
              ? SQL_KEYWORDS
              : JS_TS_KEYWORDS

  return new RegExp(
    '(//.*$|/\\*[\\s\\S]*?\\*/|"(?:\\\\.|[^"\\\\])*"|\'(?:\\\\.|[^\'\\\\])*\'|`(?:\\\\.|[^`\\\\])*`|' +
      keywordPattern(keywords) +
      '|-?\\b\\d+(?:\\.\\d+)?\\b)',
    'gm'
  )
}

function classifyToken(language: SimpleLanguage, value: string): TokenKind {
  if (language === 'markdown' && /^\s{0,3}#{1,6}\s/.test(value)) return 'heading'
  if (value.startsWith('//') || value.startsWith('#') || value.startsWith('/*') || value.startsWith('<!--')) return 'comment'
  if (value.startsWith('"') || value.startsWith("'") || value.startsWith('`')) {
    if (language === 'json' && /"$/.test(value)) return 'property'
    return 'string'
  }
  if (/^-?\d/.test(value) || /^#[0-9a-fA-F]/.test(value)) return 'number'
  if (/^<\/?/.test(value)) return 'tag'
  if (language === 'css' && /^[.#]?[A-Za-z_-][\w-]*$/.test(value)) return 'property'
  if (language === 'yaml' && /^[\sA-Za-z0-9_.-]+$/.test(value) && value.trim() === value) return 'property'
  if (/^(?:true|false|null|yes|no|on|off)$/i.test(value)) return 'literal'
  if (/^\$/.test(value)) return 'property'
  return 'keyword'
}

export function SyntaxHighlightedText({ text, filePath }: { text: string; filePath?: string }): ReactNode {
  const language = inferSimpleLanguage(filePath)
  const regex = buildCodeRegex(language)

  if (!regex || !text) return <>{text}</>

  const nodes: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    const value = match[0]
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index))
    }
    nodes.push(<span key={`${match.index}-${nodes.length}`} className={tokenClass[classifyToken(language, value)]}>{value}</span>)
    lastIndex = match.index + value.length

    if (value.length === 0) regex.lastIndex++
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex))
  return <>{nodes}</>
}
