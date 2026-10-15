import yaml from 'js-yaml'

const YAML_OPTIONS = {
  flowLevel: 1,
  lineWidth: -1,
  noRefs: true,
  sortKeys: false,
} as const

const YAML_FLOW_OPTIONS = {
  ...YAML_OPTIONS,
  flowLevel: 0,
} as const

function dumpYaml(value: unknown, flowOnly = false): string {
  return yaml.dump(value, flowOnly ? YAML_FLOW_OPTIONS : YAML_OPTIONS).trimEnd()
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

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

  return dumpYaml(value, !isPlainObject(value))
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
  if (!isPlainObject(response) || response.truncated === true
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
      : yaml.dump(result, { ...YAML_OPTIONS, flowLevel: -1 }).trimEnd())
  }
  sections.push(`---\n${yaml.dump(metadata, { ...YAML_OPTIONS, flowLevel: -1 }).trimEnd()}`)
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