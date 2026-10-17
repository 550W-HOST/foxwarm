export function buildPathDownloadUrl(filePath: string, options?: { fileName?: string; preview?: boolean }) {
  const params = new URLSearchParams({ path: filePath })
  if (options?.fileName) params.set('filename', options.fileName)
  if (options?.preview) params.set('preview', '1')
  return `download?${params.toString()}`
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