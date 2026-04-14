function stringifyModelToolValue(value: unknown): string {
  if (value === undefined || value === null) {
    return String(value);
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable object]';
    }
  }

  return String(value);
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
    return stringifyModelToolValue(response);
  }

  const entries = Object.entries(response as Record<string, unknown>);
  if (entries.length === 0) {
    return '{}';
  }

  if (entries.length === 1 && entries[0][0] === 'output') {
    return stringifyModelToolValue(entries[0][1]);
  }

  return entries
    .map(([key, value]) => `${key}: ${stringifyModelToolValue(value)}`)
    .join('\n');
}