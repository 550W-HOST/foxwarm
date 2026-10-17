import { API_BASE_PATH, makeApiUrl } from '../config'

export function buildPathDownloadUrl(filePath: string, options?: { fileName?: string; preview?: boolean }) {
  const params = new URLSearchParams({ path: filePath })
  if (options?.fileName) params.set('filename', options.fileName)
  if (options?.preview) params.set('preview', '1')
  return `${API_BASE_PATH.slice(0, -4)}/download?${params.toString()}`
}

/** Mint a fresh capability only for this browser action, never for saved history. */
export async function requestPathDownloadUrl(url: string, signal?: AbortSignal): Promise<string> {
  const resourceUrl = new URL(url, window.location.href)
  return requestSignedDownload(makeApiUrl('/download/sign'), resourceUrl, Object.fromEntries(resourceUrl.searchParams), signal, 'File unavailable')
}

export async function requestImageDownloadUrl(src: string, fileName: string, signal?: AbortSignal): Promise<string> {
  if (/^(?:blob:|data:)/i.test(src)) return src
  const resourceUrl = new URL(src, window.location.href)
  const endpoint = new URL(resourceUrl)
  endpoint.pathname += '/download'
  endpoint.search = ''
  return requestSignedDownload(endpoint, resourceUrl, { filename: fileName, preview: '0' }, signal, 'Image unavailable')
}

async function requestSignedDownload(endpoint: URL, resourceUrl: URL, body: Record<string, string>, signal: AbortSignal | undefined, unavailable: string): Promise<string> {
  const response = await fetch(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!response.ok) throw new Error(response.status === 404 ? unavailable : 'Download unavailable')
  const result = await response.json()
  return new URL(result.url, resourceUrl).toString()
}

export function triggerBrowserDownload(url: string, fileName?: string) {
  const link = document.createElement('a')
  link.href = url
  if (fileName) link.download = fileName
  link.rel = 'noreferrer noopener'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}