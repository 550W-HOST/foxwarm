import { Message, MessagePart } from './types';
import { formatArchiveBlockContextText, type ArchiveBlockRecord } from './session/layeredContext';
import { formatModelVisibilitySuffix, redactDisplayOnlyMessageForModel } from './session/messageVisibility';
import { stringifyFunctionCallArgs } from './toolCallArgs';
import { truncateUnicodeSafe } from './utils/unicode';
import { isFoxwarmMessageCloseLine, parseFoxwarmOpeningTag, parseFoxwarmWrappedContent } from './utils/promptWrappers';

export type ContextPreviewToolDetail = 'names' | 'snippets' | 'full';

export type ContextPreviewItem = {
  key: string;
  heading: string;
  body: string;
  searchText?: string;
  omittedToolText?: string;
};

export type ContextPreviewRenderOptions = {
  previewLength?: unknown;
  defaultPreviewLength?: number;
  contentFilter?: unknown;
  includeRegex?: unknown;
  excludeRegex?: unknown;
  toolDetail?: unknown;
  contentFilterOmitHint?: string;
};

export type ContextPreviewFilterStats = {
  contentFilterExcludedCount: number;
  includeRegexExcludedCount: number;
  excludeRegexExcludedCount: number;
};

export type ContextPreviewRenderResult = {
  text: string;
  budget: number;
  warnings: string[];
  matchedCount: number;
  inputCount: number;
  omittedCount: number;
  filterStats: ContextPreviewFilterStats;
};

const DEFAULT_CONTEXT_PREVIEW_BUDGET = 6000;
export const MIN_CONTEXT_PREVIEW_BUDGET = 1000;
export const MAX_CONTEXT_PREVIEW_BUDGET = 20000;
const DEFAULT_CONTEXT_TOOL_DETAIL: ContextPreviewToolDetail = 'names';
const HUGE_TOOL_LIMIT = 1_000_000;

const EPHEMERAL_SYSTEM_PREFIXES = [
  'current time =',
  'current session ID =',
  'FROM:',
  'The following message is a direct user message via channel;',
  'Channel is in push-only mode.',
  'Channel is in send-only mode.',
];

function isEphemeralSystemText(text: string): boolean {
  if (isFoxwarmMessageCloseLine(text)) {
    return true;
  }
  const tag = parseFoxwarmOpeningTag(text);
  if (tag?.tagName === 'foxwarm-system') {
    return tag.attrs.kind === 'time'
      || tag.attrs.kind === 'session'
      || tag.attrs.kind === 'channel-mode';
  }
  if (tag?.tagName === 'foxwarm-message' && !tag.closing) {
    return tag.attrs.type === 'channel';
  }
  return EPHEMERAL_SYSTEM_PREFIXES.some(prefix => text.startsWith(prefix));
}

