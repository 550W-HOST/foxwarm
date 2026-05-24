import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import * as llm from './llm';
import * as sessionManager from './sessionManager';
import * as skills from './skills';
import * as timers from './timers';
import type { ChannelFile } from './channel';
import { getAgentDir, resolveModelConfig } from './config';
import { logger } from './common';
import { nodesManager } from './nodes/manager';
import { AGENTS_DIR, COMPACT_PERCENT } from './config';
import { clearSessionGoal, normalizeGoalText, resolveSessionGoalRemindEvery, resolveSessionGoalRemindOnTurnEnd, setSessionGoal } from './session/goal';
import { formatArchiveBlockContextText, formatArchiveBlockTimeRange, getArchiveBlockEndTimestamp, getArchiveBlockStartTimestamp, type ArchiveBlockRecord } from './session/layeredContext';
import { formatSessionMessagesPreview } from './utils/messagePreview';
import { formatMessagePreviewText, formatPrefixedMultilineText } from './utils/messageFormat';
import { formatModelVisibilitySuffix, redactDisplayOnlyMessageForModel } from './session/messageVisibility';
import { truncateUnicodeSafe } from './utils/unicode';
import { formatLocalTimestamp } from './utils/localTime';
import { requireNotIsolated, checkArchivedReadPermission, checkChannelPermission, checkPathAccess, checkSendFilePermission, checkTimerPermission } from './isolatedCheck';
import { COMPACT_PLAN_TOOL_NAME } from './session/compactPlan';

interface ToolContext {
  sessionId?: string;
  session?: any;
  broadcast?: (text: string, options?: any) => Promise<void>;
  runtimeNodeId?: string;
}

type ToolArgs = Record<string, any>;

const ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT = 20_000;
const RECALL_DEFAULT_PREVIEW_LENGTH = 1000;
const RECALL_LEGACY_ARG_NAMES = [
  'startSeq',
  'endSeq',
  'startId',
  'endId',
  'includeMessages',
  'includeBlocks',
];

function buildEndTurnResult(_reason?: string) {
  return { output: 'ok', __toolLoopControl: { stopCurrentTurn: true } };
}

function normalizeWaitTimeoutSeconds(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const timeoutSeconds = Number(value);
  if (!Number.isFinite(timeoutSeconds)) {
    throw new Error('timeoutSeconds must be a non-negative number.');
  }
  if (timeoutSeconds < 0) {
    throw new Error('timeoutSeconds must be a non-negative number.');
  }
  if (timeoutSeconds === 0) {
    return undefined;
  }

  return timeoutSeconds;
}

function normalizeWaitAllSessions(value: unknown): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error('waitAllSessions must be an array of session IDs.');
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') {
      throw new Error('waitAllSessions entries must be non-empty strings.');
    }

    const sessionId = entry.trim();
    if (!sessionId) {
      throw new Error('waitAllSessions entries must be non-empty strings.');
    }

    if (!seen.has(sessionId)) {
      seen.add(sessionId);
      normalized.push(sessionId);
    }
  }

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

function normalizePositivePreviewLength(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function calculatePreviewRequestChars(itemCount: number, previewLength: number): number {
  const normalizedCount = Math.max(0, Math.floor(itemCount));
  if (normalizedCount <= 1) {
    return 0;
  }
  return normalizedCount * previewLength;
}

function assertPreviewRequestWithinLimit(
  toolName: string,
  segments: Array<{ label: string; count: number; previewLength: number }>,
): void {
  const evaluatedSegments = segments
    .map(segment => {
      const count = Math.max(0, Math.floor(segment.count));
      const previewLength = Math.max(0, Math.floor(segment.previewLength));
      return {
        ...segment,
        count,
        previewLength,
        requestedChars: calculatePreviewRequestChars(count, previewLength),
      };
    })
    .filter(segment => segment.count > 0);

  const totalRequestedChars = evaluatedSegments.reduce((sum, segment) => sum + segment.requestedChars, 0);
  if (totalRequestedChars <= ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT) {
    return;
  }

  const detailText = evaluatedSegments
    .map(segment => `${segment.label}: ${segment.count} × ${segment.previewLength}${segment.count <= 1 ? ' (single-item request exempt)' : ` = ${segment.requestedChars}`}`)
    .join('; ');

  throw new Error(
    `Request too large for ${toolName}: requested preview budget is ${totalRequestedChars} characters, exceeding the ${ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT}-character limit. `
    + `First narrow the range or locate the relevant message/block position, then request fuller content. ${detailText}`,
  );
}

const MIME_TYPE_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};

function formatTimerTimestamp(timestamp?: number | null): string {
  if (!timestamp) return 'n/a';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'n/a' : date.toISOString();
}

function formatTimerSummary(timer: timers.TimerView): string {
  const mode = timer.mode === 'cron'
    ? `cron: ${timer.cron}`
    : `at: ${formatTimerTimestamp(timer.at)}`;
  const target = timer.newSession
    ? `new session (${timer.agentName || 'main'} / ${timer.sessionPrefix || 'timer'})`
    : `session ${timer.sessionId}`;

  return `Timer \`${timer.id}\` created.\nMode: ${mode}\nTarget: ${target}\nNext run: ${formatTimerTimestamp(timer.nextRunAt)}\nMessage: ${timer.message}`;
}

