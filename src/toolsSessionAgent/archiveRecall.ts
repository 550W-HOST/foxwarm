import * as sessionManager from '../sessionManager';
import { formatArchiveBlockContextText, formatArchiveBlockTimeRange, getArchiveBlockEndTimestamp, getArchiveBlockStartTimestamp, renderBlockMessage, type ArchiveBlockRecord } from '../session/layeredContext';
import type { ArchiveMessageRecord } from '../session/archive';
import type { Message } from '../types';
import * as vector from '../vector';
import {
  createArchivedBlockContextPreviewItem,
  createMessageContextPreviewItem,
  formatMessageHeading,
  normalizeContextPreviewBudget,
  renderContextPreviewItems,
  type ContextPreviewItem,
  type ContextPreviewRenderOptions,
  type ContextPreviewToolDetail,
} from '../contextPreviewRenderer';
import { truncateUnicodeSafe } from '../utils/unicode';
import { formatLocalTimestamp } from '../utils/localTime';
import { requireNotIsolated, checkArchivedReadPermission } from '../isolatedCheck';
import { resolveMemorySearchOptions } from '../tools/vectorTools';
import {
  ToolArgs,
  ToolContext,
  ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT,
  RECALL_DEFAULT_PREVIEW_LENGTH,
  RECALL_LEGACY_ARG_NAMES,
  calculatePreviewRequestChars,
  formatMessageLogRange,
  formatBlockIdRange,
  getPositiveInteger,
  isNonEmptyString,
} from './helpers';


function formatArchiveSourceBlockIds(sourceBlockIds?: number[]): string | undefined {
  if (!Array.isArray(sourceBlockIds) || sourceBlockIds.length === 0) {
    return undefined;
  }

  return sourceBlockIds.map(id => `B#${id}`).join(', ');
}

function formatArchiveChildBlockReference(record: ArchiveBlockRecord): string {
  return formatArchiveSourceBlockIds(getArchiveBlockSourceBlockIds(record))
    || formatBlockIdRange(record.sourceStart, record.sourceEnd);
}

function getArchiveBlockSourceBlockIds(record: ArchiveBlockRecord): number[] | undefined {
  if (record.sourceKind !== 'block' || !Array.isArray(record.sourceBlockIds) || record.sourceBlockIds.length === 0) {
    return undefined;
  }

  const ids = record.sourceBlockIds
    .map(id => Number(id))
    .filter(id => Number.isInteger(id) && id > 0);
  return ids.length > 0 ? ids : undefined;
}

function archiveBlockContainsSourceBlockId(parent: ArchiveBlockRecord, childId: number): boolean {
  const sourceBlockIds = getArchiveBlockSourceBlockIds(parent);
  if (sourceBlockIds) {
    return sourceBlockIds.includes(childId);
  }

  return childId >= Math.min(parent.sourceStart, parent.sourceEnd)
    && childId <= Math.max(parent.sourceStart, parent.sourceEnd);
}

function formatArchiveSourceLabel(sourceKind: string, sourceStart: number, sourceEnd: number, sourceBlockIds?: number[]): string {
  if (sourceKind === 'message') {
    return `messages ${formatMessageLogRange(sourceStart, sourceEnd)}`;
  }
  if (sourceKind === 'block') {
    const explicitIds = formatArchiveSourceBlockIds(sourceBlockIds);
    if (explicitIds) {
      return `blocks ${explicitIds}`;
    }
    return `blocks ${formatBlockIdRange(sourceStart, sourceEnd)}`;
  }
  return `${sourceKind} ${sourceStart}-${sourceEnd}`;
}

function normalizeArchiveTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function getArchivedMessageTimestamp(record?: { timestamp?: number; message?: any } | null): number | undefined {
  if (!record) {
    return undefined;
  }

  return normalizeArchiveTimestamp(record.timestamp)
    ?? normalizeArchiveTimestamp(record.message?.__meta?.timestamp);
}

function formatArchivedMessageTime(record: { timestamp?: number; message?: any }): string {
  const timestamp = getArchivedMessageTimestamp(record);
  return typeof timestamp === 'number' ? ` time ${formatLocalTimestamp(timestamp)}` : '';
}

function getDirectBlockMessageSeqRange(record: ArchiveBlockRecord): { startSeq: number; endSeq: number } | undefined {
  const rawStartSeq = getPositiveInteger(record.rawStartSeq);
  const rawEndSeq = getPositiveInteger(record.rawEndSeq);
  if (typeof rawStartSeq === 'number' && typeof rawEndSeq === 'number') {
    const range = normalizeRecallRange(rawStartSeq, rawEndSeq);
    return { startSeq: range.start, endSeq: range.end };
  }

  if (record.sourceKind === 'message') {
    const range = normalizeRecallRange(record.sourceStart, record.sourceEnd);
    return { startSeq: range.start, endSeq: range.end };
  }

  return undefined;
}

async function getArchivedMessageTimestampBySeq(sessionId: string, seq: number): Promise<number | undefined> {
  const result = await sessionManager.getArchivedMessages(sessionId, { startSeq: seq, endSeq: seq });
  return getArchivedMessageTimestamp(result.records.find(record => record.seq === seq) || result.records[0]);
}

async function hydrateRecallBlockTimeRange(
  sessionId: string,
  record: ArchiveBlockRecord,
  resolvedRange?: { startSeq: number; endSeq: number } | null,
): Promise<ArchiveBlockRecord> {
  const startTimestamp = getArchiveBlockStartTimestamp(record);
  const endTimestamp = getArchiveBlockEndTimestamp(record);
  if (typeof startTimestamp === 'number' && typeof endTimestamp === 'number') {
    return {
      ...record,
      rawStartTimestamp: startTimestamp,
      rawEndTimestamp: endTimestamp,
    };
  }

  const range = resolvedRange || getDirectBlockMessageSeqRange(record);
  if (!range) {
    return {
      ...record,
      rawStartTimestamp: startTimestamp,
      rawEndTimestamp: endTimestamp,
    };
  }

  const startSeq = getPositiveInteger(range.startSeq);
  const endSeq = getPositiveInteger(range.endSeq);
  if (typeof startSeq !== 'number' || typeof endSeq !== 'number') {
    return {
      ...record,
      rawStartTimestamp: startTimestamp,
      rawEndTimestamp: endTimestamp,
    };
  }

  const [resolvedStartTimestamp, resolvedEndTimestamp] = await Promise.all([
    typeof startTimestamp === 'number' ? Promise.resolve(startTimestamp) : getArchivedMessageTimestampBySeq(sessionId, startSeq),
    typeof endTimestamp === 'number' ? Promise.resolve(endTimestamp) : getArchivedMessageTimestampBySeq(sessionId, endSeq),
  ]);

  return {
    ...record,
    rawStartTimestamp: resolvedStartTimestamp,
    rawEndTimestamp: resolvedEndTimestamp,
  };
}

