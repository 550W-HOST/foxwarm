import yaml from 'js-yaml';

const YAML_OPTIONS = {
  flowLevel: 1,
  lineWidth: -1,
  noRefs: true,
  sortKeys: false,
} as const;

const YAML_FLOW_OPTIONS = {
  ...YAML_OPTIONS,
  flowLevel: 0,
} as const;

function dumpYaml(value: unknown, flowOnly = false): string {
  return yaml.dump(value, flowOnly ? YAML_FLOW_OPTIONS : YAML_OPTIONS).trimEnd();
}

function formatOutputOnlyValue(value: unknown): string {
  if (value === undefined || value === null) {
    return String(value);
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  return dumpYaml(value, true);
}

export function formatToolResponseForModel(response: unknown): string {
  if (response === undefined || response === null) {
    return '';
  }

  if (typeof response === 'string') {
    return response;
  }

  if (typeof response !== 'object') {
    return String(response);
  }

  if (Array.isArray(response)) {
    return dumpYaml(response, true);
  }

  const entries = Object.entries(response as Record<string, unknown>);
  if (entries.length === 0) {
    return '{}';
  }

  if (entries.length === 1 && entries[0][0] === 'output') {
    return formatOutputOnlyValue(entries[0][1]);
  }

  return dumpYaml(response);
}