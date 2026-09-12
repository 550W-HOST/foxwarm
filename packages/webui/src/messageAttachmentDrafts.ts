export interface MessageAttachmentDraft {
  ref: string
  file: File
}

const attachmentDrafts = new Map<string, Map<string, File>>()

function getOwner(sessionId: string): Map<string, File> {
  let owner = attachmentDrafts.get(sessionId)
  if (!owner) {
    owner = new Map()
    attachmentDrafts.set(sessionId, owner)
  }
  return owner
}

export function createMessageAttachmentDrafts(sessionId: string, files: readonly File[], reservedRefs: readonly string[] = []): MessageAttachmentDraft[] {
  const owner = getOwner(sessionId)
  let nextNumber = Math.max(0, ...[...owner.keys(), ...reservedRefs].map(ref => Number(/^attachment(\d+)$/.exec(ref)?.[1] || 0))) + 1
  return files.map(file => {
    const ref = `attachment${nextNumber++}`
    owner.set(ref, file)
    return { ref, file }
  })
}

export function getMessageAttachmentFile(sessionId: string, ref: string): File | undefined {
  return attachmentDrafts.get(sessionId)?.get(ref)
}

export function setMessageAttachmentFile(sessionId: string, ref: string, file: File): void {
  getOwner(sessionId).set(ref, file)
}

export function getMessageAttachmentDraft(sessionId: string): MessageAttachmentDraft[] {
  return [...(attachmentDrafts.get(sessionId) || [])].map(([ref, file]) => ({ ref, file }))
}

export function setMessageAttachmentDraft(sessionId: string, files: readonly MessageAttachmentDraft[]): MessageAttachmentDraft[] {
  if (files.length === 0) {
    attachmentDrafts.delete(sessionId)
    return []
  }
  const owner = new Map(files.map(({ ref, file }) => [ref, file]))
  attachmentDrafts.set(sessionId, owner)
  return files.map(item => ({ ...item }))
}

export function removeMessageAttachmentDraft(sessionId: string, ref: string): void {
  const owner = attachmentDrafts.get(sessionId)
  if (!owner) return
  owner.delete(ref)
  if (owner.size === 0) attachmentDrafts.delete(sessionId)
}

export function clearMessageAttachmentDraft(sessionId: string): void {
  attachmentDrafts.delete(sessionId)
}
