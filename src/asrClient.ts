import { Blob } from 'node:buffer';
import { WebSocket } from 'ws';
import { ASR_SERVICE_CONFIG } from './config';

export type AsrStatusResult = {
  configured: boolean;
  available: boolean;
  serviceUrl: string | null;
  health?: any;
  error?: string;
};

function normalizeServiceUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, '');
}

export function getAsrServiceBaseUrl(): string | null {
  if (ASR_SERVICE_CONFIG.enabled === false) {
    return null;
  }
  return normalizeServiceUrl(ASR_SERVICE_CONFIG.url);
}

export function getAsrServiceHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (ASR_SERVICE_CONFIG.key?.trim()) {
    headers.Authorization = `Bearer ${ASR_SERVICE_CONFIG.key.trim()}`;
  }
  return headers;
}

export async function getAsrServiceStatus(): Promise<AsrStatusResult> {
  const serviceUrl = getAsrServiceBaseUrl();
  if (!serviceUrl) {
    return {
      configured: false,
      available: false,
      serviceUrl: null,
    };
  }

  try {
    const response = await fetch(`${serviceUrl}/health`, {
      headers: getAsrServiceHeaders(),
      signal: AbortSignal.timeout(3000),
    });
    const body = await response.json().catch(() => ({}));
    return {
      configured: true,
      available: response.ok,
      serviceUrl,
      health: body,
    };
  } catch (error: any) {
    return {
      configured: true,
      available: false,
      serviceUrl,
      error: error?.message || String(error),
    };
  }
}

export async function transcribeWithAsrService(options: {
  fileBuffer: Buffer;
  fileName: string;
  mimeType?: string;
  context?: string;
  language?: string;
  segmentSeconds?: string;
}): Promise<{ status: number; body: any }> {
  const serviceUrl = getAsrServiceBaseUrl();
  if (!serviceUrl) {
    return {
      status: 503,
      body: { error: 'ASR service is not configured' },
    };
  }

  const formData = new FormData();
  formData.append('audio', new Blob([options.fileBuffer], { type: options.mimeType || 'application/octet-stream' }), options.fileName || 'audio.wav');
  if (options.context?.trim()) formData.append('context', options.context.trim());
  if (options.language?.trim()) formData.append('language', options.language.trim());
  if (options.segmentSeconds?.trim()) formData.append('segmentSeconds', options.segmentSeconds.trim());

  const response = await fetch(`${serviceUrl}/transcribe`, {
    method: 'POST',
    headers: getAsrServiceHeaders(),
    body: formData,
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });

  const text = await response.text();
  let body: any;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: text || 'ASR service returned non-JSON response' };
  }

  return {
    status: response.status,
    body,
  };
}

function getAsrServiceWebSocketUrl(): string | null {
  const serviceUrl = getAsrServiceBaseUrl();
  if (!serviceUrl) return null;
  return `${serviceUrl.replace(/^http/i, 'ws')}/ws/stream`;
}

export function createAsrServiceWebSocket(): WebSocket | null {
  const wsUrl = getAsrServiceWebSocketUrl();
  if (!wsUrl) return null;
  return new WebSocket(wsUrl, {
    headers: getAsrServiceHeaders(),
  });
}