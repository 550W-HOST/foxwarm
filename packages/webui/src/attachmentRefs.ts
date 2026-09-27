import { formatFoxwarmAttachmentTag } from '../../shared/src/foxwarmMarkup'

export const ATTACHMENT_REF_RE = /<attachment-ref\s+ref="(attachment[1-9]\d*)"\s*\/>/g
export const ATTACHMENT_NAME_RE = /^(attachment[1-9]\d*)_(.*)$/s

export interface AttachmentDisplay {
  ref: string
  name: string
  mimeType: string
  size?: number
  kind: 'image' | 'file'
  path?: string
  node?: string
}

export function collectAttachmentRefs(text: string): string[] {
  const refs: string[] = []
  for (const match of text.matchAll(ATTACHMENT_REF_RE)) refs.push(match[1])
  return refs
}

export function splitGeneratedAttachmentName(name: string): { ref: string; originalName: string } | null {
  const match = ATTACHMENT_NAME_RE.exec(name)
  return match ? { ref: match[1], originalName: match[2] } : null
}

export function buildReferencedAttachmentParts(text: string, attachments: readonly AttachmentDisplay[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = text ? [{ text }] : []
  for (const attachment of attachments) {
    output.push({
      text: formatFoxwarmAttachmentTag({
        kind: attachment.kind,
        name: attachment.name,
        mime: attachment.mimeType,
        path: attachment.path,
        node: attachment.node,
      }),
    })
  }
  return output
}
