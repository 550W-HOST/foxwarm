import { FunctionCall } from './types';

export function stringifyFunctionCallArgs(functionCall?: Pick<FunctionCall, 'args' | 'rawArgsText'> | null): string {
  if (typeof functionCall?.rawArgsText === 'string') {
    return functionCall.rawArgsText;
  }

  try {
    return JSON.stringify(functionCall?.args || {});
  } catch {
    return '[unserializable args]';
  }
}

function isPlainObject(value: any): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseFunctionCallArgs(rawArgsText: unknown): {
  args: Record<string, any>;
  rawArgsText?: string;
  argsParseError?: string;
} {
  if (rawArgsText === undefined || rawArgsText === null) {
    return { args: {} };
  }

  if (typeof rawArgsText !== 'string') {
    if (isPlainObject(rawArgsText)) {
      return { args: rawArgsText };
    }

    return {
      args: {},
      rawArgsText: String(rawArgsText),
      argsParseError: `Invalid tool arguments JSON: expected an object string, received ${typeof rawArgsText}`,
    };
  }

  try {
    const parsed = JSON.parse(rawArgsText);
    if (!isPlainObject(parsed)) {
      return {
        args: {},
        rawArgsText,
        argsParseError: `Invalid tool arguments JSON: expected top-level object but received ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
      };
    }

    return {
      args: parsed,
      rawArgsText,
    };
  } catch (error: any) {
    return {
      args: {},
      rawArgsText,
      argsParseError: `Invalid tool arguments JSON: ${error?.message || String(error)}`,
    };
  }
}