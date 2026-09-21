import { expandModelsConfig, type ProviderConfigEntry } from './config';

export const PROVIDER_MODEL_LIST_TIMEOUT_MS = 10_000;
export const PROVIDER_MODEL_LIST_MAX_RESPONSE_BYTES = 1024 * 1024;
export const PROVIDER_MODEL_LIST_MAX_MODELS = 1000;
const PROVIDER_MODEL_LIST_MAX_ID_LENGTH = 512;
const PROVIDER_MODEL_LIST_MAX_HEADER_COUNT = 64;
const PROVIDER_MODEL_LIST_MAX_HEADER_NAME_LENGTH = 256;
const PROVIDER_MODEL_LIST_MAX_HEADER_VALUE_LENGTH = 8192;

const OPENAI_PROVIDER_TYPES = new Set([
  'openai',
  'openai-responses',
  'openai-ws',
  'openai-completions',
]);

export type ProviderModelListRequest = {
  providerType: string;
  baseUrl?: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
};

type ProviderModelListDependencies = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class ProviderModelListError extends Error {
  readonly statusCode: number;
  readonly code: 'invalid-request' | 'unsupported-provider' | 'timeout' | 'upstream' | 'invalid-response';
  readonly upstreamStatus?: number;

  constructor(
    code: ProviderModelListError['code'],
    message: string,
    statusCode: number,
    upstreamStatus?: number,
  ) {
    super(message);
    this.name = 'ProviderModelListError';
    this.code = code;
    this.statusCode = statusCode;
    this.upstreamStatus = upstreamStatus;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedString(value: unknown, label: string, maxLength: number, required = false): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new ProviderModelListError('invalid-request', `${label} is required.`, 400);
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ProviderModelListError('invalid-request', `${label} must be a string.`, 400);
  }
  const trimmed = value.trim();
  if (required && !trimmed) {
    throw new ProviderModelListError('invalid-request', `${label} is required.`, 400);
  }
  if (value.length > maxLength) {
    throw new ProviderModelListError('invalid-request', `${label} is too long.`, 400);
  }
  return trimmed || undefined;
}

export function parseProviderModelListRequest(value: unknown): ProviderModelListRequest {
  if (!isPlainObject(value)) {
    throw new ProviderModelListError('invalid-request', 'Provider connection must be an object.', 400);
  }
  const allowedKeys = new Set(['providerType', 'baseUrl', 'apiKey', 'extraHeaders']);
  const unknownKeys = Object.keys(value).filter(key => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new ProviderModelListError('invalid-request', 'Provider connection contains an unknown field.', 400);
  }

  const providerType = boundedString(value.providerType, 'providerType', 128, true)!;
  const baseUrl = boundedString(value.baseUrl, 'baseUrl', 4096);
  const apiKey = boundedString(value.apiKey, 'apiKey', 16_384);
  let extraHeaders: Record<string, string> | undefined;
  if (value.extraHeaders !== undefined) {
    if (!isPlainObject(value.extraHeaders)) {
      throw new ProviderModelListError('invalid-request', 'extraHeaders must be an object.', 400);
    }
    const entries = Object.entries(value.extraHeaders);
    if (entries.length > PROVIDER_MODEL_LIST_MAX_HEADER_COUNT) {
      throw new ProviderModelListError('invalid-request', 'extraHeaders contains too many entries.', 400);
    }
    extraHeaders = {};
    for (const [name, rawHeaderValue] of entries) {
      if (!name.trim() || name.length > PROVIDER_MODEL_LIST_MAX_HEADER_NAME_LENGTH) {
        throw new ProviderModelListError('invalid-request', 'extraHeaders contains an invalid header name.', 400);
      }
      if (!['string', 'number', 'boolean'].includes(typeof rawHeaderValue)) {
        throw new ProviderModelListError('invalid-request', 'extraHeaders values must be scalar.', 400);
      }
      const headerValue = String(rawHeaderValue);
      if (headerValue.length > PROVIDER_MODEL_LIST_MAX_HEADER_VALUE_LENGTH) {
        throw new ProviderModelListError('invalid-request', 'extraHeaders contains a value that is too long.', 400);
      }
      extraHeaders[name] = headerValue;
    }
  }

  return {
    providerType,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiKey ? { apiKey } : {}),
    ...(extraHeaders ? { extraHeaders } : {}),
  };
}