function expandHomePath(filePath: string): string {
  if (filePath === '~') {
    return os.homedir();
  }
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function resolveAgentPath(filePath: string, agentName: string = 'main', sessionCwd?: string): string {
  const expandedPath = expandHomePath(filePath);
  if (path.isAbsolute(expandedPath)) {
    return path.resolve(expandedPath);
  }

  const agentDir = getAgentDir(agentName);
  const baseDir = (typeof sessionCwd === 'string' && sessionCwd.trim().length > 0)
    ? expandHomePath(sessionCwd.trim())
    : agentDir;

  return path.resolve(baseDir, expandedPath);
}

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPE_BY_EXT[ext] || 'application/octet-stream';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizeToolModelKey(value: unknown): string | undefined {
  if (!isNonEmptyString(value)) {
    return undefined;
  }

  const normalized = value.trim();
  const { modelsConfig } = resolveModelConfig(undefined);
  if (!modelsConfig.models[normalized]) {
    throw new Error(`Unknown model \`${normalized}\`. Use /model to list available models.`);
  }

  return normalized;
}

function formatMessageLogRange(startSeq?: number, endSeq?: number): string {
  if (typeof startSeq !== 'number' || !Number.isFinite(startSeq)) {
    return 'msg#?';
  }

  const start = Math.trunc(startSeq);
  if (typeof endSeq !== 'number' || !Number.isFinite(endSeq) || Math.trunc(endSeq) === start) {
    return `msg#${start}`;
  }

  return `msg#${start}-${Math.trunc(endSeq)}`;
}

function formatBlockIdRange(startId?: number, endId?: number): string {
  if (typeof startId !== 'number' || !Number.isFinite(startId)) {
    return 'B#?';
  }

  const start = Math.trunc(startId);
  if (typeof endId !== 'number' || !Number.isFinite(endId) || Math.trunc(endId) === start) {
    return `B#${start}`;
  }

  return `B#${start}-B#${Math.trunc(endId)}`;
}

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

function getPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
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
  previewLength: number,
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

  let result = `Archived messages for session \`${sessionId}\` - showing ${records.length} of ${meta.totalMatched} matched message(s)${rangeLabel}.\n\n`;
  for (const record of records) {
    const message = redactDisplayOnlyMessageForModel(record.message);
    const roleEmoji = message.role === 'user' ? '👤' : message.role === 'model' ? '🤖' : '🔧';
    const preview = formatMessagePreviewText(message, previewLength, {
      skipEphemeralSystem: true,
      skipRagMemorySnippets: true,
      skipThinking: true,
    });
    const originLabel = record.inherited
      ? `[inherited from ${record.sourceSessionId || 'unknown'}] `
      : '[local] ';
    result += `${formatPrefixedMultilineText(`[#${record.seq}${formatArchivedMessageTime(record)}] ${originLabel}${roleEmoji} ${record.message.role}${formatModelVisibilitySuffix(record.message)}: `, preview)}\n`;
  }
  return result;
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
  previewLength: number,
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

  let result = `Archived layered-context blocks for session \`${sessionId}\` - showing ${records.length} of ${meta.totalMatched} matched block(s)${rangeLabel}.

`;
  for (const record of records) {
    result += `${formatArchivedBlockPreviewLine(record, previewLength)}
`;
  }
  return result;
}

function formatArchivedBlockPreviewLine(
  record: {
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
  },
  previewLength: number,
  options: { includeSourceSuffix?: boolean } = {},
): string {
  const locality = record.inherited ? `[inherited from ${record.sourceSessionId || 'unknown'}] ` : '[local] ';
  const blockText = formatArchiveBlockContextText({
    ...record,
    summary: truncateUnicodeSafe(record.summary || '', previewLength) || '[empty summary]',
  });
  const text = options.includeSourceSuffix === false
    ? blockText
    : `${blockText} from ${formatArchiveSourceLabel(record.sourceKind, record.sourceStart, record.sourceEnd, record.sourceBlockIds)}`;
  return formatPrefixedMultilineText(locality, text);
}

type RecallTargetSpec =
  | { kind: 'overview' }
  | { kind: 'blocks' }
  | { kind: 'block'; id: number }
  | { kind: 'blockMessages'; id: number }
  | { kind: 'messages'; startSeq: number; endSeq: number };

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

function buildRecallMessageChunkTargets(startSeq: number, endSeq: number, previewLength: number, maxChunks: number = 3): string[] {
  const totalMessages = Math.max(1, endSeq - startSeq + 1);
  const budget = getRecallPreviewBudget(totalMessages, previewLength);
  const chunkSize = Math.max(1, budget.maxItemsWithinLimit);
  const chunks: string[] = [];
  let cursor = startSeq;
  while (cursor <= endSeq && chunks.length < maxChunks) {
    const chunkEnd = Math.min(endSeq, cursor + chunkSize - 1);
    chunks.push(formatMessageLogRange(cursor, chunkEnd));
    cursor = chunkEnd + 1;
  }
  return chunks;
}

function buildRecallMessageBudgetNotice(options: {
  targetSessionId: string;
  includeSessionId: boolean;
  blockId?: number;
  startSeq: number;
  endSeq: number;
  messageCount: number;
  previewLength: number;
  preferBlockFirst?: boolean;
  rangeSuffix?: string;
}): string {
  const { targetSessionId, includeSessionId, blockId, startSeq, endSeq, messageCount, previewLength, preferBlockFirst, rangeSuffix = '' } = options;
  const budget = getRecallPreviewBudget(messageCount, previewLength);
  const rangeTarget = `${formatMessageLogRange(startSeq, endSeq)}${rangeSuffix}`;
  const prefix = typeof blockId === 'number'
    ? `CTX-BLOCK B#${blockId} covers ${rangeTarget} (${messageCount} message(s)).`
    : `Target ${rangeTarget} matches ${messageCount} message(s).`;
  const chunks = buildRecallMessageChunkTargets(startSeq, endSeq, previewLength)
    .map(target => formatRecallExample(targetSessionId, includeSessionId, target));
  const lowerPreview = Math.max(1, Math.floor(ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT / Math.max(2, messageCount)));
  const suggestions = [
    preferBlockFirst
      ? 'If a covering CTX-BLOCK hierarchy is available, drill down through child blocks before expanding a broad message range.'
      : undefined,
    chunks.length > 0 ? `Try a narrower message chunk such as ${chunks.map(example => `\`${example}\``).join(' or ')}.` : undefined,
    lowerPreview < previewLength ? `Or lower previewLength (for example ${lowerPreview}) for this message range.` : undefined,
  ].filter(Boolean).join(' ');

  return `${prefix} Estimated preview budget is ${messageCount} × ${previewLength} = ${budget.requestedChars} characters, exceeding the ${ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT}-character limit. ${suggestions}`.trim();
}

function throwRecallMessageBudgetError(options: Parameters<typeof buildRecallMessageBudgetNotice>[0]): never {
  throw new Error(`${buildRecallMessageBudgetNotice(options)}\n\n${buildRecallSyntaxHelp('Message target is too broad for recall preview output. Prefer `B#N` CTX-BLOCK drill-down first when you have a block id; use message targets only for precise ranges.')}`);
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

function formatRecallBlockDirectoryLine(record: ArchiveBlockRecord, previewLength: number): string {
  const origin = record.inherited ? ` [inherited from ${record.sourceSessionId || 'unknown'}]` : ' [local]';
  const blockText = formatArchiveBlockContextText({
    ...record,
    summary: truncateUnicodeSafe(record.summary || '', previewLength) || '[empty summary]',
  });
  return `- ${blockText}${origin}`;
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


function shouldEnforceIsolatedMasterPathAccess(ctx?: ToolContext): boolean {
  return sessionManager.isSessionEffectivelyIsolated(ctx?.session) && (ctx?.runtimeNodeId || ctx?.session?.currentNode || 'master') === 'master';
}

async function prepareRemoteChannelFile(filePath: string, nodeId: string, ctx?: ToolContext): Promise<ChannelFile> {
  if (!ctx?.sessionId) {
    throw new Error('send_file requires an active session context when reading a file from a remote node.');
  }
  const payload = await nodesManager.readFileFromNode(nodeId, filePath, ctx.sessionId);
  const agentName = ctx?.session?.agent || 'main';
  const tempDir = path.join(getAgentDir(agentName), '.temp', 'send-file-cache');
  await fs.ensureDir(tempDir);
  const ext = path.extname(payload.name || filePath);
  const tempPath = path.join(tempDir, `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext}`);
  await fs.writeFile(tempPath, Buffer.from(payload.dataBase64, 'base64'));
  return {
    path: tempPath,
    name: payload.name || path.basename(filePath),
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes,
    isImage: payload.isImage,
  };
}

async function prepareChannelFile(filePath: string, ctx?: ToolContext): Promise<ChannelFile> {
  const agentName = ctx?.session?.agent || 'main';
  const fileNodeId = ctx?.runtimeNodeId || ctx?.session?.currentNode || 'master';
  if (fileNodeId !== 'master') {
    return prepareRemoteChannelFile(filePath, fileNodeId, ctx);
  }

  const fullPath = resolveAgentPath(filePath, agentName, ctx?.session?.cwd);
  if (shouldEnforceIsolatedMasterPathAccess(ctx)) {
    checkPathAccess(fullPath, agentName);
  }
  const stats = await fs.stat(fullPath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const mimeType = detectMimeType(fullPath);
  return {
    path: fullPath,
    name: path.basename(fullPath),
    mimeType,
    sizeBytes: stats.size,
    isImage: mimeType.startsWith('image/'),
  };
}

function formatSendFileSessionResult(targetSessionId: string, file: ChannelFile, result: sessionManager.FileDeliveryResult): string {
  const lines = [
    `File \`${file.name}\` sent for session \`${targetSessionId}\`.`,
    `Delivered: ${result.deliveredChannels.length}`,
  ];

  if (result.deliveredChannels.length) {
    lines.push(`Channels: ${result.deliveredChannels.map(id => `\`${id}\``).join(', ')}`);
  }

  if (result.skippedChannels.length) {
    lines.push(`Skipped: ${result.skippedChannels.map(item => `\`${item.channelId}\` (${item.reason})`).join(', ')}`);
  }

  if (result.failedChannels.length) {
    lines.push(`Failed: ${result.failedChannels.map(item => `\`${item.channelId}\` (${item.error})`).join(', ')}`);
  }

  return lines.join('\n');
}

function isWebUiUnsupportedFileDelivery(channelId: string, reason: string): boolean {
  return channelId.startsWith('webui:') && reason === 'channel does not support file sending yet';
}

function buildSendFileResult(output: string, file: ChannelFile) {
  return {
    output,
    fullPath: file.path,
  };
}

export async function tool_create_child_session(args: ToolArgs, ctx: ToolContext) {
  await requireNotIsolated(ctx, 'create_child_session');
  const { suffix, fork = false, message, node, noFurtherAssistantReply } = args;

  if (!ctx || !ctx.sessionId) {
    throw new Error('Cannot create child session: missing context');
  }

  const currentSessionId = ctx.sessionId;
  const childSessionId = await sessionManager.createChildSession(currentSessionId, suffix, fork, { node });

  if (message) {
    sessionManager.sendToSession(childSessionId, message, currentSessionId).catch(err => {
      logger.error({ err, childSessionId }, 'Failed to send initial message to child session');
    });
    const output = `Child session created: \`${childSessionId}\` (${fork ? 'forked from parent' : 'new session'}). Initial message sent.`;
    return noFurtherAssistantReply
      ? { ...buildEndTurnResult(), output }
      : output;
  }

  const output = `Child session created: \`${childSessionId}\` (${fork ? 'forked from parent' : 'new session'})`;
  return noFurtherAssistantReply
    ? { ...buildEndTurnResult(), output }
    : output;
}

