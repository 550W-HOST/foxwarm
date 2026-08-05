const FORBIDDEN_RESOURCE_KEYS = new Set(['img', 'link', 'href'])

const readQuotedKey = (raw: string): string | null => {
  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'string' ? parsed : null
    } catch {
      return null
    }
  }

  if (!raw.startsWith("'") || !raw.endsWith("'")) return null
  let value = ''
  for (let index = 1; index < raw.length - 1; index += 1) {
    const character = raw[index]
    if (character === '\\' && index + 1 < raw.length - 1) {
      index += 1
      value += raw[index]
    } else {
      value += character
    }
  }
  return value
}

const metadataPropertyKey = (property: string): string | null => {
  const match = /^\s*((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*')|(?:[A-Za-z_$][\w$-]*))\s*:/.exec(property)
  if (!match) return null
  const rawKey = match[1]
  return rawKey.startsWith('"') || rawKey.startsWith("'") ? readQuotedKey(rawKey) : rawKey
}

const hasForbiddenMetadataProperty = (body: string): boolean => {
  let propertyStart = 0
  let quote = ''
  let escaped = false
  let nestedDepth = 0

  const checkProperty = (end: number): boolean => {
    const key = metadataPropertyKey(body.slice(propertyStart, end))
    return key !== null && FORBIDDEN_RESOURCE_KEYS.has(key.toLowerCase())
  }

  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '{' || character === '[' || character === '(') nestedDepth += 1
    else if (character === '}' || character === ']' || character === ')') nestedDepth = Math.max(0, nestedDepth - 1)
    else if (character === ',' && nestedDepth === 0) {
      if (checkProperty(index)) return true
      propertyStart = index + 1
    }
  }

  return checkProperty(body.length)
}

const findMetadataObjectEnd = (source: string, openingIndex: number): number => {
  let depth = 1
  let quote = ''
  let escaped = false

  for (let index = openingIndex + 2; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }

  return -1
}

const hasForbiddenMermaidMetadata = (source: string): boolean => {
  let searchIndex = 0
  while (searchIndex < source.length) {
    const openingIndex = source.indexOf('@{', searchIndex)
    if (openingIndex < 0) return false
    const closingIndex = findMetadataObjectEnd(source, openingIndex)
    if (closingIndex < 0) return false
    if (hasForbiddenMetadataProperty(source.slice(openingIndex + 2, closingIndex))) return true
    searchIndex = closingIndex + 1
  }
  return false
}

export const getMermaidSourcePolicyError = (source: string): string | null => {
  const trimmed = source.trimStart()
  if (/^---(?:\r?\n|$)/.test(trimmed)) return 'Mermaid frontmatter is disabled.'
  if (/%%\s*\{/i.test(source)) return 'Mermaid configuration directives are disabled.'
  if (hasForbiddenMermaidMetadata(source)) return 'Mermaid image and link resources are disabled.'
  if (/(?:^|[;\r\n])\s*(?:click|href)[\t ]+/i.test(source)) return 'Interactive Mermaid links are disabled.'
  if (/(?:^|[;\r\n])\s*(?:style|classDef|linkStyle)[\t ]+/i.test(source)) return 'Custom Mermaid styling directives are disabled.'
  if (/(?:<\/?\s*(?:a|img|image|link|script|style|iframe|foreignObject)\b|@import\b)/i.test(source)) return 'Embedded Mermaid resources are disabled.'
  return null
}
