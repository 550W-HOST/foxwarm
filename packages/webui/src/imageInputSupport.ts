type ImageInputModel = { key: string; imageInput?: boolean }
type DraftAttachment = { mimeType?: string | null }

export const IMAGE_INPUT_UNSUPPORTED_HINT =
  'The current model does not support image input. Images are kept in the conversation but are not sent to this model.'

// Older model payloads omit the flag; only an explicit false hides images from the model.
export function modelLacksImageInput(models: readonly ImageInputModel[], modelKey: string | null | undefined): boolean {
  if (!modelKey) return false
  return models.find(model => model.key === modelKey)?.imageInput === false
}

export function shouldShowImageInputHint(
  models: readonly ImageInputModel[],
  modelKey: string | null | undefined,
  attachments: readonly DraftAttachment[],
): boolean {
  return modelLacksImageInput(models, modelKey)
    && attachments.some(attachment => (attachment.mimeType || '').toLowerCase().startsWith('image/'))
}