export async function tool_send_to_session(args: ToolArgs, ctx: ToolContext) {
  const { sessionId, message, noFurtherAssistantReply } = args;
  const fromSessionId = ctx?.sessionId;

  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required');
  }

  await sessionManager.sendToSession(sessionId, message, fromSessionId);
  const output = `Message sent to session \`${sessionId}\``;
  return noFurtherAssistantReply
    ? { ...buildEndTurnResult(), output }
    : output;
}

export async function tool_wait(args: ToolArgs, ctx?: ToolContext) {
  const { reason } = args || {};
  const timeoutSeconds = normalizeWaitTimeoutSeconds(args?.timeoutSeconds);
  const waitAllSessions = normalizeWaitAllSessions(args?.waitAllSessions);

  if (ctx?.sessionId) {
    const waitState = await sessionManager.startSessionWait(ctx.sessionId, {
      reason: typeof reason === 'string' ? reason : undefined,
      timeoutSeconds,
      waitAllSessions,
    });

    if (timeoutSeconds !== undefined) {
      await timers.createWaitTimeoutTimer({
        sessionId: ctx.sessionId,
        waitId: waitState.id,
        timeoutSeconds,
      });
    }
  } else if (timeoutSeconds !== undefined) {
    throw new Error('Cannot use wait timeout without session context.');
  }

  return buildEndTurnResult(typeof reason === 'string' ? reason : undefined);
}

export async function tool_submit_compact_plan() {
  return `${COMPACT_PLAN_TOOL_NAME} is only valid inside the dedicated compact planning flow. Request compaction with compact_session and only submit a plan when the system compact prompt explicitly asks for it.`;
}

export async function tool_send_to_channel(args: ToolArgs, ctx?: ToolContext) {
  const { channelTargetId, message } = args;
  if (!channelTargetId || typeof channelTargetId !== 'string') {
    throw new Error('channelTargetId is required (format: <channel-instance-id>:<conversation-id>)');
  }
  if (!message || typeof message !== 'string') {
    throw new Error('message is required');
  }

  // Check isolated session channel permission
  if (ctx?.sessionId) {
    await checkChannelPermission(ctx.sessionId, channelTargetId);
  }

  await sessionManager.sendToChannelTargetId(channelTargetId, message);
  return `Message sent to channel target \`${channelTargetId}\``;
}

export async function tool_send_file(args: ToolArgs, ctx?: ToolContext) {
  const { sessionId, channelTargetId, filePath } = args;
  const hasSessionId = isNonEmptyString(sessionId);
  const normalizedChannelTargetId = isNonEmptyString(channelTargetId)
    ? channelTargetId.trim()
    : undefined;
  const hasChannelTargetId = Boolean(normalizedChannelTargetId);
  const normalizedSessionId = hasSessionId
    ? sessionId.trim()
    : (ctx?.sessionId ? ctx.sessionId : undefined);

  if (hasSessionId && hasChannelTargetId) {
    throw new Error('At most one of sessionId or channelTargetId may be specified');
  }
  if (!normalizedSessionId && !hasChannelTargetId) {
    throw new Error('sessionId or channelTargetId is required when there is no active session context');
  }
  if (!isNonEmptyString(filePath)) {
    throw new Error('filePath is required');
  }

  const caption = isNonEmptyString(args.caption)
    ? args.caption.trim()
    : (isNonEmptyString(args.text) ? args.text.trim() : undefined);

  if (ctx?.sessionId) {
    await checkSendFilePermission(ctx.sessionId, {
      channelTargetId: normalizedChannelTargetId,
      targetSessionId: normalizedChannelTargetId ? undefined : normalizedSessionId,
    });
  }

  const file = await prepareChannelFile(filePath.trim(), ctx);

  if (normalizedChannelTargetId) {
    if (normalizedChannelTargetId.startsWith('webui:')) {
      return buildSendFileResult(`File \`${file.name}\` is ready for WebUI target \`${normalizedChannelTargetId}\`.`, file);
    }

    await sessionManager.sendFileToChannelTargetId(normalizedChannelTargetId, file, { caption });
    return buildSendFileResult(`File \`${file.name}\` sent to channel target \`${normalizedChannelTargetId}\``, file);
  }

  const result = await sessionManager.sendFileToSession(normalizedSessionId, file, { caption });
  const hasWebUiDownloadFallback = result.skippedChannels.some((item) => isWebUiUnsupportedFileDelivery(item.channelId, item.reason));
  const output = formatSendFileSessionResult(normalizedSessionId, file, result);

  if (hasWebUiDownloadFallback && result.deliveredChannels.length === 0 && result.failedChannels.length === 0) {
    return buildSendFileResult(output, file);
  }

  if (result.deliveredChannels.length === 0) {
    throw new Error(output);
  }

  if (hasWebUiDownloadFallback) {
    return buildSendFileResult(output, file);
  }

  return buildSendFileResult(output, file);
}

