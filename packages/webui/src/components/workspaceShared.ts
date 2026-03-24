export const MAX_INLINE_FILE_BYTES = 1024 * 1024

export function formatTimestamp(value: number) {
  if (!value) return '—'
  return new Date(value).toLocaleString()
}

export function formatSize(size: number) {
  if (!Number.isFinite(size) || size < 1024) return `${size || 0} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function buildWorkspaceDownloadUrl(filePath: string, isDirectory: boolean = false) {
  const params = new URLSearchParams({ path: filePath })
  if (isDirectory) {
    params.set('archive', 'tgz')
  }
  return `/download?${params.toString()}`
}

export function triggerBrowserDownload(url: string) {
  const link = document.createElement('a')
  link.href = url
  link.rel = 'noreferrer noopener'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}