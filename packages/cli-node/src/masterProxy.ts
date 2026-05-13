import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { ClientOptions } from 'ws';

const { getProxyForUrl } = require('proxy-from-env') as {
  getProxyForUrl: (url: string) => string;
};

export type MasterProxyProtocol = 'ws' | 'wss' | 'http' | 'https';

export interface MasterProxyInfo {
  targetUrl: string;
  lookupUrl: string;
  proxyUrl: string;
  sanitizedProxyUrl: string;
}

function toHttpProxyLookupUrl(targetUrl: string): string {
  const url = new URL(targetUrl);
  if (url.protocol === 'ws:') {
    url.protocol = 'http:';
  } else if (url.protocol === 'wss:') {
    url.protocol = 'https:';
  }
  return url.toString();
}

export function sanitizeProxyUrl(proxyUrl: string): string {
  try {
    const url = new URL(proxyUrl);
    if (url.password) {
      url.password = '***';
    }
    return url.toString();
  } catch {
    return '<invalid proxy url>';
  }
}

export function getMasterProxyInfo(targetUrl: string): MasterProxyInfo | null {
  const lookupUrl = toHttpProxyLookupUrl(targetUrl);
  const proxyUrl = getProxyForUrl(lookupUrl);
  if (!proxyUrl) {
    return null;
  }
  return {
    targetUrl,
    lookupUrl,
    proxyUrl,
    sanitizedProxyUrl: sanitizeProxyUrl(proxyUrl),
  };
}

export function createMasterWebSocketOptions(wsUrl: string): ClientOptions {
  const proxyInfo = getMasterProxyInfo(wsUrl);
  if (!proxyInfo) {
    return {};
  }

  const target = new URL(wsUrl);
  const agent = target.protocol === 'wss:'
    ? new HttpsProxyAgent(proxyInfo.proxyUrl)
    : new HttpProxyAgent(proxyInfo.proxyUrl);

  return { agent: agent as any };
}