export async function tool_list_sessions(args: ToolArgs = {}, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'list_sessions');
  const sessions = sessionManager.listSessions();

  if (sessions.length === 0) {
    return 'No sessions found.';
  }

  const total = sessions.length;
  const rawStart = typeof args.start === 'number' && !Number.isNaN(args.start) ? Math.trunc(args.start) : 0;
  const rawCount = typeof args.count === 'number' && !Number.isNaN(args.count) ? Math.trunc(args.count) : 20;
  const start = Math.max(0, Math.min(rawStart, total));
  const count = Math.max(0, rawCount);
  const pageSessions = sessions.slice(start, start + count);

  if (pageSessions.length === 0) {
    return `No sessions found in the requested range. Total sessions: ${total}.`;
  }

  const end = start + pageSessions.length;
  let result = `Found ${total} session(s). Showing ${start + 1}-${end}.`;
  if (end < total) {
    result += ` Use \`start: ${end}\` to see the next page.`;
  }
  result += '\n\n';

  for (const s of pageSessions) {
    const date = s.lastMessageTime ? new Date(s.lastMessageTime).toISOString() : 'never';
    const channel = s.hasChannel ? '📱' : '🤖';
    const displayName = s.displayName ? ` (${s.displayName})` : '';
    const node = s.currentNode || 'master';
    const isolated = s.isolated ? ' isolated' : '';
    const busy = s.busy ? ' 🔄busy' : '';
    const queued = s.queueLength ? ` queue:${s.queueLength}` : '';
    result += `${channel} \`${s.id}\`${displayName} - ${s.messageCount} messages - node: \`${node}\`${isolated}${busy}${queued} - Last: ${date}\n`;
  }

  return result;
}

export async function tool_list_agents(args: ToolArgs = {}, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'list_agents');
  const agentsDir = AGENTS_DIR;

  if (!await fs.pathExists(agentsDir)) {
    return 'No agents directory found.';
  }

  const entries = await fs.readdir(agentsDir, { withFileTypes: true });
  const agents: Array<{name: string, hasSessions: boolean, sessionCount: number, inherit?: string, isolated?: boolean, isolatedNode?: string}> = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const agentName = entry.name;
      const sessions = Array.from(sessionManager.getAllSessions().values())
        .filter(sess => (sess.agent || 'main') === agentName);

      agents.push({
        name: agentName,
        hasSessions: sessions.length > 0,
        sessionCount: sessions.length,
        inherit: sessionManager.getAgentMetadata(agentName).inherit,
        isolated: sessionManager.getAgentMetadata(agentName).isolated,
        isolatedNode: sessionManager.getAgentIsolationNode(agentName),
      });
    }
  }

  if (agents.length === 0) {
    return 'No agents found.';
  }

  let result = `Found ${agents.length} agent(s):\n\n`;
  for (const agent of agents) {
    result += `- **${agent.name}**`;
    if (agent.hasSessions) {
      result += ` (${agent.sessionCount} session${agent.sessionCount > 1 ? 's' : ''})`;
    }
    if (agent.inherit) {
      result += ` [inherits: ${agent.inherit}]`;
    }
    if (agent.isolated) {
      result += ` [isolated${agent.isolatedNode ? `:${agent.isolatedNode}` : ''}]`;
    }
    result += '\n';
  }

  return result;
}

export async function tool_list_skills(args: ToolArgs = {}, ctx?: ToolContext) {
  const agentName = typeof args.agentName === 'string' && args.agentName.trim()
    ? args.agentName.trim()
    : (ctx?.session?.agent || 'main');
  const skillList = await skills.listSkills({ agentName });

  if (skillList.length === 0) {
    return `No skills found for agent "${agentName}".`;
  }

  let result = `Found ${skillList.length} skill(s) for agent "${agentName}":\n\n`;
  for (const skill of skillList) {
    result += `- **${skill.name}**`;
    result += ` [${skills.formatSkillSourceLabel(skill)}]`;
    if (skill.description) {
      result += ` - ${skill.description}`;
    }
    if (skill.documentFiles.length > 0) {
      result += ` (${skill.documentFiles.length} document${skill.documentFiles.length > 1 ? 's' : ''})`;
    }
    result += '\n';
  }

  return result;
}

export async function tool_load_skill(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'load_skill');
  const { skillName } = args;
  const agentName = typeof args.agentName === 'string' && args.agentName.trim()
    ? args.agentName.trim()
    : (ctx?.session?.agent || 'main');

  if (!skillName || typeof skillName !== 'string') {
    throw new Error('skillName is required');
  }

  const { info, documents } = await skills.loadSkillDocuments(skillName, { agentName });

  let result = `Skill: ${info.name}`;
  if (info.description) {
    result += `\nDescription: ${info.description}`;
  }
  result += `\nSource: ${skills.formatSkillSourceLabel(info)}`;
  result += `\nMetadata: ${info.metadataPath}`;

  if (documents.length === 0) {
    return result + '\n\n(No skill memory documents found.)';
  }

  result += '\n\n';
  for (const document of documents) {
    result += `FILE: ${document.filePath}\n${document.content}\n\n`;
  }

  return result.trimEnd();
}

export async function tool_get_session_messages(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'get_session_messages');
  const { sessionId, start, count } = args;
  const previewLength = normalizePositivePreviewLength(args.previewLength, 100);

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

  assertPreviewRequestWithinLimit('get_session_messages', [
    { label: 'messages', count: actualCount, previewLength },
  ]);

  const messages = await sessionManager.getSessionMessages(sessionId, actualStart, actualCount);

  if (messages.length === 0) {
    return `No messages found in session \`${sessionId}\` (total: ${totalMessages} messages).`;
  }

  return formatSessionMessagesPreview(sessionId, messages, actualStart, totalMessages, previewLength, {
    hideDisplayOnlyContent: true,
  });
}

export async function tool_get_archived_messages(args: ToolArgs, ctx?: ToolContext) {
  const targetSessionId = args.sessionId || ctx?.sessionId;
  await checkArchivedReadPermission(ctx || {}, targetSessionId, 'get_archived_messages');
  const previewLength = normalizePositivePreviewLength(args.previewLength, 1000);

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

  assertPreviewRequestWithinLimit('get_archived_messages', [
    { label: 'archived messages', count: result.records.length, previewLength },
  ]);

  return formatArchivedMessagePreview(targetSessionId, result.records, {
    totalMatched: result.totalMatched,
    startSeq: result.requestedRange.startSeq,
    endSeq: result.requestedRange.endSeq,
  }, previewLength);
}