function buildProviderModelsUrl(baseUrl: string, providerType: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ProviderModelListError('invalid-request', 'baseUrl must be an absolute HTTP(S) URL.', 400);
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ProviderModelListError('invalid-request', 'baseUrl must be an absolute HTTP(S) URL without credentials, query, or fragment.', 400);
  }
  const root = parsed.toString().replace(/\/+$/, '');
  return OPENAI_PROVIDER_TYPES.has(providerType)
    ? `${root}/models`
    : `${root}/v1/models?limit=${PROVIDER_MODEL_LIST_MAX_MODELS}`;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > PROVIDER_MODEL_LIST_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch((): void => undefined);
    throw new ProviderModelListError('invalid-response', 'Provider model list response is too large.', 502);
  }
  if (!response.body) {
    throw new ProviderModelListError('invalid-response', 'Provider model list response is empty.', 502);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > PROVIDER_MODEL_LIST_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch((): void => undefined);
        throw new ProviderModelListError('invalid-response', 'Provider model list response is too large.', 502);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  try {
    return JSON.parse(body);
  } catch {
    throw new ProviderModelListError('invalid-response', 'Provider returned an invalid model list response.', 502);
  }
}

function resolveConnection(request: ProviderModelListRequest) {
  const transientProvider: ProviderConfigEntry = {
    providerType: request.providerType,
    ...(request.baseUrl ? { baseUrl: request.baseUrl } : {}),
    ...(request.apiKey ? { apiKey: request.apiKey } : {}),
    ...(request.extraHeaders ? { extraHeaders: request.extraHeaders } : {}),
    models: ['__provider_model_list__'],
  };
  const expanded = expandModelsConfig({ providerModelList: transientProvider });
  return expanded.models.providerModelList;
}

export async function listProviderModels(
  request: ProviderModelListRequest,
  dependencies: ProviderModelListDependencies = {},
): Promise<string[]> {
  const providerType = request.providerType;
  if (!OPENAI_PROVIDER_TYPES.has(providerType) && providerType !== 'anthropic') {
    throw new ProviderModelListError('unsupported-provider', 'Model listing is not supported for this provider type.', 400);
  }

  const connection = resolveConnection(request);
  if (!connection?.baseUrl) {
    throw new ProviderModelListError('invalid-request', 'Provider baseUrl is not configured.', 400);
  }
  const url = buildProviderModelsUrl(connection.baseUrl, providerType);
  const headers: Record<string, string> = OPENAI_PROVIDER_TYPES.has(providerType)
    ? {
      Accept: 'application/json',
      ...(connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {}),
      'user-agent': 'foxwarm/1.0',
    }
    : {
      Accept: 'application/json',
      ...(connection.apiKey ? { 'x-api-key': connection.apiKey } : {}),
      'anthropic-version': '2023-06-01',
      'user-agent': 'foxwarm/1.0',
    };
  for (const [name, value] of Object.entries(connection.extraHeaders || {})) {
    if (['string', 'number', 'boolean'].includes(typeof value)) headers[name] = String(value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? PROVIDER_MODEL_LIST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (dependencies.fetch || fetch)(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timer);
    if (controller.signal.aborted) {
      throw new ProviderModelListError('timeout', 'Provider model list request timed out.', 504);
    }
    throw new ProviderModelListError('upstream', 'Provider model list request failed.', 502);
  }

  if (!response.ok) {
    clearTimeout(timer);
    await response.body?.cancel().catch((): void => undefined);
    throw new ProviderModelListError(
      'upstream',
      `Provider model list request failed (${response.status}).`,
      502,
      response.status,
    );
  }

  let payload: unknown;
  try {
    payload = await readBoundedJson(response);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ProviderModelListError('timeout', 'Provider model list request timed out.', 504);
    }
    if (error instanceof ProviderModelListError) throw error;
    throw new ProviderModelListError('invalid-response', 'Provider returned an invalid model list response.', 502);
  } finally {
    clearTimeout(timer);
  }
  const data = isPlainObject(payload) && Array.isArray(payload.data) ? payload.data : null;
  if (!data) {
    throw new ProviderModelListError('invalid-response', 'Provider returned an invalid model list response.', 502);
  }

  const seen = new Set<string>();
  const models: string[] = [];
  for (const item of data) {
    const id = isPlainObject(item) && typeof item.id === 'string' ? item.id.trim() : '';
    if (!id || id.length > PROVIDER_MODEL_LIST_MAX_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
    if (models.length >= PROVIDER_MODEL_LIST_MAX_MODELS) break;
  }
  return models;
}
