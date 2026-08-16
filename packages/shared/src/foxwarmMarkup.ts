export type FoxwarmAttributeValue = string | number | boolean | null | undefined;

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function escapeFoxwarmTextContent(value: string): string {
  return String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeFoxwarmAttributeValue(value: FoxwarmAttributeValue): string {
  const normalized = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function unescapeFoxwarmAttributeValue(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function formatFoxwarmAttributes(attrs: Record<string, FoxwarmAttributeValue>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) {
      continue;
    }
    const safeKey = key.replace(/[^a-zA-Z0-9_.:-]/g, '');
    if (!safeKey) {
      continue;
    }
    const attrValue = value === true ? 'true' : escapeFoxwarmAttributeValue(value);
    parts.push(`${safeKey}="${attrValue}"`);
  }
  return parts.join(' ');
}

export type FoxwarmAttachmentKind = 'image' | 'file';

export interface FoxwarmAttachmentDescriptor {
  kind: FoxwarmAttachmentKind;
  name: string;
  node?: string;
  path?: string;
  mime?: string;
}

export function formatFoxwarmAttachmentTag(descriptor: FoxwarmAttachmentDescriptor): string {
  const attrs = formatFoxwarmAttributes({
    name: descriptor.name,
    node: descriptor.node,
    path: descriptor.path,
    ...(descriptor.kind === 'file' ? { mime: descriptor.mime } : {}),
  });
  return attrs
    ? `<foxwarm-${descriptor.kind} ${attrs} />`
    : `<foxwarm-${descriptor.kind} />`;
}

export function buildFoxwarmAttachmentText(
  descriptor: FoxwarmAttachmentDescriptor,
  precedingText?: string,
): string {
  const tag = formatFoxwarmAttachmentTag(descriptor);
  const text = typeof precedingText === 'string' ? precedingText.trim() : '';
  return text ? `${text}\n\n${tag}` : tag;
}