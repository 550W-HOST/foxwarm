import { RpcError } from './rpc';

function invalid(message: string): never {
  throw new RpcError('SESSION_WORKER_INVALID_INTENT', message);
}

function encode(value: unknown, stack: Set<object>): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid('Session mailbox payload numbers must be finite.');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    invalid('Session mailbox payload must contain only JSON values.');
  }
  const object = value as object;
  if (stack.has(object)) invalid('Session mailbox payload must not contain cycles.');
  stack.add(object);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key === 'symbol')) invalid('Session mailbox arrays must not contain symbol properties.');
      const stringKeys = keys.filter((key): key is string => typeof key === 'string' && key !== 'length');
      if (stringKeys.length !== value.length
        || stringKeys.some((key, index) => key !== String(index))
        || value.some((_item, index) => !(index in value))) {
        invalid('Session mailbox arrays must be dense and contain no extra properties.');
      }
      return `[${value.map(item => encode(item, stack)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid('Session mailbox records must be plain objects.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key === 'symbol')) invalid('Session mailbox records must not contain symbol properties.');
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        invalid('Session mailbox records must contain only enumerable data properties.');
      }
    }
    return `{${(keys as string[]).sort().map(key => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], stack)}`).join(',')}}`;
  } finally {
    stack.delete(object);
  }
}

export function stableSessionWorkerJson(value: unknown): string {
  return encode(value, new Set());
}
