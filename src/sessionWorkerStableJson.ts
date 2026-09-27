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
      const stringKeys: string[] = [];
      for (const key of keys) {
        if (typeof key === 'symbol') invalid('Session mailbox arrays must not contain symbol properties.');
        if (key !== 'length') stringKeys.push(key);
      }
      if (stringKeys.length !== value.length) {
        invalid('Session mailbox arrays must be dense and contain no extra properties.');
      }
      const encoded: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (stringKeys[index] !== String(index)) {
          invalid('Session mailbox arrays must be dense and contain no extra properties.');
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          invalid('Session mailbox arrays must contain only enumerable data properties.');
        }
        encoded.push(encode(descriptor.value, stack));
      }
      return `[${encoded.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid('Session mailbox records must be plain objects.');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key === 'symbol')) invalid('Session mailbox records must not contain symbol properties.');
    const descriptors = new Map<string, PropertyDescriptor>();
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        invalid('Session mailbox records must contain only enumerable data properties.');
      }
      descriptors.set(key, descriptor);
    }
    return `{${(keys as string[]).sort().map(key => `${JSON.stringify(key)}:${encode(descriptors.get(key)!.value, stack)}`).join(',')}}`;
  } finally {
    stack.delete(object);
  }
}

export function stableSessionWorkerJson(value: unknown): string {
  return encode(value, new Set());
}