function stringifyUnknown(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeWhitespaceForSearch(text: string): string {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function escapeRegexLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compileOptionalRegex(value: unknown, label: 'includeRegex' | 'excludeRegex'): RegExp | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string.`);
  }
  try {
    return new RegExp(value, 'i');
  } catch (err: any) {
    throw new Error(`Invalid ${label}: ${err?.message || 'failed to compile regex'}`);
  }
}

function normalizeFilterText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function normalizeContextPreviewBudget(
  value: unknown,
  defaultPreviewLength: number = DEFAULT_CONTEXT_PREVIEW_BUDGET,
): { budget: number; warnings: string[] } {
  const fallback = Number.isFinite(defaultPreviewLength)
    ? Math.max(MIN_CONTEXT_PREVIEW_BUDGET, Math.min(MAX_CONTEXT_PREVIEW_BUDGET, Math.floor(defaultPreviewLength)))
    : DEFAULT_CONTEXT_PREVIEW_BUDGET;

  if (value === undefined || value === null || value === '' || value === 0) {
    return { budget: fallback, warnings: [] };
  }

  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('previewLength must be a number when provided.');
  }

  const requested = Math.floor(value);
  if (requested < MIN_CONTEXT_PREVIEW_BUDGET) {
    return {
      budget: MIN_CONTEXT_PREVIEW_BUDGET,
      warnings: [`[warning] previewLength ${requested} is below the minimum; using ${MIN_CONTEXT_PREVIEW_BUDGET}.`],
    };
  }
  if (requested > MAX_CONTEXT_PREVIEW_BUDGET) {
    return {
      budget: MAX_CONTEXT_PREVIEW_BUDGET,
      warnings: [`[warning] previewLength ${requested} exceeds the maximum; using ${MAX_CONTEXT_PREVIEW_BUDGET}.`],
    };
  }

  return { budget: requested, warnings: [] };
}

export type CompiledPreviewFilters = {
  contentFilter?: string;
  contentFilterRegex?: RegExp;
  includeRegex?: RegExp;
  excludeRegex?: RegExp;
  active: boolean;
};

function compilePreviewFilters(options: ContextPreviewRenderOptions): CompiledPreviewFilters {
  const contentFilter = normalizeFilterText(options.contentFilter);
  const includeRegex = compileOptionalRegex(options.includeRegex, 'includeRegex');
  const excludeRegex = compileOptionalRegex(options.excludeRegex, 'excludeRegex');
  return {
    contentFilter,
    contentFilterRegex: contentFilter ? new RegExp(escapeRegexLiteral(contentFilter), 'i') : undefined,
    includeRegex,
    excludeRegex,
    active: Boolean(contentFilter || includeRegex || excludeRegex),
  };
}

function itemMatchesFilters(item: ContextPreviewItem, filters: CompiledPreviewFilters): boolean {
  const haystack = normalizeWhitespaceForSearch(item.searchText || item.body || '');
  if (filters.contentFilter && !haystack.toLowerCase().includes(filters.contentFilter.toLowerCase())) {
    return false;
  }
  if (filters.includeRegex && !filters.includeRegex.test(haystack)) {
    return false;
  }
  if (filters.excludeRegex && filters.excludeRegex.test(haystack)) {
    return false;
  }
  return true;
}

function collectMatchRegexes(filters: CompiledPreviewFilters): RegExp[] {
  return [filters.contentFilterRegex, filters.includeRegex].filter((entry): entry is RegExp => Boolean(entry));
}

function filterPreviewItems(
  items: ContextPreviewItem[],
  filters: CompiledPreviewFilters,
): { items: ContextPreviewItem[]; stats: ContextPreviewFilterStats } {
  let remaining = items;
  let contentFilterExcludedCount = 0;
  let includeRegexExcludedCount = 0;
  let excludeRegexExcludedCount = 0;

  if (filters.contentFilter) {
    const next = remaining.filter(item => {
      const haystack = normalizeWhitespaceForSearch(item.searchText || item.body || '');
      return haystack.toLowerCase().includes(filters.contentFilter!.toLowerCase());
    });
    contentFilterExcludedCount = remaining.length - next.length;
    remaining = next;
  }

  if (filters.includeRegex) {
    const next = remaining.filter(item => {
      const haystack = normalizeWhitespaceForSearch(item.searchText || item.body || '');
      filters.includeRegex!.lastIndex = 0;
      return filters.includeRegex!.test(haystack);
    });
    includeRegexExcludedCount = remaining.length - next.length;
    remaining = next;
  }

  if (filters.excludeRegex) {
    const next = remaining.filter(item => {
      const haystack = normalizeWhitespaceForSearch(item.searchText || item.body || '');
      filters.excludeRegex!.lastIndex = 0;
      return !filters.excludeRegex!.test(haystack);
    });
    excludeRegexExcludedCount = remaining.length - next.length;
    remaining = next;
  }

  return {
    items: remaining,
    stats: {
      contentFilterExcludedCount,
      includeRegexExcludedCount,
      excludeRegexExcludedCount,
    },
  };
}

function formatFilterNotices(
  stats: ContextPreviewFilterStats,
  options: ContextPreviewRenderOptions,
): string[] {
  const notices: string[] = [];
  if (stats.contentFilterExcludedCount > 0) {
    notices.push(`[filter] contentFilter excluded ${stats.contentFilterExcludedCount} item(s) because the literal case-insensitive content filter did not match.`);
    if (options.contentFilterOmitHint) {
      notices.push(`[hint] ${options.contentFilterOmitHint}`);
    }
  }
  if (stats.includeRegexExcludedCount > 0) {
    notices.push(`[filter] includeRegex excluded ${stats.includeRegexExcludedCount} additional item(s) that remained after earlier filter stages.`);
  }
  if (stats.excludeRegexExcludedCount > 0) {
    notices.push(`[filter] excludeRegex excluded ${stats.excludeRegexExcludedCount} additional item(s) that remained after earlier filter stages.`);
  }
  return notices;
}

function firstMatchIndex(text: string, filters: CompiledPreviewFilters): { index: number; length: number } | undefined {
  let best: { index: number; length: number } | undefined;
  for (const regex of collectMatchRegexes(filters)) {
    regex.lastIndex = 0;
    const match = regex.exec(text);
    if (match && (best === undefined || match.index < best.index)) {
      best = { index: match.index, length: Math.max(1, match[0]?.length || 1) };
    }
  }
  return best;
}

function truncateFromStart(text: string, maxChars: number): string {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return truncateUnicodeSafe(normalized, Math.max(0, maxChars - 1), '…');
}

function buildMatchCenteredSnippet(text: string, maxChars: number, filters: CompiledPreviewFilters): string {
  const normalized = String(text || '').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const match = firstMatchIndex(normalized, filters);
  if (!match) {
    return truncateFromStart(normalized, maxChars);
  }

  const ellipsisBudget = 2;
  const windowChars = Math.max(20, maxChars - ellipsisBudget);
  const contextBefore = Math.floor(Math.max(0, windowChars - match.length) / 2);
  let start = Math.max(0, match.index - contextBefore);
  let end = Math.min(normalized.length, start + windowChars);
  if (end - start < windowChars) {
    start = Math.max(0, end - windowChars);
  }
  const prefix = start > 0 ? '…' : '';
  const suffix = end < normalized.length ? '…' : '';
  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
}

function countAdditionalMatches(text: string, filters: CompiledPreviewFilters): number {
  const regexes = collectMatchRegexes(filters);
  if (regexes.length === 0) {
    return 0;
  }
  let count = 0;
  for (const sourceRegex of regexes) {
    const flags = sourceRegex.flags.includes('g') ? sourceRegex.flags : `${sourceRegex.flags}g`;
    const regex = new RegExp(sourceRegex.source, flags);
    for (const _match of text.matchAll(regex)) {
      count += 1;
      if (count > 4) return count;
    }
  }
  return count;
}

function formatInlineDataLine(part: MessagePart): string | undefined {
  const inlineDataRef = part.inlineDataRef as any;
  if (inlineDataRef) {
    const mimeType = inlineDataRef.mimeType || 'application/octet-stream';
    const imageId = inlineDataRef.imageId || 'image';
    return `[image:${mimeType}] ${imageId}`;
  }
  if (part.inlineData) {
    const mimeType = part.inlineData.mimeType || part.inlineData.mime_type || 'application/octet-stream';
    const imageId = part.imageMeta?.imageId;
    return imageId ? `[image:${mimeType}] ${imageId}` : `[image:${mimeType}]`;
  }
  return undefined;
}

function functionResponseOutput(part: MessagePart): string | undefined {
  const response = part.functionResponse?.response;
  if (!response) return undefined;
  if (response.error !== undefined && response.error !== null) {
    return `ERROR: ${stringifyUnknown(response.error)}`;
  }
  if (response.output !== undefined && response.output !== null) {
    return stringifyUnknown(response.output);
  }
  if (response.content !== undefined && response.content !== null) {
    return stringifyUnknown(response.content);
  }
  if (response.inlineData || response.inlineDataItems) {
    return '[inline data]';
  }
  return stringifyUnknown(response);
}

function formatToolId(id?: string): string {
  return id ? `(${id})` : '';
}

function formatToolNameList(message: Message): string[] {
  const callParts: string[] = [];
  const responseParts: string[] = [];
  for (const part of message.parts || []) {
    if (part.functionCall) {
      callParts.push(`${part.functionCall.name}${formatToolId(part.functionCall.id)}`);
    }
    if (part.functionResponse) {
      const status = part.functionResponse.response?.error ? 'error' : 'ok';
      responseParts.push(`${part.functionResponse.name || 'unknown'}${formatToolId(part.functionResponse.tool_use_id)}: ${status} (content omitted)`);
    }
  }
  const lines: string[] = [];
  if (callParts.length > 0) {
    lines.push(`Tool calls: ${callParts.join(', ')}`);
  }
  if (responseParts.length > 0) {
    lines.push(`Tool results: ${responseParts.join(', ')}`);
  }
  return lines;
}

function formatMessageFullLines(message: Message, options: { toolDetail: ContextPreviewToolDetail; filters: CompiledPreviewFilters }): string[] {
  const lines: string[] = [];
  for (const part of message.parts || []) {
    if (typeof part.system === 'string') {
      const wrapped = parseFoxwarmWrappedContent(part.system);
      if (wrapped?.tagName === 'foxwarm-message' && wrapped.attrs.type === 'channel') {
        if (wrapped.content.trim()) {
          lines.push(wrapped.content.trim());
        }
      } else if (!isEphemeralSystemText(part.system)) {
        lines.push(`[system] ${part.system}`);
      }
    }
    if (typeof part.text === 'string' && part.text.trim() && !part.text.includes('--- RELEVANT MEMORY SNIPPETS (RAG) ---')) {
      lines.push(part.text.trim());
    }
    const imageLine = formatInlineDataLine(part);
    if (imageLine) {
      lines.push(imageLine);
    }
    if (part.functionCall) {
      if (options.toolDetail === 'full') {
        lines.push(`[call:${part.functionCall.name}${formatToolId(part.functionCall.id)}] ${stringifyFunctionCallArgs(part.functionCall)}`);
      } else if (options.toolDetail === 'snippets') {
        const args = stringifyFunctionCallArgs(part.functionCall);
        const snippet = options.filters.active ? buildMatchCenteredSnippet(args, 360, options.filters) : truncateFromStart(args, 240);
        lines.push(`[call:${part.functionCall.name}${formatToolId(part.functionCall.id)}] ${snippet}`);
      }
    }
    if (part.functionResponse) {
      const output = functionResponseOutput(part) || '';
      if (options.toolDetail === 'full') {
        lines.push(`[tool:${part.functionResponse.name || 'unknown'}${formatToolId(part.functionResponse.tool_use_id)}] ${output}`);
      } else if (options.toolDetail === 'snippets') {
        const snippet = options.filters.active ? buildMatchCenteredSnippet(output, 420, options.filters) : truncateFromStart(output, 260);
        lines.push(`[tool:${part.functionResponse.name || 'unknown'}${formatToolId(part.functionResponse.tool_use_id)}] ${snippet}`);
      }
    }
  }
  return lines;
}

function buildMessageSearchText(message: Message): string {
  const lines: string[] = [];
  for (const part of message.parts || []) {
    if (typeof part.system === 'string') {
      const wrapped = parseFoxwarmWrappedContent(part.system);
      if (wrapped?.tagName === 'foxwarm-message' && wrapped.attrs.type === 'channel') {
        if (wrapped.content.trim()) {
          lines.push(wrapped.content.trim());
        }
      } else if (!isEphemeralSystemText(part.system)) {
        lines.push(`[system] ${part.system}`);
      }
    }
    if (typeof part.text === 'string' && part.text.trim() && !part.text.includes('--- RELEVANT MEMORY SNIPPETS (RAG) ---')) {
      lines.push(part.text.trim());
    }
    if (typeof part.thinking === 'string' && part.thinking.trim()) {
      lines.push(`[thinking] ${part.thinking}`);
    }
    if (part.functionCall) {
      lines.push(`[call:${part.functionCall.name}${formatToolId(part.functionCall.id)}] ${stringifyFunctionCallArgs(part.functionCall)}`);
    }
    if (part.functionResponse) {
      lines.push(`[tool:${part.functionResponse.name || 'unknown'}${formatToolId(part.functionResponse.tool_use_id)}] ${functionResponseOutput(part) || ''}`);
    }
    const imageLine = formatInlineDataLine(part);
    if (imageLine) {
      lines.push(imageLine);
    }
  }
  return lines.join('\n').trim();
}

function buildMessageOmittedToolText(message: Message): string {
  const lines: string[] = [];
  for (const part of message.parts || []) {
    if (part.functionCall) {
      lines.push(`[call:${part.functionCall.name}${formatToolId(part.functionCall.id)}] ${stringifyFunctionCallArgs(part.functionCall)}`);
    }
    if (part.functionResponse) {
      lines.push(`[tool:${part.functionResponse.name || 'unknown'}${formatToolId(part.functionResponse.tool_use_id)}] ${functionResponseOutput(part) || ''}`);
    }
  }
  return lines.join('\n').trim();
}

export function createMessageContextPreviewItem(options: {
  key: string;
  heading: string;
  message: Message;
  hideDisplayOnlyContent?: boolean;
  toolDetail?: ContextPreviewToolDetail;
  filters?: CompiledPreviewFilters;
  renderOptions?: ContextPreviewRenderOptions;
}): ContextPreviewItem {
  const message = options.hideDisplayOnlyContent ? redactDisplayOnlyMessageForModel(options.message) : options.message;
  const filters = options.filters || compilePreviewFilters(options.renderOptions || {});
  const toolDetail = options.toolDetail || DEFAULT_CONTEXT_TOOL_DETAIL;
  const baseLines = toolDetail === 'names'
    ? [
      ...formatMessageFullLines(message, { toolDetail: 'names', filters }),
      ...formatToolNameList(message),
    ]
    : formatMessageFullLines(message, { toolDetail, filters });
  const body = baseLines.filter(Boolean).join('\n').trim() || '[empty message]';
  return {
    key: options.key,
    heading: options.heading,
    body,
    searchText: buildMessageSearchText(message),
    omittedToolText: toolDetail === 'names' ? buildMessageOmittedToolText(message) : undefined,
  };
}

export function createArchivedBlockContextPreviewItem(options: {
  key: string;
  headingPrefix?: string;
  block: ArchiveBlockRecord;
  maxSummaryChars?: number;
  includeSourceText?: string;
}): ContextPreviewItem {
  const summaryLimit = Math.max(1, Math.floor(options.maxSummaryChars || HUGE_TOOL_LIMIT));
  const blockText = formatArchiveBlockContextText({
    ...options.block,
    summary: truncateUnicodeSafe(options.block.summary || '', summaryLimit) || '[empty summary]',
  });
  const sourceSuffix = options.includeSourceText ? ` from ${options.includeSourceText}` : '';
  const origin = options.block.inherited ? `[inherited from ${options.block.sourceSessionId || 'unknown'}] ` : '[local] ';
  const heading = `${options.headingPrefix || ''}${origin}`.trimEnd();
  const body = `${blockText}${sourceSuffix}`;
  return {
    key: options.key,
    heading,
    body,
    searchText: [blockText, options.block.summary || '', options.includeSourceText || ''].join('\n'),
  };
}

function renderSingleItem(item: ContextPreviewItem, maxChars: number, filters: CompiledPreviewFilters): string {
  const headingPrefix = item.heading ? `${item.heading}\n` : '';
  const usableBodyChars = Math.max(80, maxChars - headingPrefix.length);
  let body = item.body || '[empty]';
  if (body.length > usableBodyChars) {
    body = filters.active
      ? buildMatchCenteredSnippet(body, usableBodyChars, filters)
      : truncateFromStart(body, usableBodyChars);
  }

  if (filters.active && item.omittedToolText && itemMatchesFilters({ ...item, body: item.omittedToolText, searchText: item.omittedToolText }, filters)) {
    const omittedNote = 'Matched in omitted tool call/result content; rerun with toolDetail:"snippets" or "full" to inspect.';
    const candidate = `${body}\n[${omittedNote}]`;
    body = candidate.length <= usableBodyChars
      ? candidate
      : `${buildMatchCenteredSnippet(body, Math.max(40, usableBodyChars - omittedNote.length - 4), filters)}\n[${omittedNote}]`;
  }

  if (filters.active) {
    const extraMatches = countAdditionalMatches(item.searchText || item.body || '', filters);
    if (extraMatches > 1 && body.length + 48 < usableBodyChars) {
      body += `\n[${extraMatches - 1} more match(es) may be omitted by preview budget]`;
    }
  }

  return `${headingPrefix}${body}`.trim();
}

export function renderContextPreviewItems(args: {
  items: ContextPreviewItem[];
  title: string | ((info: { matchedCount: number; totalMatchedCount: number; inputCount: number; budget: number }) => string);
  emptyMessage: string;
  options?: ContextPreviewRenderOptions;
  maxItems?: number;
}): ContextPreviewRenderResult {
  const options = args.options || {};
  const { budget, warnings } = normalizeContextPreviewBudget(options.previewLength, options.defaultPreviewLength);
  const filters = compilePreviewFilters(options);
  const filtered = filterPreviewItems(args.items, filters);
  const totalMatchedCount = filtered.items.length;
  const maxItems = typeof args.maxItems === 'number' && Number.isFinite(args.maxItems)
    ? Math.max(0, Math.floor(args.maxItems))
    : undefined;
  const filteredItems = maxItems === undefined ? filtered.items : filtered.items.slice(0, maxItems);
  const selectionOmittedCount = totalMatchedCount - filteredItems.length;
  const title = typeof args.title === 'function'
    ? args.title({ matchedCount: filteredItems.length, totalMatchedCount, inputCount: args.items.length, budget })
    : args.title;
  const selectionNotice = selectionOmittedCount > 0
    ? `[selection] ${selectionOmittedCount} additional matched item(s) omitted by the requested result limit.`
    : undefined;
  const prefixLines = [...warnings, title, ...formatFilterNotices(filtered.stats, options), selectionNotice].filter(Boolean);

  if (filteredItems.length === 0) {
    const emptyText = [...prefixLines, '', args.emptyMessage].join('\n').trimEnd();
    return {
      text: emptyText,
      budget,
      warnings,
      matchedCount: 0,
      inputCount: args.items.length,
      omittedCount: 0,
      filterStats: filtered.stats,
    };
  }

  let output = `${prefixLines.join('\n')}\n\n`;
  let omittedCount = 0;
  for (let index = 0; index < filteredItems.length; index += 1) {
    const remainingItems = filteredItems.length - index;
    const remainingBudget = budget - output.length;
    if (remainingBudget <= 120) {
      omittedCount = remainingItems;
      break;
    }

    const reserveForOmitted = remainingItems > 1 ? 80 : 0;
    const itemBudget = Math.max(160, Math.floor((remainingBudget - reserveForOmitted) / remainingItems));
    let itemText = renderSingleItem(filteredItems[index], itemBudget, filters);
    const separator = index === 0 ? '' : '\n\n';
    const maxAppend = budget - output.length - separator.length - (remainingItems > 1 ? 80 : 0);
    if (itemText.length > maxAppend) {
      itemText = filters.active
        ? buildMatchCenteredSnippet(itemText, Math.max(60, maxAppend), filters)
        : truncateFromStart(itemText, Math.max(60, maxAppend));
    }
    if (itemText.length <= 0) {
      omittedCount = remainingItems;
      break;
    }
    output += `${separator}${itemText}`;
  }

  if (omittedCount > 0) {
    const note = `\n\n[${omittedCount} item(s) omitted due to previewLength budget ${budget}. Narrow the range/filter or raise previewLength up to ${MAX_CONTEXT_PREVIEW_BUDGET}.]`;
    if (output.length + note.length <= budget + warnings.join('\n').length + 1) {
      output += note;
    } else {
      output = `${truncateUnicodeSafe(output, Math.max(0, budget - note.length), '…')}${note}`;
    }
  }

  return {
    text: output.trimEnd(),
    budget,
    warnings,
    matchedCount: filteredItems.length,
    inputCount: args.items.length,
    omittedCount,
    filterStats: filtered.stats,
  };
}

export function formatMessageHeading(options: {
  label: string;
  message: Message;
  originLabel?: string;
}): string {
  const roleEmoji = options.message.role === 'user' ? '👤' : options.message.role === 'model' ? '🤖' : '🔧';
  const origin = options.originLabel ? `${options.originLabel} ` : '';
  return `${options.label} ${origin}${roleEmoji} ${options.message.role}${formatModelVisibilitySuffix(options.message)}:`;
}