export async function tool_get_archived_blocks(args: ToolArgs, ctx?: ToolContext) {
  const targetSessionId = args.sessionId || ctx?.sessionId;
  await checkArchivedReadPermission(ctx || {}, targetSessionId, 'get_archived_blocks');
  const previewLength = normalizePositivePreviewLength(args.previewLength, 1000);

  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const result = await sessionManager.getArchivedBlocks(targetSessionId, {
    startId: typeof args.startId === 'number' ? args.startId : undefined,
    endId: typeof args.endId === 'number' ? args.endId : undefined,
  });

  assertPreviewRequestWithinLimit('get_archived_blocks', [
    { label: 'archived blocks', count: result.records.length, previewLength },
  ]);

  return formatArchivedBlockPreview(targetSessionId, result.records, {
    totalMatched: result.totalMatched,
    startId: result.requestedRange.startId,
    endId: result.requestedRange.endId,
  }, previewLength);
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
  previewLength: number,
  includeSessionId: boolean,
): Promise<string> {
  const result = await sessionManager.getArchivedMessages(targetSessionId, { startSeq, endSeq });
  if (result.totalMatched === 0) {
    const availableRange = typeof result.availableRange.startSeq === 'number'
      ? ` Available message log range: ${formatMessageLogRange(result.availableRange.startSeq, result.availableRange.endSeq)}.`
      : '';
    return `No message log entries found for session \`${targetSessionId}\` at ${formatMessageLogRange(startSeq, endSeq)}.${availableRange}`;
  }

  if (getRecallPreviewBudget(result.records.length, previewLength).overLimit) {
    throwRecallMessageBudgetError({
      targetSessionId,
      includeSessionId,
      startSeq,
      endSeq,
      messageCount: result.records.length,
      previewLength,
    });
  }

  return formatArchivedMessagePreview(targetSessionId, result.records, {
    totalMatched: result.totalMatched,
    startSeq: result.requestedRange.startSeq,
    endSeq: result.requestedRange.endSeq,
  }, previewLength);
}

async function buildRecallFrontierBlocks(
  targetSessionId: string,
  previewLength: number,
  includeSessionId: boolean,
): Promise<string> {
  const result = await sessionManager.getArchivedBlocks(targetSessionId, {});
  const frontierBlocks = selectRecallFrontierBlocks(result.records as ArchiveBlockRecord[]);
  if (frontierBlocks.length === 0) {
    return `No current CTX-BLOCK frontier blocks found for session \`${targetSessionId}\`.`
      + formatRecallNextHints(targetSessionId, includeSessionId, ['overview']);
  }

  const capped = capRecallBlockSummaryRecords(frontierBlocks, previewLength);
  const visibleRecords = await hydrateRecallBlockTimeRanges(targetSessionId, capped.records);
  const body = visibleRecords.map(block => formatRecallBlockDirectoryLine(block, previewLength)).join('\n');
  const capNote = capped.capped
    ? `\n\nFrontier has ${frontierBlocks.length} block(s); showing ${capped.records.length} because ${frontierBlocks.length} × ${previewLength} = ${capped.requestedChars} summary-preview characters exceeds the ${ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT}-character guard. Pick a specific \`B#N\` to drill down, or lower previewLength.`
    : '';
  const firstBlock = visibleRecords[0] || capped.records[0] || frontierBlocks[0];
  return `Current CTX-BLOCK frontier for session \`${targetSessionId}\` - ${frontierBlocks.length} top-level block(s), sorted by message range.\n\n${body}${capNote}`
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
): Promise<string> {
  const block = await getRecallBlockById(targetSessionId, blockId);
  if (!block) {
    return `No CTX-BLOCK B#${blockId} found in session \`${targetSessionId}\`.`
      + formatRecallNextHints(targetSessionId, includeSessionId, ['overview', 'blocks']);
  }

  const range = await resolveRecallBlockMessageRange(targetSessionId, block);
  const blockWithTime = await hydrateRecallBlockTimeRange(targetSessionId, block, range);
  const rangeTimeSuffix = formatArchiveBlockTimeRange(blockWithTime);
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
    if (getRecallPreviewBudget(messageResult.records.length, previewLength).overLimit) {
      return `${header.join('\n')}\n\n${buildRecallMessageBudgetNotice({
        targetSessionId,
        includeSessionId,
        blockId: block.id,
        startSeq: range.startSeq,
        endSeq: range.endSeq,
        messageCount: messageResult.records.length,
        previewLength,
        rangeSuffix: rangeTimeSuffix,
      })}` + formatRecallNextHints(targetSessionId, includeSessionId, [
        'blocks',
        'overview',
      ]);
    }
    return `${header.join('\n')}\n\nSource messages:\n\n${formatArchivedMessagePreview(targetSessionId, messageResult.records, {
      totalMatched: messageResult.totalMatched,
      startSeq: messageResult.requestedRange.startSeq,
      endSeq: messageResult.requestedRange.endSeq,
    }, previewLength)}` + formatRecallNextHints(targetSessionId, includeSessionId, [
      'blocks',
      'overview',
    ]);
  }

  if (blockWithTime.sourceKind === 'block') {
    const childRecords = await getRecallChildBlocksForBlock(targetSessionId, blockWithTime);
    const capped = capRecallBlockSummaryRecords(childRecords, previewLength);
    const visibleChildRecords = await hydrateRecallBlockTimeRanges(targetSessionId, capped.records);
    const childSection = visibleChildRecords.length > 0
      ? visibleChildRecords
        .map((child: ArchiveBlockRecord) => formatArchivedBlockPreviewLine(child, previewLength, { includeSourceSuffix: false }))
        .join('\n')
      : '[no child blocks found]';
    const capNote = capped.capped
      ? `\n\nChild block list has ${childRecords.length} block(s); showing ${capped.records.length} because ${childRecords.length} × ${previewLength} = ${capped.requestedChars} summary-preview characters exceeds the ${ARCHIVE_PREVIEW_REQUEST_CHAR_LIMIT}-character guard. Pick a specific child \`B#N\` to continue drilling down, or lower previewLength.`
      : '';
    return `${header.join('\n')}\n\nImmediate child blocks (${formatArchiveChildBlockReference(blockWithTime)}):\n${childSection}`
      + capNote
      + formatRecallNextHints(targetSessionId, includeSessionId, [
        visibleChildRecords[0] ? `B#${visibleChildRecords[0].id}` : undefined,
        'blocks',
      ]);
  }

  return header.join('\n') + formatRecallNextHints(targetSessionId, includeSessionId, [
    'overview',
  ]);
}

