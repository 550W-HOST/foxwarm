import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';

/** OAuth discovery and token traffic never inherits resource-server headers. */
export function oauthEndpoint(value: string | URL): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('OAuth metadata contains an invalid endpoint.'); }
  if (url.username || url.password || url.hash || !['https:', 'http:'].includes(url.protocol)) {
    throw new Error('OAuth endpoints must be HTTP(S) URLs without credentials or fragments.');
  }
  if (url.protocol !== 'https:' && !isLoopbackHost(url.hostname)) {
    throw new Error('OAuth endpoints require HTTPS. HTTP is allowed only for localhost development.');
  }
  return url;
}

export function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1';
}

function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b, c] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c))))
      || (a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113) || (a === 100 && b >= 64 && b <= 127);
  }
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:')) {
    const tail = lower.slice(7);
    if (tail.includes('.')) return isPrivateAddress(tail);
    const [high, low] = tail.split(':').map(part => parseInt(part, 16));
    return !Number.isFinite(high) || !Number.isFinite(low)
      || isPrivateAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  return lower.startsWith('::') || lower.startsWith('fc') || lower.startsWith('fd')
    || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
}

/** Pin validated DNS addresses to this request; never follow discovery redirects. */
export function createOAuthFetch(resourceUrl: string): typeof fetch {
  const resource = oauthEndpoint(resourceUrl);
  return async (input, init = {}) => {
    const url = oauthEndpoint(typeof input === 'string' || input instanceof URL ? input : input.url);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await dns.lookup(hostname, { all: true });
    // Private configured resources remain supported. They do not authorize
    // metadata to fetch an unrelated private service. Loopback is a dev fixture.
    const allowPrivate = url.origin === resource.origin
      || (isLoopbackHost(resource.hostname) && isLoopbackHost(url.hostname));
    if (!addresses.length || (!allowPrivate && addresses.some(item => isPrivateAddress(item.address)))) {
      throw new Error('OAuth discovery cannot contact an unrelated private network endpoint.');
    }
    const headers = new Headers(init.headers);
    const body = init.body == null ? undefined : String(init.body);
    headers.set('Accept-Encoding', 'identity');
    if (body !== undefined) headers.set('Content-Length', String(Buffer.byteLength(body)));
    return new Promise<Response>((resolve, reject) => {
      const transport = url.protocol === 'https:' ? https : http;
      const request = transport.request(url, {
        method: init.method || 'GET',
        headers: Object.fromEntries(headers.entries()),
        lookup: (_host, options, callback) => {
          const all = (options as { all?: boolean }).all;
          if (all) (callback as any)(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        },
      }, response => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) request.destroy(new Error('OAuth response is too large.'));
          else chunks.push(chunk);
        });
        response.on('end', () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) {
            if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);
          }
          const status = response.statusCode || 500;
          if (status >= 300 && status < 400) {
            reject(new Error('OAuth endpoints must not redirect discovery or token requests.'));
            return;
          }
          resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
            status, headers: responseHeaders,
          }));
        });
        response.on('error', () => reject(new Error('OAuth request failed.')));
      });
      request.on('error', () => reject(new Error('OAuth request failed. Check the server connection.')));
      const deadline = setTimeout(() => request.destroy(), 15_000);
      request.on('close', () => clearTimeout(deadline));
      const abort = () => request.destroy(new Error('OAuth request was cancelled.'));
      init.signal?.addEventListener('abort', abort, { once: true });
      request.on('close', () => init.signal?.removeEventListener('abort', abort));
      if (init.signal?.aborted) abort();
      if (body !== undefined) request.write(body);
      request.end();
    });
  };
}
