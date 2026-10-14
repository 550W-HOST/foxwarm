export interface ReferencedFile {
  ref: string
  file: File
}

export interface UploadedReferencedFile {
  ref: string
  path: string
  filename: string
  mimeType: string
  size?: number
}

export function buildAttachmentUploadName(ref: string, originalName: string): string {
  if (!/^attachment[1-9]\d*$/.test(ref)) throw new Error('Invalid attachment reference')
  return `${ref}_${originalName || 'attachment'}`
}

export async function uploadReferencedFiles(
  attachments: readonly ReferencedFile[],
  uploadUrl: string,
  fetchImpl: typeof fetch = fetch,
  sessionId?: string,
): Promise<UploadedReferencedFile[]> {
  const uploaded: UploadedReferencedFile[] = []
  for (const { ref, file } of attachments) {
    const formData = new FormData()
    formData.append('file', file, buildAttachmentUploadName(ref, file.name))
    const targetUrl = sessionId ? `${uploadUrl}?sessionId=${encodeURIComponent(sessionId)}` : uploadUrl
    const response = await fetchImpl(targetUrl, { method: 'POST', body: formData })
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { error?: string } | null
      throw new Error(detail?.error ? `Failed to upload ${file.name}: ${detail.error}` : `Failed to upload ${file.name}`)
    }
    const data = await response.json()
    if (!data || typeof data.path !== 'string' || !data.path) throw new Error(`Invalid upload response for ${file.name}`)
    uploaded.push({
      ref,
      path: data.path,
      filename: typeof data.filename === 'string' && data.filename ? data.filename : file.name,
      mimeType: typeof data.mimeType === 'string' && data.mimeType ? data.mimeType : file.type || 'application/octet-stream',
      ...(typeof data.size === 'number' ? { size: data.size } : {}),
    })
  }
  return uploaded
}

export async function postReferencedMessage(
  url: string,
  body: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`Failed to send message (${response.status})`)
}

export function toLegacyUploadedFiles(files: readonly UploadedReferencedFile[]): Array<{ path: string; filename: string; mimeType: string }> {
  return files.map(({ path, filename, mimeType }) => ({ path, filename, mimeType }))
}