async function buildRecallMessagesForBlock(
  targetSessionId: string,
  blockId: number,
  previewLength: number,
  includeSessionId: boolean,
): Promise<string> {
  const block = await getRecallBlockById(targetSessionId, blockId);
  if (!block) {
    return `No CTX-BLOCK B#${blockId} found in session \`${targetSessionId}\`.`
      + formatRecallNextHints(targetSessionId, includeSessionId, ['overview', 'blocks']);
  }

  const range = await resolveRecallBlockMessageRange(targetSessionId, block);
  const blockWithTime = await hydrateRecallBlockTimeRange(targetSessionId, block, range);
  const rangeTimeSuffix = formatArchiveBlockTimeRange(blockWithTime);
  if (!range) {
    return `Could not determine the message log range covered by B#${blockId}. Inspect the block metadata first.`
      + formatRecallNextHints(targetSessionId, includeSessionId, [`B#${blockId}`, 'overview']);
  }

  const result = await sessionManager.getArchivedMessages(targetSessionId, {
    startSeq: range.startSeq,
    endSeq: range.endSeq,
  });
  if (getRecallPreviewBudget(result.records.length, previewLength).overLimit) {
    throwRecallMessageBudgetError({
      targetSessionId,
      includeSessionId,
      blockId,
      startSeq: range.startSeq,
      endSeq: range.endSeq,
      messageCount: result.records.length,
      previewLength,
      preferBlockFirst: true,
      rangeSuffix: rangeTimeSuffix,
    });
  }

  return `Messages covered by CTX-BLOCK B#${blockId} (${formatMessageLogRange(range.startSeq, range.endSeq)}${rangeTimeSuffix}) for session \`${targetSessionId}\`.\n\n`
    + formatArchivedMessagePreview(targetSessionId, result.records, {
      totalMatched: result.totalMatched,
      startSeq: result.requestedRange.startSeq,
      endSeq: result.requestedRange.endSeq,
    }, previewLength);
}

export async function tool_recall(args: ToolArgs = {}, ctx?: ToolContext) {
  assertNoLegacyRecallArgs(args);
  const targetSessionId = args.sessionId || ctx?.sessionId;
  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  await checkArchivedReadPermission(ctx || {}, targetSessionId, 'recall');

  const previewLength = normalizePositivePreviewLength(args.previewLength, RECALL_DEFAULT_PREVIEW_LENGTH);
  const includeSessionId = isNonEmptyString(args.sessionId);
  const target = parseRecallTarget(args.target);

  switch (target.kind) {
    case 'overview':
      return buildRecallOverview(targetSessionId, includeSessionId);
    case 'blocks':
      return buildRecallFrontierBlocks(targetSessionId, previewLength, includeSessionId);
    case 'block':
      return buildRecallBlockDetail(targetSessionId, target.id, previewLength, includeSessionId);
    case 'blockMessages':
      return buildRecallMessagesForBlock(targetSessionId, target.id, previewLength, includeSessionId);
    case 'messages':
      return buildRecallMessagesByRange(targetSessionId, target.startSeq, target.endSeq, previewLength, includeSessionId);
    default: {
      const exhaustive: never = target;
      throw recallSyntaxError(`Unsupported recall target ${(exhaustive as any)?.kind || ''}.`);
    }
  }
}

export async function tool_delete_session(args: ToolArgs, ctx: ToolContext) {
  await requireNotIsolated(ctx, 'delete_session');
  const { sessionId } = args;

  if (ctx && ctx.sessionId === sessionId) {
    throw new Error('Cannot delete current session. Use /clear to clear history or switch to another session first.');
  }

  const prep = await sessionManager.prepareSessionForDestructiveAction(sessionId);
  const session = prep.session;

  if (prep.requiresRetry) {
    const queueNote = prep.droppedQueueItems > 0
      ? ` Cleared ${prep.droppedQueueItems} queued item(s).`
      : '';
    if (prep.abortedInFlight) {
      return `Stop signal sent to busy session \`${sessionId}\`. The in-flight LLM request was aborted.${queueNote} Retry delete after the session becomes idle.`;
    }
    return `Stop signal sent to busy session \`${sessionId}\`. It will stop after the current tool call completes.${queueNote} Retry delete after the session becomes idle.`;
  }

  const deleted = await sessionManager.deleteSession(sessionId);

  if (deleted) {
    return `Session \`${sessionId}\` deleted successfully.`;
  }

  return `Session \`${sessionId}\` not found.`;
}

export async function tool_update_session_name(args: ToolArgs, ctx: ToolContext) {
  const { sessionId, name } = args;
  const targetId = sessionId || ctx?.sessionId;

  if (!targetId) {
    throw new Error('Session ID is required.');
  }

  const session = await sessionManager.getExistingSession(targetId);
  if (!session) {
    throw new Error(`Session \`${targetId}\` not found.`);
  }

  if (name && name.trim()) {
    session.displayName = name.trim();
  } else {
    session.displayName = undefined;
  }

  await sessionManager.saveSession(session.id);

  if (session.displayName) {
    return `Session \`${session.id}\` renamed to "${session.displayName}".`;
  }
  return `Session \`${session.id}\` display name cleared.`;
}

export async function tool_update_session_snapshot(args: ToolArgs, ctx: ToolContext) {
  const { sessionId } = args;
  const targetId = sessionId || ctx?.sessionId;

  if (!targetId) {
    throw new Error('Session ID is required.');
  }

  const result = await sessionManager.refreshSessionSnapshot(targetId);
  return `Session \`${result.sessionId}\` snapshot updated.\nAgent: \`${result.agentName}\``;
}

export async function tool_set_goal(args: ToolArgs, ctx: ToolContext) {
  const targetId = ctx?.sessionId;
  if (!targetId) {
    throw new Error('Current session context is required.');
  }

  const session = ctx.session ?? await sessionManager.getSession(targetId);
  const clear = args.clear === true;

  if (clear) {
    const cleared = clearSessionGoal(session);
    await sessionManager.saveSession(session.id);
    return cleared
      ? 'ok'
      : 'ok';
  }

  const goal = normalizeGoalText(args.goal);
  if (!goal) {
    const cleared = clearSessionGoal(session);
    await sessionManager.saveSession(session.id);
    return cleared
      ? 'ok'
      : 'ok';
  }

  const remindEvery = resolveSessionGoalRemindEvery(session, args.remindEvery);
  const remindOnTurnEnd = resolveSessionGoalRemindOnTurnEnd(session, args.remindOnTurnEnd);
  setSessionGoal(session, goal, remindEvery, remindOnTurnEnd);
  await sessionManager.saveSession(session.id);

  return 'ok';
}

