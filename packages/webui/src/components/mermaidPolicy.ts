const FORBIDDEN_RESOURCE_KEYS = new Set(['img', 'link', 'href'])

type MetadataPolicyFinding = 'resource-key' | 'unreliable-key'

const inspectMetadataProperty = (property: string): MetadataPolicyFinding | null => {
  const trimmed = property.trim()
  if (!trimmed) return null

  const openingQuote = trimmed[0]
  if (openingQuote === '"' || openingQuote === "'") {
    let escaped = false
    let hasEscape = false
    let closingIndex = -1
    for (let index = 1; index < trimmed.length; index += 1) {
      const character = trimmed[index]
      if (escaped) {
        escaped = false
        continue
      }
      if (character === '\\') {
        escaped = true
        hasEscape = true
        continue
      }
      if (character === openingQuote) {
        closingIndex = index
        break
      }
    }

    if (closingIndex < 0 || !/^\s*:/.test(trimmed.slice(closingIndex + 1))) return 'unreliable-key'
    if (hasEscape) return 'unreliable-key'
    return FORBIDDEN_RESOURCE_KEYS.has(trimmed.slice(1, closingIndex).toLowerCase()) ? 'resource-key' : null
  }

  const bareKey = /^([A-Za-z_$][\w$-]*)\s*:/.exec(trimmed)
  if (!bareKey) return 'unreliable-key'
  return FORBIDDEN_RESOURCE_KEYS.has(bareKey[1].toLowerCase()) ? 'resource-key' : null
}

const inspectMetadataProperties = (body: string): MetadataPolicyFinding | null => {
  let propertyStart = 0
  let quote = ''
  let escaped = false
  let nestedDepth = 0

  const inspectProperty = (end: number): MetadataPolicyFinding | null => (
    inspectMetadataProperty(body.slice(propertyStart, end))
  )

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
      const finding = inspectProperty(index)
      if (finding) return finding
      propertyStart = index + 1
    }
  }

  return inspectProperty(body.length)
}

const findMetadataObjectOpening = (source: string, startIndex: number): number => {
  let quote = ''
  let escaped = false
  let comment = false

  for (let index = startIndex; index < source.length; index += 1) {
    const character = source[index]
    if (comment) {
      if (character === '\n' || character === '\r') comment = false
      else continue
    }
    if (quote) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === quote) quote = ''
      continue
    }
    if (character === '%' && source[index + 1] === '%') {
      comment = true
      index += 1
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '@' && source[index + 1] === '{') return index
  }

  return -1
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

const inspectMermaidMetadata = (source: string): MetadataPolicyFinding | null => {
  let searchIndex = 0
  while (searchIndex < source.length) {
    const openingIndex = findMetadataObjectOpening(source, searchIndex)
    if (openingIndex < 0) return null
    const closingIndex = findMetadataObjectEnd(source, openingIndex)
    if (closingIndex < 0) return 'unreliable-key'
    const finding = inspectMetadataProperties(source.slice(openingIndex + 2, closingIndex))
    if (finding) return finding
    searchIndex = closingIndex + 1
  }
  return null
}

export const getMermaidSourcePolicyError = (source: string): string | null => {
  const trimmed = source.trimStart()
  if (/^---(?:\r?\n|$)/.test(trimmed)) return 'Mermaid frontmatter is disabled.'
  if (/%%\s*\{/i.test(source)) return 'Mermaid configuration directives are disabled.'
  const metadataFinding = inspectMermaidMetadata(source)
  if (metadataFinding === 'resource-key') return 'Mermaid image and link resources are disabled.'
  if (metadataFinding === 'unreliable-key') return 'Escaped or unrecognized Mermaid metadata property keys are disabled.'
  if (/(?:^|[;\r\n])\s*(?:click|href)[\t ]+/i.test(source)) return 'Interactive Mermaid links are disabled.'
  if (/(?:^|[;\r\n])\s*(?:style|classDef|linkStyle)[\t ]+/i.test(source)) return 'Custom Mermaid styling directives are disabled.'
  if (/(?:<\/?\s*(?:a|img|image|link|script|style|iframe|foreignObject)\b|@import\b)/i.test(source)) return 'Embedded Mermaid resources are disabled.'
  return null
}
