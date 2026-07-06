export function buildPathDownloadUrl(filePath: string) {
  const params = new URLSearchParams({ path: filePath })
  return `download?${params.toString()}`
}

export function triggerBrowserDownload(url: string) {
  const link = document.createElement('a')
  link.href = url
  link.rel = 'noreferrer noopener'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
}