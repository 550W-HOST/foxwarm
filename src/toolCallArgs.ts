import { FunctionCall } from './types';

export function stringifyFunctionCallArgs(functionCall?: Pick<FunctionCall, 'args' | 'rawArgsText' | 'argsParseError'> | null): string {
  // If args parsing failed, send a safe JSON object that includes the error
  // and the raw text so the LLM can see what went wrong. Never send broken
  // JSON directly — it causes a 400 parse error on the provider side.
  if (functionCall?.argsParseError) {
    return JSON.stringify({ error: functionCall.argsParseError, rawArgsText: functionCall.rawArgsText || undefined });
  }

  if (typeof functionCall?.rawArgsText === 'string') {
    return functionCall.rawArgsText;
  }

  try {
    return JSON.stringify(functionCall?.args || {});
  } catch {
    return JSON.stringify({ error: 'unserializable args' });
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