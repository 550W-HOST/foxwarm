export type FoxwarmAttributeValue = string | number | boolean | null | undefined;

const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const FOXWARM_METADATA_LINE_RE = /^\s*<\/?foxwarm-(?:system|metadata|message)\b/i;
const FOXWARM_TAG_LINE_RE = /^\s*<\/?foxwarm-([a-zA-Z0-9_-]+)\b([^>]*)\/?\s*>\s*$/i;
const FOXWARM_MESSAGE_CLOSE_RE = /^\s*<\/foxwarm-message\s*>\s*$/i;

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

export function formatFoxwarmSystemTag(attrs: Record<string, FoxwarmAttributeValue>): string {
  const attrText = formatFoxwarmAttributes(attrs);
  return attrText ? `<foxwarm-system ${attrText} />` : '<foxwarm-system />';
}

export function formatFoxwarmSystemHint(hint: string, attrs: Record<string, FoxwarmAttributeValue> = {}): string {
  return formatFoxwarmSystemTag({ ...attrs, hint });
}

export function formatFoxwarmMessageOpen(attrs: Record<string, FoxwarmAttributeValue>): string {
  const attrText = formatFoxwarmAttributes(attrs);
  return attrText ? `<foxwarm-message ${attrText}>` : '<foxwarm-message>';
}

export function formatFoxwarmMessageClose(): string {
  return '</foxwarm-message>';
}

export function formatFoxwarmMessage(attrs: Record<string, FoxwarmAttributeValue>, content: string): string {
  return `${formatFoxwarmMessageOpen(attrs)}\n${content}\n${formatFoxwarmMessageClose()}`;
}

export function isFoxwarmMetadataLine(text: string | undefined | null): boolean {
  return typeof text === 'string' && FOXWARM_METADATA_LINE_RE.test(text);
}

export function isFoxwarmMessageCloseLine(text: string | undefined | null): boolean {
  return typeof text === 'string' && FOXWARM_MESSAGE_CLOSE_RE.test(text);
}

export function isFoxwarmTagLine(text: string | undefined | null): boolean {
  return typeof text === 'string' && FOXWARM_TAG_LINE_RE.test(text);
}

export function parseFoxwarmTagLine(text: string | undefined | null): { tagName: string; closing: boolean; attrs: Record<string, string> } | undefined {
  if (typeof text !== 'string') {
    return undefined;
  }
  const match = text.match(FOXWARM_TAG_LINE_RE);
  if (!match) {
    return undefined;
  }
  const closing = /^\s*<\//.test(text);
  const tagName = `foxwarm-${match[1].toLowerCase()}`;
  const rawAttrs = match[2] || '';
  const attrs: Record<string, string> = {};
  const attrRe = /([a-zA-Z_:][a-zA-Z0-9_.:-]*)\s*=\s*"([^"]*)"/g;
  let attrMatch: RegExpExecArray | null;
  while ((attrMatch = attrRe.exec(rawAttrs)) !== null) {
    attrs[attrMatch[1]] = unescapeFoxwarmAttributeValue(attrMatch[2]);
  }
  return { tagName, closing, attrs };
}

export function formatSystemPartForModel(system: string): string {
  const trimmed = system.trim();
  if (isFoxwarmMetadataLine(trimmed)) {
    return trimmed;
  }
  return formatFoxwarmSystemHint(system);
}
