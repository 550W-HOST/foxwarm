const attachmentDrafts = new Map<string, File[]>()

export function getMessageAttachmentDraft(sessionId: string): File[] {
  return [...(attachmentDrafts.get(sessionId) || [])]
}

export function setMessageAttachmentDraft(sessionId: string, files: readonly File[]): File[] {
  const stored = [...files]
  if (stored.length > 0) {
    attachmentDrafts.set(sessionId, stored)
  } else {
    attachmentDrafts.delete(sessionId)
  }
  return [...stored]
}

export function updateMessageAttachmentDraft(
  sessionId: string,
  update: (files: File[]) => readonly File[],
): File[] {
  return setMessageAttachmentDraft(sessionId, update(getMessageAttachmentDraft(sessionId)))
}

export function clearMessageAttachmentDraft(sessionId: string): void {
  attachmentDrafts.delete(sessionId)
}