async function hydrateRecallBlockTimeRanges(sessionId: string, records: ArchiveBlockRecord[]): Promise<ArchiveBlockRecord[]> {
  return Promise.all(records.map(record => hydrateRecallBlockTimeRange(sessionId, record)));
}

function formatArchivedMessagePreview(
  sessionId: string,
  records: Array<{ seq: number; timestamp?: number; message: any; inherited?: boolean; sourceSessionId?: string }>,
  meta: { totalMatched: number; startSeq?: number; endSeq?: number },
  renderOptions: ContextPreviewRenderOptions = {},
): string {
  if (records.length === 0) {
    const rangeLabel = typeof meta.startSeq === 'number' || typeof meta.endSeq === 'number'
      ? ` for ${typeof meta.startSeq === 'number' ? `#${meta.startSeq}` : '?'}-${typeof meta.endSeq === 'number' ? `#${meta.endSeq}` : '?'}`
      : '';
    return `No archived messages found in session \`${sessionId}\`${rangeLabel}.`;
  }

  const rangeBits: string[] = [];
  if (typeof meta.startSeq === 'number') {
    rangeBits.push(`startSeq=#${meta.startSeq}`);
  }
  if (typeof meta.endSeq === 'number') {
    rangeBits.push(`endSeq=#${meta.endSeq}`);
  }
  const rangeLabel = rangeBits.length ? ` (${rangeBits.join(', ')})` : '';

  const items = records.map(record => {
    const originLabel = record.inherited
      ? `[inherited from ${record.sourceSessionId || 'unknown'}]`
      : '[local]';
    return createMessageContextPreviewItem({
      key: `msg:${record.seq}`,
      heading: formatMessageHeading({
        label: `[#${record.seq}${formatArchivedMessageTime(record)}]`,
        originLabel,
        message: record.message,
      }),
      message: record.message,
      hideDisplayOnlyContent: true,
      toolDetail: renderOptions.toolDetail as ContextPreviewToolDetail | undefined,
      renderOptions,
    });
  });

  return renderContextPreviewItems({
    items,
    title: ({ matchedCount }) => `Archived messages for session \`${sessionId}\` - showing ${matchedCount} of ${meta.totalMatched} matched message(s)${rangeLabel}.`,
    emptyMessage: `No archived messages matched the requested filters for session \`${sessionId}\`.`,
    options: { defaultPreviewLength: RECALL_DEFAULT_PREVIEW_LENGTH, ...renderOptions },
  }).text;
}


function formatArchivedBlockPreview(
  sessionId: string,
  records: Array<{
    id: number;
    level: number;
    rawStartSeq: number;
    rawEndSeq: number;
    rawStartTimestamp?: number;
    rawEndTimestamp?: number;
    summary: string;
    sourceKind: string;
    sourceStart: number;
    sourceEnd: number;
    sourceBlockIds?: number[];
    inherited?: boolean;
    sourceSessionId?: string;
  }>,
  meta: { totalMatched: number; startId?: number; endId?: number },
  renderOptions: ContextPreviewRenderOptions = {},
): string {
  if (records.length === 0) {
    const rangeLabel = typeof meta.startId === 'number' || typeof meta.endId === 'number'
      ? ` for ${typeof meta.startId === 'number' ? `#${meta.startId}` : '?'}-${typeof meta.endId === 'number' ? `#${meta.endId}` : '?'}`
      : '';
    return `No archived blocks found in session \`${sessionId}\`${rangeLabel}.`;
  }

  const rangeBits: string[] = [];
  if (typeof meta.startId === 'number') rangeBits.push(`startId=#${meta.startId}`);
  if (typeof meta.endId === 'number') rangeBits.push(`endId=#${meta.endId}`);
  const rangeLabel = rangeBits.length ? ` (${rangeBits.join(', ')})` : '';

  const items = records.map(record => createArchivedBlockContextPreviewItem({
    key: `block:${record.id}`,
    block: record as ArchiveBlockRecord,
    includeSourceText: formatArchiveSourceLabel(record.sourceKind, record.sourceStart, record.sourceEnd, record.sourceBlockIds),
  }));

  return renderContextPreviewItems({
    items,
    title: ({ matchedCount }) => `Archived layered-context blocks for session \`${sessionId}\` - showing ${matchedCount} of ${meta.totalMatched} matched block(s)${rangeLabel}.`,
    emptyMessage: `No archived blocks matched the requested filters for session \`${sessionId}\`.`,
    options: { defaultPreviewLength: RECALL_DEFAULT_PREVIEW_LENGTH, ...renderOptions },
  }).text;
}

type RecallTargetSpec =
  | { kind: 'overview' }
  | { kind: 'blocks' }
  | { kind: 'block'; id: number }
  | { kind: 'blockMessages'; id: number }
  | { kind: 'messages'; startSeq: number; endSeq: number };

export type ContextBlockExpansionKind = 'child-blocks' | 'messages';

export interface ContextBlockExpansionBlockPayload {
  id: number;
  level: number;
  sourceKind: ArchiveBlockRecord['sourceKind'];
  sourceStart: number;
  sourceEnd: number;
  sourceBlockIds?: number[];
  rawStartSeq: number;
  rawEndSeq: number;
  rawStartTimestamp?: number;
  rawEndTimestamp?: number;
  createdAt?: number;
  inherited?: boolean;
  sourceSessionId?: string;
}

export interface ContextBlockExpansionItem {
  kind: 'block' | 'message';
  message: Message;
  block?: ContextBlockExpansionBlockPayload;
  seq?: number;
  timestamp?: number;
  inherited?: boolean;
  sourceSessionId?: string;
}

export interface ContextBlockExpansionResult {
  sessionId: string;
  blockId: number;
  expansionKind: ContextBlockExpansionKind;
  target: string;
  previewLength: number;
  text: string;
  items: ContextBlockExpansionItem[];
  messages: Message[];
  totalItems: number;
  block: ContextBlockExpansionBlockPayload;
}

