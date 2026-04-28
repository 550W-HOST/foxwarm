import { Message, MessagePart } from '../types';
import { stringifyFunctionCallArgs } from '../toolCallArgs';
import { truncateUnicodeSafe } from './unicode';

export const DEFAULT_TOOL_CONTENT_CHAR_LIMIT = 200;

export type FormatMessageTextOptions = {
  includeRolePrefix?: boolean;
  toolCharLimit?: number;
  skipEphemeralSystem?: boolean;
  skipRagMemorySnippets?: boolean;
  skipThinking?: boolean;
  continuationPrefix?: string;
};

const EPHEMERAL_SYSTEM_PREFIXES = [
  'current time =',
  'current session ID =',
  'FROM:',
  'The following message is a direct user message via channel;',
  'Channel is in push-only mode.',
  'Channel is in send-only mode.',
];

function isEphemeralSystemText(text: string): boolean {
  return EPHEMERAL_SYSTEM_PREFIXES.some(prefix => text.startsWith(prefix));
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) {
    return text;
  }

  return truncateUnicodeSafe(text, maxChars, '...');
}

function formatMultilineText(text: string, continuationPrefix: string = '> '): string {
  const normalized = text.trim();
  if (!normalized) {
    return '';
  }

  const lines = normalized.split('\n');
  const [firstLine, ...restLines] = lines;
  if (restLines.length === 0) {
    return firstLine;
  }

  return [
    firstLine,
    ...restLines.map(line => `${continuationPrefix}${line}`),
  ].join('\n');
}

export function formatPrefixedMultilineText(prefix: string, text: string, continuationPrefix: string = '> '): string {
  const normalized = text.trim();
  if (!normalized) {
    return prefix;
  }

  const lines = normalized.split('\n');
  return `${prefix}${lines.join('\n')}`;
}

function stringifyFunctionArgs(part: MessagePart): string {
  return stringifyFunctionCallArgs(part.functionCall);
}

function formatFunctionResponse(part: MessagePart): string | undefined {
  const response = part.functionResponse?.response;
  if (!response) return undefined;

  if (response.error) {
    return `ERROR: ${typeof response.error === 'string' ? response.error : JSON.stringify(response.error)}`;
  }

  if (response.output !== undefined && response.output !== null) {
    return typeof response.output === 'string' ? response.output : JSON.stringify(response.output);
  }

  if (response.content !== undefined && response.content !== null) {
    return typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  }

  if (response.inlineData || response.inlineDataItems) {
    return '[inline data]';
  }

  return JSON.stringify(response);
}

function formatPartLines(message: Message, part: MessagePart, options: Required<FormatMessageTextOptions>): string[] {
  const lines: string[] = [];
  const toolCharLimit = options.toolCharLimit;
  const isBodyRole = message.role === 'user' || message.role === 'model';

  if (typeof part.system === 'string') {
    if (!options.skipEphemeralSystem || !isEphemeralSystemText(part.system)) {
      lines.push(`[system] ${part.system}`);
    }
  }

  if (typeof part.text === 'string' && part.text.trim()) {
    if (!options.skipRagMemorySnippets || !part.text.includes('--- RELEVANT MEMORY SNIPPETS (RAG) ---')) {
      const text = isBodyRole ? part.text : truncateText(part.text, toolCharLimit);
      lines.push(text);
    }
  }

  if (typeof part.thinking === 'string' && part.thinking.trim()) {
    if (!options.skipThinking) {
      const thinking = isBodyRole ? part.thinking : truncateText(part.thinking, toolCharLimit);
      lines.push(`[thinking] ${thinking}`);
    }
  }

  if (part.functionCall) {
    const args = truncateText(stringifyFunctionArgs(part), toolCharLimit);
    lines.push(`[call:${part.functionCall.name}] ${args}`);
  }

  const functionResponse = formatFunctionResponse(part);
  if (functionResponse) {
    lines.push(`[tool:${part.functionResponse?.name || 'unknown'}] ${truncateText(functionResponse, toolCharLimit)}`);
  }

  const inlineDataRef = part.inlineDataRef as any;
  if (inlineDataRef) {
    const mimeType = inlineDataRef.mimeType || 'application/octet-stream';
    const imageId = inlineDataRef.imageId || 'image';
    lines.push(`[image:${mimeType}] ${imageId}`);
  } else if (part.inlineData) {
    const mimeType = part.inlineData.mimeType || part.inlineData.mime_type || 'application/octet-stream';
    const imageId = part.imageMeta?.imageId;
    lines.push(imageId ? `[image:${mimeType}] ${imageId}` : `[image:${mimeType}]`);
  }

  return lines;
}

export function formatMessageText(message: Message, options: FormatMessageTextOptions = {}): string {
  const resolved: Required<FormatMessageTextOptions> = {
    includeRolePrefix: options.includeRolePrefix !== false,
    toolCharLimit: options.toolCharLimit ?? DEFAULT_TOOL_CONTENT_CHAR_LIMIT,
    skipEphemeralSystem: options.skipEphemeralSystem ?? false,
    skipRagMemorySnippets: options.skipRagMemorySnippets ?? false,
    skipThinking: options.skipThinking ?? false,
    continuationPrefix: options.continuationPrefix ?? '> ',
  };

  const content = (message.parts || []).flatMap(part => formatPartLines(message, part, resolved)).filter(Boolean).join('\n').trim();
  if (!content) {
    return '';
  }

  if (!resolved.includeRolePrefix) {
    return formatMultilineText(content, resolved.continuationPrefix);
  }

  return formatPrefixedMultilineText(
    `[${message.role}] `,
    formatMultilineText(content, resolved.continuationPrefix),
    resolved.continuationPrefix,
  );
}

export function formatMessagePreviewText(
  message: Message,
  previewLength: number = 100,
  options: Omit<FormatMessageTextOptions, 'includeRolePrefix'> = {}
): string {
  const preview = formatMessageText(message, {
    ...options,
    includeRolePrefix: false,
    skipThinking: options.skipThinking ?? true,
  });

  if (preview.length <= previewLength) {
    return preview;
  }

  return truncateUnicodeSafe(preview, previewLength, '...');
}
