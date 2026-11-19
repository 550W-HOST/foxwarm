import { dumpToolYaml } from './toolResponseYaml'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Model-facing and WebUI text of a structured tool value. Strings are returned as they are; a
 * mapping or sequence is YAML with the `readable` layout: one line per top-level entry or item,
 * block sequences for top-level arrays, flow style below, and literal blocks for multi-line text.
 */
export function formatStructuredValue(value: unknown): string {
  if (value === undefined || value === null) {
    return ''
  }

  if (typeof value === 'string') {
    return value
  }

  if (!isPlainObject(value) && !Array.isArray(value)) {
    return String(value)
  }

  return dumpToolYaml(value, 'readable')
}

export function formatToolResponsePayload(response: unknown): string {
  if (isPlainObject(response)) {
    const entries = Object.entries(response)
    if (entries.length === 1 && entries[0][0] === 'output') {
      return formatStructuredValue(entries[0][1])
    }
  }

  return formatStructuredValue(response)
}

/** Render a cleaned outer ToolScript execution result without changing its native value. */
export function formatToolScriptExecutionResponse(response: unknown): string {
  // Guard summaries and historical pruned responses already carry their excerpt.
  if (!isPlainObject(response) || response.truncated === true || response.outputTruncated === true
    || (response.output !== undefined && response.result === undefined && response.stdout === undefined)) {
    return formatToolResponsePayload(response)
  }

  const { stdout, result, output: _imageLabel, ...metadata } = response
  const sections: string[] = []
  const appendSection = (label: string, text: string) => {
    sections.push(`--- ${label} ---\n${text}${text.endsWith('\n') ? '' : '\n'}`)
  }
  if (typeof stdout === 'string' && stdout.length > 0) appendSection('print', stdout)
  if (result !== undefined) {
    appendSection('return', typeof result === 'string'
      ? result
      : dumpToolYaml(result, -1))
  }
  sections.push(`---\n${dumpToolYaml(metadata, -1)}`)
  return sections.join('')
}

export function formatCompactObjectPreview(response: unknown): string {
  if (isPlainObject(response)) {
    const entries = Object.entries(response)
    if (entries.length === 1) {
      return formatStructuredValue(entries[0][1])
    }
  }

  return formatStructuredValue(response)
}