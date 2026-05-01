type JsonObject = Record<string, any>;

function hasOwn(value: unknown, key: string): boolean {
  return !!value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, key);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseJsonObjectString(value: unknown, fieldName: string): JsonObject {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a JSON object string.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error: any) {
    throw new Error(`${fieldName} must be a JSON object string; failed to parse JSON: ${error?.message || error}`);
  }

  if (!isJsonObject(parsed)) {
    throw new Error(`${fieldName} must be a JSON object string whose parsed value is an object.`);
  }

  return parsed;
}

export function resolveObjectArgWithJsonFallback(
  args: Record<string, any> | undefined | null,
  objectField: string,
  jsonField: string,
  options: { required?: boolean; label?: string } = {},
): JsonObject | undefined {
  const label = options.label || objectField;
  const hasObjectField = hasOwn(args, objectField);
  const objectValue = hasObjectField ? args?.[objectField] : undefined;
  if (isJsonObject(objectValue)) {
    return objectValue;
  }

  if (hasOwn(args, jsonField)) {
    return parseJsonObjectString(args?.[jsonField], jsonField);
  }

  if (hasObjectField) {
    throw new Error(`${label} must be an object. If the model cannot see the object field, pass ${jsonField} as a JSON object string instead.`);
  }

  if (options.required) {
    throw new Error(`${label} requires ${objectField} (object) or ${jsonField} (JSON object string).`);
  }

  return undefined;
}

export function requireStringMapObject(value: JsonObject | undefined, fieldName: string): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') {
      throw new Error(`${fieldName} must be a JSON object string with string values; value for key \`${key}\` is ${entry === null ? 'null' : typeof entry}.`);
    }
  }

  return value as Record<string, string>;
}
