import { buildFoxwarmAttachmentText } from '../../../shared/src/foxwarmMarkup'

export interface OptimisticUploadedFile {
  filename: string
  mimeType: string
}

export function appendOptimisticAttachmentTag(
  currentText: string,
  uploadedFile: OptimisticUploadedFile,
): string {
  const kind = uploadedFile.mimeType.startsWith('image/') ? 'image' : 'file'
  return buildFoxwarmAttachmentText({
    kind,
    name: uploadedFile.filename,
    ...(kind === 'file' ? { mime: uploadedFile.mimeType } : {}),
  }, currentText)
}