function contextBlockExpansionError(message: string, statusCode: number, code: string): Error & { statusCode: number; code: string } {
  const err = new Error(message) as Error & { statusCode: number; code: string };
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function buildContextBlockExpansionBlockPayload(block: ArchiveBlockRecord): ContextBlockExpansionBlockPayload {
  return {
    id: block.id,
    level: block.level,
    sourceKind: block.sourceKind,
    sourceStart: block.sourceStart,
    sourceEnd: block.sourceEnd,
    ...(Array.isArray(block.sourceBlockIds) && block.sourceBlockIds.length > 0 ? { sourceBlockIds: [...block.sourceBlockIds] } : {}),
    rawStartSeq: block.rawStartSeq,
    rawEndSeq: block.rawEndSeq,
    ...(typeof block.rawStartTimestamp === 'number' ? { rawStartTimestamp: block.rawStartTimestamp } : {}),
    ...(typeof block.rawEndTimestamp === 'number' ? { rawEndTimestamp: block.rawEndTimestamp } : {}),
    ...(typeof block.createdAt === 'number' ? { createdAt: block.createdAt } : {}),
    ...(block.inherited !== undefined ? { inherited: block.inherited } : {}),
    ...(typeof block.sourceSessionId === 'string' ? { sourceSessionId: block.sourceSessionId } : {}),
  };
}

function buildContextBlockExpansionMessageItem(record: ArchiveMessageRecord): ContextBlockExpansionItem {
  const message = structuredClone(record.message) as Message;
  message.__meta = {
    ...(message.__meta || {}),
    timestamp: message.__meta?.timestamp || record.timestamp,
    seq: message.__meta?.seq || record.seq,
    contextArchiveItem: {
      kind: 'message',
      seq: record.seq,
      ...(record.inherited !== undefined ? { inherited: record.inherited } : {}),
      ...(typeof record.sourceSessionId === 'string' ? { sourceSessionId: record.sourceSessionId } : {}),
    },
  };

  return {
    kind: 'message',
    message,
    seq: record.seq,
    timestamp: record.timestamp,
    ...(record.inherited !== undefined ? { inherited: record.inherited } : {}),
    ...(typeof record.sourceSessionId === 'string' ? { sourceSessionId: record.sourceSessionId } : {}),
  };
}

function buildContextBlockExpansionBlockItem(block: ArchiveBlockRecord): ContextBlockExpansionItem {
  const message = renderBlockMessage(block);
  message.__meta = {
    ...(message.__meta || {}),
    contextArchiveItem: {
      kind: 'block',
      id: block.id,
      ...(block.inherited !== undefined ? { inherited: block.inherited } : {}),
      ...(typeof block.sourceSessionId === 'string' ? { sourceSessionId: block.sourceSessionId } : {}),
    },
  };

  return {
    kind: 'block',
    message,
    block: buildContextBlockExpansionBlockPayload(block),
    timestamp: block.createdAt,
    ...(block.inherited !== undefined ? { inherited: block.inherited } : {}),
    ...(typeof block.sourceSessionId === 'string' ? { sourceSessionId: block.sourceSessionId } : {}),
  };
}

function buildRecallSyntaxHelp(detail: string): string {
  return `${detail}\n\nSupported recall target selectors:\n`
    + '- `overview` (or omit `target`) for available message/block ranges and examples\n'
    + '- `blocks` to list the current CTX-BLOCK frontier (top-level blocks in working context)\n'
    + '- `B#126` or `block#126` to inspect one CTX-BLOCK summary and its immediate source\n'
    + '- `msg:B#126` to expand the message log covered by a block\n'
    + '- `msg#10637-10680` or `msg#10637` to read message log entries\n\n'
    + 'Prefer `B#N` CTX-BLOCK drill-down first; message targets are precise/advanced and can return lots of irrelevant content.\n\n'
    + 'Examples:\n'
    + '- `recall({"target":"blocks"})`\n'
    + '- `recall({"target":"B#126"})`\n'
    + '- `recall({"target":"msg:B#126"})`\n'
    + '- `recall({"target":"msg#10637-10680"})`';
}

function recallSyntaxError(detail: string): Error {
  return new Error(buildRecallSyntaxHelp(detail));
}

function assertNoLegacyRecallArgs(args: ToolArgs): void {
  const legacyKeys = RECALL_LEGACY_ARG_NAMES.filter(key => Object.prototype.hasOwnProperty.call(args || {}, key));
  if (legacyKeys.length === 0) {
    return;
  }

  throw new Error(
    buildRecallSyntaxHelp(
      `recall no longer accepts legacy get_context_archive parameters: ${legacyKeys.join(', ')}. Use the target selector instead.`,
    ),
  );
}

function assertNoRemovedQueryArg(args: ToolArgs, toolName: 'recall' | 'get_session_messages'): void {
  if (!Object.prototype.hasOwnProperty.call(args || {}, 'query')) {
    return;
  }
  throw new Error(
    `${toolName} no longer accepts \`query\`. Use \`contentFilter\` for a literal case-insensitive result post-filter, `
    + (toolName === 'recall'
      ? 'use `vector_query` for semantic search, and use `target` to select a CTX-BLOCK or message range.'
      : 'or omit the filter to return all selected messages.'),
  );
}

function parseRecallPositiveInteger(rawValue: string, label: string): number {
  if (!/^\d+$/.test(rawValue)) {
    throw recallSyntaxError(`${label} must be a positive integer; got \`${rawValue}\`.`);
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw recallSyntaxError(`${label} must be a positive integer; got \`${rawValue}\`.`);
  }
  return value;
}

function normalizeRecallRange(start: number, end: number): { start: number; end: number } {
  return start <= end ? { start, end } : { start: end, end: start };
}

function parseRecallTarget(target: unknown): RecallTargetSpec {
  if (target === undefined || target === null) {
    return { kind: 'overview' };
  }
  if (typeof target !== 'string') {
    throw recallSyntaxError('recall target must be a string selector.');
  }

  const trimmed = target.trim();
  if (!trimmed || /^overview$/i.test(trimmed) || /^help$/i.test(trimmed)) {
    return { kind: 'overview' };
  }
  if (/^raw\b|^raw#|^raw:/i.test(trimmed)) {
    throw recallSyntaxError(`Target \`${trimmed}\` uses the old raw syntax. Use \`msg#...\` or \`msg:B#...\` instead.`);
  }
  if (/^latest:/i.test(trimmed)) {
    throw recallSyntaxError(`Target \`${trimmed}\` is not supported by recall. Use \`overview\`, \`blocks\`, \`B#N\`, \`msg:B#N\`, or \`msg#A-B\`.`);
  }
  if (/^blocks#/i.test(trimmed)) {
    throw recallSyntaxError(`Target \`${trimmed}\` is not supported. Use \`blocks\` for the current CTX-BLOCK frontier, or \`B#N\` for one block.`);
  }
  if (/^blocks$/i.test(trimmed)) {
    return { kind: 'blocks' };
  }

  let match = trimmed.match(/^(?:b|block)#(\d+)$/i);
  if (match) {
    return { kind: 'block', id: parseRecallPositiveInteger(match[1], 'block id') };
  }

  match = trimmed.match(/^msg\s*:\s*(?:b|block)#(\d+)$/i);
  if (match) {
    return { kind: 'blockMessages', id: parseRecallPositiveInteger(match[1], 'block id') };
  }

  match = trimmed.match(/^msg#(\d+)(?:-(?:msg#|#)?(\d+))?$/i);
  if (match) {
    const startSeq = parseRecallPositiveInteger(match[1], 'message seq');
    const endSeq = match[2] ? parseRecallPositiveInteger(match[2], 'message seq') : startSeq;
    const range = normalizeRecallRange(startSeq, endSeq);
    return { kind: 'messages', startSeq: range.start, endSeq: range.end };
  }

  throw recallSyntaxError(`Could not parse recall target \`${trimmed}\`.`);
}

function formatRecallExample(targetSessionId: string, includeSessionId: boolean, target?: string): string {
  const payload: Record<string, string> = {};
  if (includeSessionId) {
    payload.sessionId = targetSessionId;
  }
  if (target !== undefined) {
    payload.target = target;
  }
  return `recall(${JSON.stringify(payload)})`;
}

function formatRecallNextHints(targetSessionId: string, includeSessionId: boolean, targets: Array<string | undefined>): string {
  const seen = new Set<string>();
  const examples: string[] = [];
  for (const target of targets) {
    const example = formatRecallExample(targetSessionId, includeSessionId, target);
    if (seen.has(example)) {
      continue;
    }
    seen.add(example);
    examples.push(example);
    if (examples.length >= 3) {
      break;
    }
  }

  if (examples.length === 0) {
    return '';
  }

  return `\n\nSuggestions (optional; not exhaustive):\n${examples.map(example => `- \`${example}\``).join('\n')}`;
}

function formatRecallNextHintsIfEnabled(enabled: boolean, targetSessionId: string, includeSessionId: boolean, targets: Array<string | undefined>): string {
  return enabled ? formatRecallNextHints(targetSessionId, includeSessionId, targets) : '';
}

function getRecallPreviewBudget(count: number, previewLength: number): { requestedChars: number; overLimit: boolean; maxItemsWithinLimit: number } {
  const normalizedCount = Math.max(0, Math.floor(count));
  const normalizedPreviewLength = Math.max(0, Math.floor(previewLength));
  const requestedChars = calculatePreviewRequestChars(normalizedCount, normalizedPreviewLength);
  return {
    requestedChars,
    overLimit: requestedChars > ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT,
    maxItemsWithinLimit: normalizedPreviewLength > 0
      ? Math.max(1, Math.floor(ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT / normalizedPreviewLength))
      : normalizedCount,
  };
}

function capRecallBlockSummaryRecords(records: ArchiveBlockRecord[], previewLength: number): {
  records: ArchiveBlockRecord[];
  capped: boolean;
  requestedChars: number;
  maxItemsWithinLimit: number;
} {
  const budget = getRecallPreviewBudget(records.length, previewLength);
  if (!budget.overLimit) {
    return { records, capped: false, requestedChars: budget.requestedChars, maxItemsWithinLimit: budget.maxItemsWithinLimit };
  }

  return {
    records: records.slice(0, budget.maxItemsWithinLimit),
    capped: true,
    requestedChars: budget.requestedChars,
    maxItemsWithinLimit: budget.maxItemsWithinLimit,
  };
}

function summarizeBlockLevels(records: Array<{ id: number; level: number }>): string {
  if (records.length === 0) {
    return 'none';
  }

  const byLevel = new Map<number, { count: number; latestId: number }>();
  for (const record of records) {
    const current = byLevel.get(record.level) || { count: 0, latestId: 0 };
    current.count += 1;
    current.latestId = Math.max(current.latestId, record.id);
    byLevel.set(record.level, current);
  }

  return Array.from(byLevel.entries())
    .sort(([a], [b]) => a - b)
    .map(([level, value]) => `L${level}: ${value.count} (latest B#${value.latestId})`)
    .join(', ');
}

function sortArchiveBlocksByMessageRange(records: ArchiveBlockRecord[]): ArchiveBlockRecord[] {
  return [...records].sort((a, b) => (
    (a.rawStartSeq || 0) - (b.rawStartSeq || 0)
    || (a.rawEndSeq || 0) - (b.rawEndSeq || 0)
    || (a.rawStartTimestamp || 0) - (b.rawStartTimestamp || 0)
    || a.id - b.id
  ));
}

function selectRecallFrontierBlocks(records: ArchiveBlockRecord[]): ArchiveBlockRecord[] {
  const parentBlocks = records.filter(record => record.sourceKind === 'block');
  const frontier = records.filter(record => !parentBlocks.some(parent => (
    parent.id !== record.id
    && archiveBlockContainsSourceBlockId(parent, record.id)
  )));

  return sortArchiveBlocksByMessageRange(frontier);
}

async function getRecallBlockById(sessionId: string, id: number): Promise<ArchiveBlockRecord | undefined> {
  const result = await sessionManager.getArchivedBlocks(sessionId, { startId: id, endId: id });
  return result.records.find((record: ArchiveBlockRecord) => record.id === id);
}

async function getRecallChildBlocksForBlock(sessionId: string, block: ArchiveBlockRecord): Promise<ArchiveBlockRecord[]> {
  const sourceBlockIds = getArchiveBlockSourceBlockIds(block);
  if (!sourceBlockIds) {
    const result = await sessionManager.getArchivedBlocks(sessionId, {
      startId: block.sourceStart,
      endId: block.sourceEnd,
    });
    return result.records as ArchiveBlockRecord[];
  }

  const minId = Math.min(...sourceBlockIds);
  const maxId = Math.max(...sourceBlockIds);
  const order = new Map(sourceBlockIds.map((id, index) => [id, index]));
  const result = await sessionManager.getArchivedBlocks(sessionId, {
    startId: minId,
    endId: maxId,
  });
  return (result.records as ArchiveBlockRecord[])
    .filter(child => order.has(child.id))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

async function resolveRecallBlockMessageRange(
  sessionId: string,
  block: ArchiveBlockRecord,
  seenBlockIds: Set<number> = new Set(),
): Promise<{ startSeq: number; endSeq: number } | null> {
  if (typeof block.rawStartSeq === 'number' && typeof block.rawEndSeq === 'number'
    && Number.isFinite(block.rawStartSeq) && Number.isFinite(block.rawEndSeq)
    && block.rawStartSeq > 0 && block.rawEndSeq > 0) {
    const range = normalizeRecallRange(Math.trunc(block.rawStartSeq), Math.trunc(block.rawEndSeq));
    return { startSeq: range.start, endSeq: range.end };
  }

  if (block.sourceKind === 'message') {
    const range = normalizeRecallRange(block.sourceStart, block.sourceEnd);
    return { startSeq: range.start, endSeq: range.end };
  }

  if (block.sourceKind !== 'block' || seenBlockIds.has(block.id)) {
    return null;
  }

  seenBlockIds.add(block.id);
  const childRecords = await getRecallChildBlocksForBlock(sessionId, block);
  const ranges = await Promise.all(
    childRecords.map((child: ArchiveBlockRecord) => resolveRecallBlockMessageRange(sessionId, child, seenBlockIds)),
  );
  const validRanges = ranges.filter((range): range is { startSeq: number; endSeq: number } => !!range);
  if (validRanges.length === 0) {
    return null;
  }
  return {
    startSeq: Math.min(...validRanges.map(range => range.startSeq)),
    endSeq: Math.max(...validRanges.map(range => range.endSeq)),
  };
}


export async function tool_get_session_messages(args: ToolArgs, ctx?: ToolContext) {
  assertNoRemovedQueryArg(args, 'get_session_messages');
  await requireNotIsolated(ctx, 'get_session_messages');
  const { sessionId, start, count } = args;

  const session = await sessionManager.getExistingSession(sessionId);
  if (!session) {
    return `Session \`${sessionId}\` not found.`;
  }

  const totalMessages = session.history.length;
  let actualStart = start;
  let actualCount = count;

  if (actualStart === undefined && actualCount === undefined) {
    actualCount = 10;
    actualStart = Math.max(0, totalMessages - actualCount);
  } else if (actualStart === undefined) {
    actualStart = 0;
  } else if (actualCount === undefined) {
    actualCount = totalMessages - actualStart;
  }

  if (actualStart < 0) {
    actualStart = Math.max(0, totalMessages + actualStart);
  }

  actualStart = Math.max(0, Math.min(actualStart, totalMessages));
  actualCount = Math.min(actualCount, totalMessages - actualStart);

  const messages = await sessionManager.getSessionMessages(sessionId, actualStart, actualCount);

  if (messages.length === 0) {
    return `No messages found in session \`${sessionId}\` (total: ${totalMessages} messages).`;
  }

  const toolDetail = args.toolDetail as ContextPreviewToolDetail | undefined;
  const items = messages.map((message, index) => createMessageContextPreviewItem({
    key: `session:${actualStart + index}`,
    heading: formatMessageHeading({
      label: `[${actualStart + index}]`,
      message,
    }),
    message,
    hideDisplayOnlyContent: true,
    toolDetail,
    renderOptions: {
      previewLength: args.previewLength,
      contentFilter: args.contentFilter,
      includeRegex: args.includeRegex,
      excludeRegex: args.excludeRegex,
      toolDetail: args.toolDetail,
    },
  }));

  return renderContextPreviewItems({
    items,
    title: ({ matchedCount }) => {
      const filterSuffix = matchedCount === messages.length ? '' : ` (${matchedCount} matched after filters from ${messages.length} selected)`;
      return `Session \`${sessionId}\` - showing ${matchedCount} of ${totalMessages} message(s)${filterSuffix}:`;
    },
    emptyMessage: `No messages matched the requested filters in session \`${sessionId}\` (total: ${totalMessages} messages).`,
    options: {
      previewLength: args.previewLength,
      contentFilter: args.contentFilter,
      includeRegex: args.includeRegex,
      excludeRegex: args.excludeRegex,
      toolDetail: args.toolDetail,
    },
  }).text;
}

export async function tool_get_archived_messages(args: ToolArgs, ctx?: ToolContext) {
  const targetSessionId = args.sessionId || ctx?.sessionId;
  await checkArchivedReadPermission(ctx || {}, targetSessionId, 'get_archived_messages');

  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const result = await sessionManager.getArchivedMessages(targetSessionId, {
    startSeq: typeof args.startSeq === 'number' ? args.startSeq : undefined,
    endSeq: typeof args.endSeq === 'number' ? args.endSeq : undefined,
  });

  if (result.totalMatched === 0) {
    const availableRange = typeof result.availableRange.startSeq === 'number' || typeof result.availableRange.endSeq === 'number'
      ? ` Available archived seq range: ${typeof result.availableRange.startSeq === 'number' ? `#${result.availableRange.startSeq}` : '?'}-${typeof result.availableRange.endSeq === 'number' ? `#${result.availableRange.endSeq}` : '?'}.`
      : '';
    return `No archived messages matched for session \`${targetSessionId}\`.${availableRange}`;
  }

  return formatArchivedMessagePreview(targetSessionId, result.records, {
    totalMatched: result.totalMatched,
    startSeq: result.requestedRange.startSeq,
    endSeq: result.requestedRange.endSeq,
  }, {
    previewLength: args.previewLength,
    contentFilter: args.contentFilter,
    includeRegex: args.includeRegex,
    excludeRegex: args.excludeRegex,
    toolDetail: args.toolDetail,
  });
}


export async function tool_get_archived_blocks(args: ToolArgs, ctx?: ToolContext) {
  const targetSessionId = args.sessionId || ctx?.sessionId;
  await checkArchivedReadPermission(ctx || {}, targetSessionId, 'get_archived_blocks');

  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const result = await sessionManager.getArchivedBlocks(targetSessionId, {
    startId: typeof args.startId === 'number' ? args.startId : undefined,
    endId: typeof args.endId === 'number' ? args.endId : undefined,
  });

  return formatArchivedBlockPreview(targetSessionId, result.records, {
    totalMatched: result.totalMatched,
    startId: result.requestedRange.startId,
    endId: result.requestedRange.endId,
  }, {
    previewLength: args.previewLength,
    contentFilter: args.contentFilter,
    includeRegex: args.includeRegex,
    excludeRegex: args.excludeRegex,
  });
}

async function buildRecallOverview(targetSessionId: string, includeSessionId: boolean): Promise<string> {
  const [messageResult, blockResult] = await Promise.all([
    sessionManager.getArchivedMessages(targetSessionId, {}),
    sessionManager.getArchivedBlocks(targetSessionId, {}),
  ]);
  const blockRecords = blockResult.records as ArchiveBlockRecord[];
  const frontierBlocks = selectRecallFrontierBlocks(blockRecords);

  const messageRange = typeof messageResult.availableRange.startSeq === 'number'
    ? `${formatMessageLogRange(messageResult.availableRange.startSeq, messageResult.availableRange.endSeq)} (${messageResult.totalMatched} message(s))`
    : 'none';
  const blockIds = blockRecords.map(record => record.id);
  const minBlockId = blockIds.length ? Math.min(...blockIds) : undefined;
  const maxBlockId = blockIds.length ? Math.max(...blockIds) : undefined;
  const lastBlock = sortArchiveBlocksByMessageRange(blockRecords).slice(-1)[0];
  const blockRange = typeof minBlockId === 'number' && typeof maxBlockId === 'number'
    ? `${formatBlockIdRange(minBlockId, maxBlockId)} (${blockResult.totalMatched} total; frontier/top-level: ${frontierBlocks.length}; ${summarizeBlockLevels(blockRecords)})`
    : 'none';

  const exampleBlock = frontierBlocks[0] || lastBlock;
  const exampleTargets = [
    'blocks',
    exampleBlock ? `B#${exampleBlock.id}` : undefined,
  ];

  return [
    `Recall overview for session \`${targetSessionId}\`.`,
    '',
    `Available message log: ${messageRange}.`,
    `Layered CTX-BLOCK archive: ${blockRange}.`,
    '',
    'Your working context may already contain active CTX-BLOCK summaries. Prefer starting from a visible `B#N` and drill down one layer at a time; message targets can return lots of irrelevant content.',
    'Supported targets: `blocks`, `B#11`, `block#11`, `msg:B#11`, `msg#3907-4329`, `msg#3907`.',
  ].join('\n') + formatRecallNextHints(targetSessionId, includeSessionId, exampleTargets);
}

async function buildRecallMessagesByRange(
  targetSessionId: string,
  startSeq: number,
  endSeq: number,
  _previewLength: number,
  _includeSessionId: boolean,
  renderOptions: ContextPreviewRenderOptions,
): Promise<string> {
  const result = await sessionManager.getArchivedMessages(targetSessionId, { startSeq, endSeq });
  if (result.totalMatched === 0) {
    const availableRange = typeof result.availableRange.startSeq === 'number'
      ? ` Available message log range: ${formatMessageLogRange(result.availableRange.startSeq, result.availableRange.endSeq)}.`
      : '';
    return `No message log entries found for session \`${targetSessionId}\` at ${formatMessageLogRange(startSeq, endSeq)}.${availableRange}`;
  }

  return formatArchivedMessagePreview(targetSessionId, result.records, {
    totalMatched: result.totalMatched,
    startSeq: result.requestedRange.startSeq,
    endSeq: result.requestedRange.endSeq,
  }, renderOptions);
}

async function buildRecallFrontierBlocks(
  targetSessionId: string,
  _previewLength: number,
  includeSessionId: boolean,
  renderOptions: ContextPreviewRenderOptions,
): Promise<string> {
  const result = await sessionManager.getArchivedBlocks(targetSessionId, {});
  const frontierBlocks = selectRecallFrontierBlocks(result.records as ArchiveBlockRecord[]);
  if (frontierBlocks.length === 0) {
    return `No current CTX-BLOCK frontier blocks found for session \`${targetSessionId}\`.`
      + formatRecallNextHints(targetSessionId, includeSessionId, ['overview']);
  }

  const visibleRecords = await hydrateRecallBlockTimeRanges(targetSessionId, frontierBlocks);
  const items = visibleRecords.map(block => createArchivedBlockContextPreviewItem({
    key: `block:${block.id}`,
    headingPrefix: '- ',
    block,
  }));
  const firstBlock = visibleRecords[0] || frontierBlocks[0];
  const rendered = renderContextPreviewItems({
    items,
    title: ({ matchedCount }) => `Current CTX-BLOCK frontier for session \`${targetSessionId}\` - ${matchedCount} of ${frontierBlocks.length} top-level block(s), sorted by message range.`,
    emptyMessage: `No CTX-BLOCK frontier blocks matched the requested filters for session \`${targetSessionId}\`.`,
    options: renderOptions,
  }).text;
  return rendered
    + formatRecallNextHints(targetSessionId, includeSessionId, [
    `B#${firstBlock.id}`,
    'overview',
  ]);
}

async function buildRecallBlockDetail(
  targetSessionId: string,
  blockId: number,
  previewLength: number,
  includeSessionId: boolean,
  renderOptions: ContextPreviewRenderOptions,
  options: { includeSuggestions?: boolean } = {},
): Promise<string> {
  const includeSuggestions = options.includeSuggestions !== false;
  const block = await getRecallBlockById(targetSessionId, blockId);
  if (!block) {
    return `No CTX-BLOCK B#${blockId} found in session \`${targetSessionId}\`.`
      + formatRecallNextHintsIfEnabled(includeSuggestions, targetSessionId, includeSessionId, ['overview', 'blocks']);
  }

  const range = await resolveRecallBlockMessageRange(targetSessionId, block);
  const blockWithTime = await hydrateRecallBlockTimeRange(targetSessionId, block, range);
  const blockText = formatArchiveBlockContextText({
    ...blockWithTime,
    summary: truncateUnicodeSafe(blockWithTime.summary || '', previewLength) || '[empty summary]',
  });
  const header = [
    `CTX-BLOCK B#${blockWithTime.id} for session \`${targetSessionId}\`:`,
    `- Block: ${blockText}`,
    `- Covers: ${range ? formatMessageLogRange(range.startSeq, range.endSeq) : formatMessageLogRange(blockWithTime.rawStartSeq, blockWithTime.rawEndSeq)}`,
    `- Source: ${formatArchiveSourceLabel(blockWithTime.sourceKind, blockWithTime.sourceStart, blockWithTime.sourceEnd, blockWithTime.sourceBlockIds)}`,
    blockWithTime.inherited ? `- Origin: inherited from ${blockWithTime.sourceSessionId || 'unknown'}` : '- Origin: local',
  ];

  if (blockWithTime.sourceKind === 'message' && range) {
    const messageResult = await sessionManager.getArchivedMessages(targetSessionId, {
      startSeq: range.startSeq,
      endSeq: range.endSeq,
    });
    return `${header.join('\n')}\n\nSource messages:\n\n${formatArchivedMessagePreview(targetSessionId, messageResult.records, {
      totalMatched: messageResult.totalMatched,
      startSeq: messageResult.requestedRange.startSeq,
      endSeq: messageResult.requestedRange.endSeq,
    }, renderOptions)}` + formatRecallNextHintsIfEnabled(includeSuggestions, targetSessionId, includeSessionId, [
      'blocks',
      'overview',
    ]);
  }

  if (blockWithTime.sourceKind === 'block') {
    const childRecords = await getRecallChildBlocksForBlock(targetSessionId, blockWithTime);
    const capped = capRecallBlockSummaryRecords(childRecords, previewLength);
    const visibleChildRecords = await hydrateRecallBlockTimeRanges(targetSessionId, capped.records);
    const childItems = visibleChildRecords.map(child => createArchivedBlockContextPreviewItem({
      key: `block:${child.id}`,
      block: child,
    }));
    const childSection = renderContextPreviewItems({
      items: childItems,
      title: ({ matchedCount }) => `Immediate child blocks (${formatArchiveChildBlockReference(blockWithTime)}): showing ${matchedCount} of ${visibleChildRecords.length} CTX-BLOCK summary item(s).`,
      emptyMessage: '[no child CTX-BLOCK summaries matched the requested filters]',
      options: renderOptions,
    }).text;
    const capNote = capped.capped
      ? `\n\nChild block list has ${childRecords.length} block(s); showing ${capped.records.length} because ${childRecords.length} × ${previewLength} = ${capped.requestedChars} summary-preview characters exceeds the ${ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT}-character guard. Pick a specific child \`B#N\` to continue drilling down, or lower previewLength.`
      : '';
    return `${header.join('\n')}\n\n${childSection}`
      + capNote
      + formatRecallNextHintsIfEnabled(includeSuggestions, targetSessionId, includeSessionId, [
        visibleChildRecords[0] ? `B#${visibleChildRecords[0].id}` : undefined,
        'blocks',
      ]);
  }

  return header.join('\n') + formatRecallNextHintsIfEnabled(includeSuggestions, targetSessionId, includeSessionId, [
    'overview',
  ]);
}

async function buildRecallMessagesForBlock(
  targetSessionId: string,
  blockId: number,
  _previewLength: number,
  includeSessionId: boolean,
  renderOptions: ContextPreviewRenderOptions,
  options: { includeSuggestions?: boolean } = {},
): Promise<string> {
  const includeSuggestions = options.includeSuggestions !== false;
  const block = await getRecallBlockById(targetSessionId, blockId);
  if (!block) {
    return `No CTX-BLOCK B#${blockId} found in session \`${targetSessionId}\`.`
      + formatRecallNextHintsIfEnabled(includeSuggestions, targetSessionId, includeSessionId, ['overview', 'blocks']);
  }

  const range = await resolveRecallBlockMessageRange(targetSessionId, block);
  const blockWithTime = await hydrateRecallBlockTimeRange(targetSessionId, block, range);
  const rangeTimeSuffix = formatArchiveBlockTimeRange(blockWithTime);
  if (!range) {
    return `Could not determine the message log range covered by B#${blockId}. Inspect the block metadata first.`
      + formatRecallNextHintsIfEnabled(includeSuggestions, targetSessionId, includeSessionId, [`B#${blockId}`, 'overview']);
  }

  const result = await sessionManager.getArchivedMessages(targetSessionId, {
    startSeq: range.startSeq,
    endSeq: range.endSeq,
  });

  return `Messages covered by CTX-BLOCK B#${blockId} (${formatMessageLogRange(range.startSeq, range.endSeq)}${rangeTimeSuffix}) for session \`${targetSessionId}\`.\n\n`
    + formatArchivedMessagePreview(targetSessionId, result.records, {
      totalMatched: result.totalMatched,
      startSeq: result.requestedRange.startSeq,
      endSeq: result.requestedRange.endSeq,
    }, renderOptions);
}

export async function renderContextBlockExpansion(args: {
  sessionId: string;
  blockId: number;
  previewLength?: unknown;
}): Promise<ContextBlockExpansionResult> {
  const targetSessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : '';
  if (!targetSessionId) {
    throw contextBlockExpansionError('sessionId is required.', 400, 'SESSION_ID_REQUIRED');
  }

  const session = await sessionManager.getExistingSession(targetSessionId);
  if (!session) {
    throw contextBlockExpansionError(`Session \`${targetSessionId}\` not found.`, 404, 'SESSION_NOT_FOUND');
  }

  if (typeof args.blockId !== 'number' || !Number.isInteger(args.blockId) || args.blockId <= 0) {
    throw contextBlockExpansionError('blockId must be a positive integer.', 400, 'INVALID_CONTEXT_BLOCK_ID');
  }
  const blockId = args.blockId;

  const { budget: previewLength } = normalizeContextPreviewBudget(args.previewLength, RECALL_DEFAULT_PREVIEW_LENGTH);
  const renderOptions: ContextPreviewRenderOptions = {
    previewLength: args.previewLength,
    defaultPreviewLength: RECALL_DEFAULT_PREVIEW_LENGTH,
    toolDetail: 'names',
  };

  const block = await getRecallBlockById(targetSessionId, blockId);
  if (!block) {
    throw contextBlockExpansionError(`CTX-BLOCK B#${blockId} not found in session \`${targetSessionId}\`.`, 404, 'CTX_BLOCK_NOT_FOUND');
  }

  const range = await resolveRecallBlockMessageRange(targetSessionId, block);
  const expansionKind: ContextBlockExpansionKind = block.sourceKind === 'block' ? 'child-blocks' : 'messages';
  const items: ContextBlockExpansionItem[] = [];

  if (expansionKind === 'child-blocks') {
    const childBlocks = await getRecallChildBlocksForBlock(targetSessionId, block);
    const visibleChildBlocks = await hydrateRecallBlockTimeRanges(targetSessionId, childBlocks);
    items.push(...visibleChildBlocks.map(buildContextBlockExpansionBlockItem));
  } else if (range) {
    const result = await sessionManager.getArchivedMessages(targetSessionId, {
      startSeq: range.startSeq,
      endSeq: range.endSeq,
    });
    items.push(...(result.records as ArchiveMessageRecord[]).map(buildContextBlockExpansionMessageItem));
  }

  const text = await buildRecallBlockDetail(targetSessionId, blockId, previewLength, false, renderOptions, { includeSuggestions: false });

  return {
    sessionId: targetSessionId,
    blockId,
    expansionKind,
    target: `B#${blockId}`,
    previewLength,
    text,
    items,
    messages: items.map(item => item.message),
    totalItems: items.length,
    block: buildContextBlockExpansionBlockPayload(block),
  };
}

function normalizeRecallVectorLimit(value: unknown): number {
  if (value === undefined || value === null || value === '') {
    return 5;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('limit must be a positive number when provided.');
  }
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function vectorHitRawRange(hit: any): { startSeq: number; endSeq: number } | undefined {
  const start = getPositiveInteger(hit.raw_start_seq) ?? getPositiveInteger(hit.start_seq) ?? getPositiveInteger(hit.seq);
  const end = getPositiveInteger(hit.raw_end_seq) ?? getPositiveInteger(hit.end_seq) ?? start;
  if (typeof start !== 'number' || typeof end !== 'number') {
    return undefined;
  }
  const range = normalizeRecallRange(start, end);
  return { startSeq: range.start, endSeq: range.end };
}

async function vectorHitToPreviewItems(hit: any, renderOptions: ContextPreviewRenderOptions): Promise<ContextPreviewItem[]> {
  const sourceSessionId = String(hit.session_id || '');
  if (!sourceSessionId) {
    return [];
  }

  if (hit.kind === 'block' && typeof hit.block_id === 'number') {
    const result = await sessionManager.getArchivedBlocks(sourceSessionId, {
      startId: hit.block_id,
      endId: hit.block_id,
    });
    const block = (result.records as ArchiveBlockRecord[]).find(record => record.id === hit.block_id) || result.records[0];
    if (block) {
      const hydrated = await hydrateRecallBlockTimeRange(sourceSessionId, block as ArchiveBlockRecord);
      return [createArchivedBlockContextPreviewItem({
        key: `vector:block:${sourceSessionId}:${hydrated.id}`,
        headingPrefix: `[vector source session:${sourceSessionId}] `,
        block: hydrated,
        includeSourceText: formatArchiveSourceLabel(hydrated.sourceKind, hydrated.sourceStart, hydrated.sourceEnd, hydrated.sourceBlockIds),
      })];
    }
  }

  const range = vectorHitRawRange(hit);
  if (range) {
    const result = await sessionManager.getArchivedMessages(sourceSessionId, {
      startSeq: range.startSeq,
      endSeq: range.endSeq,
    });
    if (result.records.length > 0) {
      return result.records.map((record: any) => createMessageContextPreviewItem({
        key: `vector:msg:${sourceSessionId}:${record.seq}`,
        heading: formatMessageHeading({
          label: `[#${record.seq}${formatArchivedMessageTime(record)}]`,
          originLabel: `[vector source session:${sourceSessionId}]`,
          message: record.message,
        }),
        message: record.message,
        hideDisplayOnlyContent: true,
        toolDetail: renderOptions.toolDetail as ContextPreviewToolDetail | undefined,
        renderOptions,
      }));
    }
  }

  const seqLabel = range ? formatMessageLogRange(range.startSeq, range.endSeq) : `seq:${hit.seq ?? '?'}`;
  return [{
    key: `vector:fallback:${String(hit.id || `${sourceSessionId}:${seqLabel}`)}`,
    heading: `[vector source session:${sourceSessionId} ${seqLabel}]`,
    body: String(hit.text || hit.chunk_text || '[empty vector hit]'),
    searchText: String(hit.text || hit.chunk_text || ''),
  }];
}

async function buildRecallVectorQuery(
  args: ToolArgs,
  ctx: ToolContext | undefined,
  targetSessionId: string,
  renderOptions: ContextPreviewRenderOptions,
): Promise<string> {
  const vectorQuery = typeof args.vector_query === 'string' ? args.vector_query.trim() : '';
  if (!vectorQuery) {
    throw new Error('recall vector_query must be a non-empty string.');
  }

  const limit = normalizeRecallVectorLimit(args.limit);
  const { searchOptions, effectiveScope } = await resolveMemorySearchOptions({
    scope: args.scope,
    targetSessionId: args.sessionId || (args.scope === 'current-session' ? targetSessionId : undefined),
    targetAgentName: args.agentName,
  }, ctx);
  const candidateLimit = Math.max(limit * 4, 20);
  const hits = await vector.search(vectorQuery, candidateLimit, false, {
    ...searchOptions,
    preferBlocks: args.preferBlocks,
  }) as any[];

  const items: ContextPreviewItem[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const hitItems = await vectorHitToPreviewItems(hit, renderOptions);
    for (const item of hitItems) {
      if (seen.has(item.key)) {
        continue;
      }
      seen.add(item.key);
      items.push(item);
      if (items.length >= candidateLimit) {
        break;
      }
    }
    if (items.length >= candidateLimit) {
      break;
    }
  }

  return renderContextPreviewItems({
    items,
    title: ({ matchedCount }) => `Recall vector search for \`${vectorQuery}\` (${effectiveScope}; source archive ranges loaded before preview) - showing ${Math.min(matchedCount, limit)} source item(s) from ${hits.length} vector hit(s).`,
    emptyMessage: `No archived source messages or blocks found for vector_query \`${vectorQuery}\`.`,
    options: renderOptions,
  }).text;
}

export async function tool_recall(args: ToolArgs = {}, ctx?: ToolContext) {
  assertNoRemovedQueryArg(args, 'recall');
  assertNoLegacyRecallArgs(args);
  const targetSessionId = args.sessionId || ctx?.sessionId;
  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  await checkArchivedReadPermission(ctx || {}, targetSessionId, 'recall');

  const { budget: previewLength } = normalizeContextPreviewBudget(args.previewLength, RECALL_DEFAULT_PREVIEW_LENGTH);
  const renderOptions: ContextPreviewRenderOptions = {
    previewLength: args.previewLength,
    defaultPreviewLength: RECALL_DEFAULT_PREVIEW_LENGTH,
    contentFilter: args.contentFilter,
    includeRegex: args.includeRegex,
    excludeRegex: args.excludeRegex,
    toolDetail: args.toolDetail,
    contentFilterOmitHint: 'contentFilter is a literal result post-filter, not semantic search. Omit it to inspect the complete recalled CTX-BLOCK/message target; use vector_query to find context by meaning.',
  };
  const includeSessionId = isNonEmptyString(args.sessionId);

  if (isNonEmptyString(args.vector_query)) {
    return buildRecallVectorQuery(args, ctx, targetSessionId, renderOptions);
  }

  const target = parseRecallTarget(args.target);

  switch (target.kind) {
    case 'overview':
      return buildRecallOverview(targetSessionId, includeSessionId);
    case 'blocks':
      return buildRecallFrontierBlocks(targetSessionId, previewLength, includeSessionId, renderOptions);
    case 'block':
      return buildRecallBlockDetail(targetSessionId, target.id, previewLength, includeSessionId, renderOptions);
    case 'blockMessages':
      return buildRecallMessagesForBlock(targetSessionId, target.id, previewLength, includeSessionId, renderOptions);
    case 'messages':
      return buildRecallMessagesByRange(targetSessionId, target.startSeq, target.endSeq, previewLength, includeSessionId, renderOptions);
    default: {
      const exhaustive: never = target;
      throw recallSyntaxError(`Unsupported recall target ${(exhaustive as any)?.kind || ''}.`);
    }
  }
}