export async function tool_set_session_compact_threshold(args: ToolArgs, ctx: ToolContext) {
  const targetId = args.sessionId || ctx?.sessionId;
  if (!targetId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const clear = args.clear === true;
  if (clear) {
    const result = await sessionManager.setSessionCompactThreshold(targetId);
    return [
      `Session \`${result.sessionId}\` compact threshold cleared.`,
      `Now inheriting default auto-compact threshold: ${result.effectiveThresholdTokens} tokens.`,
    ].join('\n');
  }

  if (typeof args.thresholdTokens !== 'number' || !Number.isFinite(args.thresholdTokens) || args.thresholdTokens <= 0) {
    const session = await sessionManager.getExistingSession(targetId);
    if (!session) {
      throw new Error(`Session \`${targetId}\` not found.`);
    }
    const effective = sessionManager.getEffectiveCompactThresholdTokens(session);
    const override = typeof session.compactThresholdTokens === 'number'
      ? `${session.compactThresholdTokens} tokens`
      : 'inherit global default';
    return [
      `Session \`${session.id}\` compact threshold status:`,
      `override: ${override}`,
      `effective: ${effective} tokens`,
    ].join('\n');
  }

  const result = await sessionManager.setSessionCompactThreshold(targetId, args.thresholdTokens);
  return [
    `Session \`${result.sessionId}\` compact threshold updated.`,
    `override: ${result.thresholdTokens} tokens`,
    `effective: ${result.effectiveThresholdTokens} tokens`,
  ].join('\n');
}

export async function tool_set_session_child_model(args: ToolArgs, ctx: ToolContext) {
  const targetId = args.sessionId || ctx?.sessionId;
  if (!targetId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const clear = args.clear === true;
  if (clear) {
    const result = await sessionManager.setSessionChildModelDefault(targetId);
    const { currentKey } = resolveModelConfig(result.effectiveModel);
    return [
      `Session \`${result.sessionId}\` child default model cleared.`,
      `Now inheriting the current session model path (effective spawn model: \`${currentKey}\`).`,
    ].join('\n');
  }

  const normalizedModel = normalizeToolModelKey(args.model);
  if (!normalizedModel) {
    const session = await sessionManager.getExistingSession(targetId);
    if (!session) {
      throw new Error(`Session \`${targetId}\` not found.`);
    }

    const override = typeof session.childModelDefault === 'string' && session.childModelDefault.trim()
      ? `\`${session.childModelDefault.trim()}\``
      : 'inherit current session model';
    const { currentKey: currentSessionModel } = resolveModelConfig(session.model);
    const { currentKey: effectiveSpawnModel } = resolveModelConfig(sessionManager.resolveSpawnedSessionModel(session));
    return [
      `Session \`${session.id}\` child default model status:`,
      `override: ${override}`,
      `current session model: \`${currentSessionModel}\``,
      `effective spawned-session model: \`${effectiveSpawnModel}\``,
    ].join('\n');
  }

  const result = await sessionManager.setSessionChildModelDefault(targetId, normalizedModel);
  const { currentKey } = resolveModelConfig(result.effectiveModel);
  return [
    `Session \`${result.sessionId}\` child default model updated.`,
    `override: \`${normalizedModel}\``,
    `effective spawned-session model: \`${currentKey}\``,
  ].join('\n');
}

export async function tool_stop_session(args: ToolArgs) {
  const { sessionId } = args;

  const session = await sessionManager.getSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  if (!session.busy) {
    return `Session \`${sessionId}\` is not currently running.`;
  }

  const { abortedInFlight } = await sessionManager.requestSessionStop(sessionId);

  if (abortedInFlight) {
    return `Stop signal sent to session \`${sessionId}\`. The in-flight LLM request was aborted.`;
  }

  return `Stop signal sent to session \`${sessionId}\`. It will stop after the current tool call completes.`;
}

function normalizeKeepPercent(value: unknown, defaultPercent = COMPACT_PERCENT): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return defaultPercent;
  }

  if (value > 1 && value <= 100) {
    return value / 100;
  }

  if (value > 0 && value <= 1) {
    return value;
  }

  return defaultPercent;
}

export async function tool_compact_session(args: ToolArgs, ctx: ToolContext) {
  const targetSessionId = args.sessionId || ctx.sessionId;
  const compactGuidance = typeof args.summary === 'string' && args.summary.trim()
    ? args.summary.trim()
    : undefined;
  const keepPercent = normalizeKeepPercent(args.keepPercent);

  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const targetSession = await sessionManager.getExistingSession(targetSessionId);
  if (!targetSession) {
    throw new Error(`Session \`${targetSessionId}\` not found.`);
  }

  const isSelf = targetSessionId === ctx.sessionId;
  if (!isSelf && (targetSession.busy || targetSession.queue.length > 0)) {
    throw new Error(`Session \`${targetSessionId}\` must be idle with an empty queue before another session can request compaction.`);
  }

  const result = await sessionManager.requestSessionCompaction(targetSessionId, {
    compactGuidance,
    keepPercent,
    completionMarker: isSelf
      ? 'Compaction completed. You can continue working now.'
      : 'Compaction completed.',
    // Self-compaction requested from inside an active agent turn should resume
    // the normal loop with the newly compacted history instead of halting after
    // the compact flow finishes.
    stopAfterCurrentTurn: false,
    requestedBy: compactGuidance ? 'manual' : 'tool',
  });

  if (result.alreadyQueued) {
    return `Compaction is already queued for session \`${targetSessionId}\`.`;
  }

  const mode = compactGuidance ? 'guided compaction plan' : 'automatic compaction plan';
  if (result.startedImmediately) {
    return `Compaction requested for session \`${targetSessionId}\`. It is entering the compact planning flow now using ${mode}.`;
  }

  return `Compaction requested for session \`${targetSessionId}\` using ${mode}. Pending queue length: ${result.queueLength}`;
}

export async function tool_create_timer(args: ToolArgs, ctx: ToolContext) {
  await checkTimerPermission(ctx, {
    targetSessionId: args.sessionId,
    newSession: args.newSession,
    agentName: args.agentName,
    sessionPrefix: args.sessionPrefix,
  });

  const targetSessionId = args.sessionId || ctx.sessionId;
  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const targetSession = await sessionManager.getExistingSession(targetSessionId);
  if (!targetSession) {
    throw new Error(`Session \`${targetSessionId}\` not found.`);
  }

  const timer = await timers.createTimer({
    sessionId: targetSessionId,
    at: args.at,
    afterSeconds: args.afterSeconds,
    cron: args.cron,
    message: args.message,
    newSession: args.newSession,
    sessionPrefix: args.sessionPrefix,
    agentName: args.agentName,
    currentNode: targetSession.currentNode,
    model: targetSession.model,
  });

  return formatTimerSummary(timer);
}

export async function tool_list_timers(args: ToolArgs, ctx: ToolContext) {
  await checkTimerPermission(ctx, { targetSessionId: args.sessionId });

  const targetSessionId = args.sessionId || ctx.sessionId;
  const timerList = timers.listTimers(targetSessionId);

  if (timerList.length === 0) {
    return targetSessionId
      ? `No timers found for session \`${targetSessionId}\`.`
      : 'No timers found.';
  }

  let result = `Found ${timerList.length} timer(s):\n\n`;
  for (const timer of timerList) {
    const mode = timer.mode === 'cron'
      ? `cron: ${timer.cron}`
      : `at: ${formatTimerTimestamp(timer.at)}`;
    const target = timer.newSession
      ? `new session (${timer.agentName || 'main'} / ${timer.sessionPrefix || 'timer'})`
      : `session ${timer.sessionId}`;
    result += `- \`${timer.id}\` - ${mode} - next: ${formatTimerTimestamp(timer.nextRunAt)} - ${target}\n`;
    result += `  ${timer.message}\n`;
  }

  return result.trimEnd();
}

