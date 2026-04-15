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

export function formatCompactObjectPreview(response: unknown): string {
  if (isPlainObject(response)) {
    const entries = Object.entries(response)
    if (entries.length === 1) {
      return formatStructuredValue(entries[0][1])
    }
  }

  return formatStructuredValue(response)
}