export async function tool_delete_timer(args: ToolArgs, ctx: ToolContext) {
  await checkTimerPermission(ctx, { targetSessionId: args.sessionId });

  const { timerId } = args;
  const targetSessionId = args.sessionId || ctx.sessionId;

  if (!timerId || typeof timerId !== 'string') {
    throw new Error('timerId is required');
  }

  const deleted = await timers.deleteTimer(timerId, targetSessionId);
  if (!deleted) {
    return `Timer \`${timerId}\` not found.`;
  }

  return `Timer \`${timerId}\` deleted.`;
}

export async function tool_create_agent(args: ToolArgs, ctx: ToolContext) {
  await requireNotIsolated(ctx, 'create_agent');
  const {
    agentName,
    inheritMemory = false,
    sourceSessionId,
    convertSession = false,
    createMainSession = true,
    inherit,
    isolatedNode,
  } = args;

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }

  const normalizedInherit = inherit && String(inherit).trim()
    ? String(inherit).trim()
    : undefined;
  const sourceId = sourceSessionId || ctx.sessionId || ctx.session?.id;
  const result = await sessionManager.createAgentWithMainSession({
    agentName,
    inheritMemory,
    sourceSessionId: sourceId,
    convertSessionId: convertSession ? sourceId : undefined,
    currentNode: ctx.session?.currentNode,
    model: ctx.session?.model,
    createMainSession,
    inherit: normalizedInherit,
    isolatedNode,
  });

  if (result.convertedFromSessionId) {
    let message = `Session "${result.convertedFromSessionId}" converted to agent "${agentName}".\nAgent folder: ${result.agentDir}\nMain session: ${result.mainSessionId}`;
    if (normalizedInherit) {
      message += `\nShared memory inherits from: ${normalizedInherit}`;
    }
    if (result.aliases.length > 0) {
      message += `\nAliases: ${result.aliases.join(', ')}`;
    }
    if (result.updatedChildren.length > 0) {
      message += `\nUpdated ${result.updatedChildren.length} child session parent reference(s).`;
    }
    return message;
  }

  let message = `Agent "${agentName}" created successfully.\nAgent folder: ${result.agentDir}`;
  if (normalizedInherit) {
    message += `\nShared memory inherits from: ${normalizedInherit}`;
  }
  if (isolatedNode) {
    message += `\nIsolation: enabled on node ${isolatedNode}`;
  }
  if (result.createdMainSession) {
    message += `\nMain session: ${result.mainSessionId}`;
  } else {
    message += '\nMain session: not created';
  }
  return message;
}

export async function tool_create_session(args: ToolArgs, ctx: ToolContext) {
  await requireNotIsolated(ctx, 'create_session');
  const { agentName, sessionName, displayName, parentSessionId } = args;
  const requestedModel = normalizeToolModelKey(args.model);
  const systemPromptFiles = args.systemPromptFiles === undefined
    ? undefined
    : llm.normalizeSystemPromptFiles(args.systemPromptFiles);

  if (args.systemPromptFiles !== undefined && !Array.isArray(args.systemPromptFiles)) {
    throw new Error('systemPromptFiles must be an array of strings');
  }

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }
  if (!sessionName || typeof sessionName !== 'string') {
    throw new Error('sessionName is required');
  }

  const result = await sessionManager.createSessionInAgent({
    agentName,
    sessionName,
    displayName,
    parentSessionId,
    systemPromptFiles,
    currentNode: ctx.session?.currentNode,
    model: sessionManager.resolveSpawnedSessionModel(ctx.session, requestedModel),
  });

  let message = `Session "${result.sessionId}" created under agent "${agentName}".`;
  if (displayName) {
    message += `\nDisplay name: ${displayName}`;
  }
  if (parentSessionId) {
    message += `\nParent session: ${parentSessionId}`;
  }
  if (systemPromptFiles) {
    message += `\nSystem prompt files: ${systemPromptFiles.length > 0 ? systemPromptFiles.join(', ') : '(none)'}`;
  }
  const createdSession = await sessionManager.getSession(result.sessionId);
  const { currentKey } = resolveModelConfig(createdSession.model);
  message += `\nModel: ${currentKey}`;
  return message;
}

export async function tool_set_agent_inherit(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'set_agent_inherit');
  const { agentName, inheritAgentName } = args;

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }

  const normalizedInherit = inheritAgentName && String(inheritAgentName).trim()
    ? String(inheritAgentName).trim()
    : undefined;

  const result = await sessionManager.setAgentInherit(agentName, normalizedInherit);
  const chain = sessionManager.getAgentInheritanceChain(agentName);

  let message = normalizedInherit
    ? `Agent "${agentName}" now inherits shared memory from "${normalizedInherit}".`
    : `Cleared shared memory inheritance for agent "${agentName}".`;

  message += `\nInheritance chain: ${chain.join(' -> ')}`;
  if (result.affectedSessions.length > 0) {
    message += `\nUpdated ${result.affectedSessions.length} session snapshot(s).`;
  }

  return message;
}

export async function tool_set_agent_isolated(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'set_agent_isolated');
  const { agentName, nodeId } = args;

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }

  const result = await sessionManager.setAgentIsolation(
    agentName,
    typeof nodeId === 'string' && nodeId.trim() ? nodeId.trim() : undefined,
  );

  let message = result.isolated
    ? `Agent "${agentName}" is now isolated on node "${result.node}".`
    : `Agent "${agentName}" isolation cleared.`;
  if (result.affectedSessions.length > 0) {
    message += `\nUpdated ${result.affectedSessions.length} session(s).`;
  }
  return message;
}

export async function tool_move_session(args: ToolArgs, ctx: ToolContext) {
  const {
    sessionId,
    newSessionId,
    createAgent = false,
    newAgentName,
    createAgentInheritMemory,
  } = args;

  const sourceId = sessionId || ctx.sessionId;
  if (!sourceId) {
    throw new Error('sessionId is required');
  }

  const sourceSession = await sessionManager.getExistingSession(sourceId);
  if (!sourceSession) {
    throw new Error(`Session "${sourceId}" not found.`);
  }

  if (sessionManager.isSessionEffectivelyIsolated(sourceSession)) {
    throw new Error('Isolated session cannot use move_session tool.');
  }

  const result = await sessionManager.moveSessionToTarget({
    sourceSessionId: sourceId,
    newSessionId,
    createAgent,
    newAgentName,
    createAgentInheritMemory,
  });

  let message = `Session "${sourceId}" moved to "${result.targetSessionId}".`;
  if (result.createdAgent) {
    message += `\nAgent "${result.targetAgent}" created.`;
  }
  if (result.aliases.length > 0) {
    message += `\nAliases: ${result.aliases.join(', ')}`;
  }
  if (result.updatedChildren.length > 0) {
    message += `\nUpdated ${result.updatedChildren.length} child session parent reference(s).`;
  }

  return message;
}
