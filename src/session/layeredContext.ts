import { Message, Session, ContextBlockMessageMeta } from '../types';
import { SessionArchiveCommitError } from './archive';
import { formatLocalTimeRange } from '../utils/localTime';
import {
  ensureSessionBranch,
  readEffectiveArchiveBlocks,
  readLocalArchiveBlocks as readLocalArchiveBlocksFromStore,
  rollbackUncommittedArchiveBlocks,
  writeArchiveBlocks,
} from './archiveStore';
import { isModelVisibleMessage } from './messageVisibility';
import { parseFoxwarmOpeningTag } from '../utils/promptWrappers';
import { isSystemPayloadTextPart } from '../utils/systemMessageParts';
import type { ExtractedMemoryFact } from './compactPlan';

const COMPACT_CANDIDATE_IGNORED_SYSTEM_PREFIXES = [
  'This session has been compacted.',
  'Compacted message placeholder:',
  'Compaction completed.',
  '**COMPACTION COMPLETED.',
  'Manual compaction completed.',
];

export interface ArchiveBlockRecord {
  v: number;
  kind: 'block';
  sessionId: string;
  agent: string;
  id: number;
  level: number;
  sourceKind: 'message' | 'block';
  sourceStart: number;
  sourceEnd: number;
  sourceBlockIds?: number[];
  rawStartSeq: number;
  rawEndSeq: number;
  rawStartTimestamp?: number;
  rawEndTimestamp?: number;
  summary: string;
  memoryFacts?: ExtractedMemoryFact[];
  createdAt: number;
  sourceSessionId?: string;
  inherited?: boolean;
}

export interface CreateArchiveBlockInput {
  level: number;
  sourceKind: 'message' | 'block';
  sourceStart: number;
  sourceEnd: number;
  sourceBlockIds?: number[];
  rawStartSeq: number;
  rawEndSeq: number;
  rawStartTimestamp?: number;
  rawEndTimestamp?: number;
  summary: string;
  memoryFacts?: ExtractedMemoryFact[];
}

export function isIgnoredCompactLifecycleSystemText(text: string): boolean {
  const tag = parseFoxwarmOpeningTag(text);
  if (tag?.tagName === 'foxwarm-system') {
    const hint = tag.attrs.hint || '';
    return tag.attrs.event === 'compact'
      || tag.attrs.kind === 'session-boundary'
      || COMPACT_CANDIDATE_IGNORED_SYSTEM_PREFIXES.some(prefix => hint.startsWith(prefix));
  }
  return COMPACT_CANDIDATE_IGNORED_SYSTEM_PREFIXES.some(prefix => text.startsWith(prefix));
}

/**
 * Returns true only for a prior compaction-completion notification. Unlike
 * other session-boundary messages, these are transient continuation notices:
 * the next successful compact commit replaces them with one current notice.
 */
export function isCompactCompletionSystemText(text: string): boolean {
  const tag = parseFoxwarmOpeningTag(text);
  if (tag?.tagName === 'foxwarm-system') {
    return tag.attrs.kind === 'session-boundary' && tag.attrs.event === 'compact-completed';
  }
  return text.startsWith('Compaction completed.')
    || text.startsWith('**COMPACTION COMPLETED.')
    || text.startsWith('Manual compaction completed.');
}

/**
 * A compact-completion message may carry a goal/lifecycle system part, but
 * must not be removed when it also carries real conversation/tool content.
 */
export function shouldRemoveOldCompactCompletionMessage(message: Message): boolean {
  if (!isModelVisibleMessage(message)) {
    return false;
  }

  const parts = message.parts || [];
  const hasCompletionMarker = parts.some(part => (
    typeof part.system === 'string' && isCompactCompletionSystemText(part.system.trim())
  ));
  if (!hasCompletionMarker) {
    return false;
  }

  return !parts.some(part => (
    (typeof part.text === 'string' && part.text.trim().length > 0 && !isSystemPayloadTextPart(part))
    || (typeof part.thinking === 'string' && part.thinking.trim().length > 0)
    || !!part.functionCall
    || !!part.functionResponse
    || !!part.inlineData
    || !!(part as any).inlineDataRef
  ));
}

export function shouldIgnoreMessageInCompactCandidates(message: Message): boolean {
  if (!isModelVisibleMessage(message)) {
    return true;
  }

  const parts = message.parts || [];
  const systemTexts = parts
    .map(part => typeof part.system === 'string' ? part.system.trim() : '')
    .filter(Boolean);

  if (systemTexts.length === 0) {
    return false;
  }

  const hasNonSystemContent = parts.some(part => (
    (typeof part.text === 'string' && part.text.trim().length > 0 && !isSystemPayloadTextPart(part))
    || (typeof part.thinking === 'string' && part.thinking.trim().length > 0)
    || !!part.functionCall
    || !!part.functionResponse
    || !!part.inlineData
    || !!(part as any).inlineDataRef
  ));

  if (hasNonSystemContent) {
    return false;
  }

  return systemTexts.every(isIgnoredCompactLifecycleSystemText);
}

function getNextSessionBlockId(session: Session): number {
  if (typeof session.nextBlockId === 'number' && session.nextBlockId > 0) {
    return session.nextBlockId;
  }

  let maxId = 0;
  for (const message of session.history) {
    const id = message.__meta?.contextBlock?.id;
    if (typeof id === 'number' && id > maxId) maxId = id;
  }

  session.nextBlockId = maxId + 1 || 1;
  return session.nextBlockId;
}

async function buildArchiveBlockRecords(session: Session, blocks: CreateArchiveBlockInput[]): Promise<ArchiveBlockRecord[]> {
  const createdAt = Date.now();
  return blocks.map((block) => {
    const id = getNextSessionBlockId(session);
    session.nextBlockId = id + 1;
    return {
      v: 1,
      kind: 'block',
      sessionId: session.id,
      agent: session.agent || 'main',
      id,
      level: block.level,
      sourceKind: block.sourceKind,
      sourceStart: block.sourceStart,
      sourceEnd: block.sourceEnd,
      ...(block.sourceKind === 'block' && Array.isArray(block.sourceBlockIds) && block.sourceBlockIds.length > 0
        ? { sourceBlockIds: block.sourceBlockIds }
        : {}),
      rawStartSeq: block.rawStartSeq,
      rawEndSeq: block.rawEndSeq,
      ...(typeof block.rawStartTimestamp === 'number' && Number.isFinite(block.rawStartTimestamp) ? { rawStartTimestamp: block.rawStartTimestamp } : {}),
      ...(typeof block.rawEndTimestamp === 'number' && Number.isFinite(block.rawEndTimestamp) ? { rawEndTimestamp: block.rawEndTimestamp } : {}),
      summary: formatArchiveBlockSummary(block.summary, block.memoryFacts),
      ...(block.memoryFacts?.length ? { memoryFacts: block.memoryFacts } : {}),
      createdAt,
    };
  });
}

export async function appendBlocksToArchiveWithCommitInfo(
  session: Session,
  blocks: CreateArchiveBlockInput[],
): Promise<{ records: ArchiveBlockRecord[]; insertedRecords: ArchiveBlockRecord[] }> {
  if (blocks.length === 0) {
    return { records: [], insertedRecords: [] };
  }

  await ensureSessionBranch(session.id);
  const records = await buildArchiveBlockRecords(session, blocks);
  let insertedRecords: ArchiveBlockRecord[];
  try { insertedRecords = await writeArchiveBlocks(records); }
  catch (error) { throw new SessionArchiveCommitError(`Required archive block commit failed for Session ${session.id}: ${(error as any)?.message || error}`, error); }
  return { records, insertedRecords };
}

export async function appendBlocksToArchive(session: Session, blocks: CreateArchiveBlockInput[]): Promise<ArchiveBlockRecord[]> {
  return (await appendBlocksToArchiveWithCommitInfo(session, blocks)).records;
}

export async function rollbackUncommittedBlocks(records: ArchiveBlockRecord[]): Promise<void> {
  await rollbackUncommittedArchiveBlocks(records);
}

export async function readArchiveBlocksByIdRange(sessionId: string, startId?: number, endId?: number): Promise<ArchiveBlockRecord[]> {
  return readEffectiveArchiveBlocks(sessionId, startId, endId);
}

export async function readLocalArchiveBlocks(sessionId: string): Promise<ArchiveBlockRecord[]> {
  return readLocalArchiveBlocksFromStore(sessionId);
}

export async function readLocalArchiveBlocksByIdRange(sessionId: string, startId?: number, endId?: number): Promise<ArchiveBlockRecord[]> {
  return readLocalArchiveBlocksFromStore(sessionId, startId, endId);
}

function formatSeqRange(startSeq: number, endSeq: number): string {
  return startSeq === endSeq ? `#${startSeq}` : `#${startSeq}-#${endSeq}`;
}

export type ArchiveBlockTimeRangeInput = Pick<ArchiveBlockRecord, 'rawStartTimestamp' | 'rawEndTimestamp'> & {
  startTime?: number;
  endTime?: number;
  startTimestamp?: number;
  endTimestamp?: number;
};

function normalizeArchiveBlockTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function getArchiveBlockStartTimestamp(record: ArchiveBlockTimeRangeInput): number | undefined {
  return normalizeArchiveBlockTimestamp(record.rawStartTimestamp)
    ?? normalizeArchiveBlockTimestamp(record.startTime)
    ?? normalizeArchiveBlockTimestamp(record.startTimestamp);
}

export function getArchiveBlockEndTimestamp(record: ArchiveBlockTimeRangeInput): number | undefined {
  return normalizeArchiveBlockTimestamp(record.rawEndTimestamp)
    ?? normalizeArchiveBlockTimestamp(record.endTime)
    ?? normalizeArchiveBlockTimestamp(record.endTimestamp);
}

export function formatArchiveBlockTimeRange(record: ArchiveBlockTimeRangeInput): string {
  const range = formatLocalTimeRange(getArchiveBlockStartTimestamp(record), getArchiveBlockEndTimestamp(record));
  return range ? ` time ${range}` : '';
}

export function formatArchiveBlockMemoryFactsSection(memoryFacts: ExtractedMemoryFact[] | undefined): string {
  if (!memoryFacts?.length) return '';
  const items = memoryFacts.map((fact) => {
    const optional = [
      fact.context?.trim() ? `context: ${fact.context.trim()}` : '',
      fact.attributedTo ? `attributed to: ${fact.attributedTo}` : '',
    ].filter(Boolean);
    return `- **${fact.kind}:** ${fact.text.trim()}${optional.length ? ` _(${optional.join('; ')})_` : ''}`;
  });
  return `### Memory facts\n${items.join('\n')}`;
}

export function formatArchiveBlockSummary(summary: string, memoryFacts?: ExtractedMemoryFact[]): string {
  const section = formatArchiveBlockMemoryFactsSection(memoryFacts);
  return section ? `${summary.trim()}\n\n${section}` : summary;
}

export type ArchiveBlockContextTextInput = Pick<ArchiveBlockRecord, 'id' | 'level' | 'rawStartSeq' | 'rawEndSeq' | 'summary'> & ArchiveBlockTimeRangeInput;

function formatArchiveBlockRawRange(record: Pick<ArchiveBlockRecord, 'rawStartSeq' | 'rawEndSeq'>): string {
  return `raw${formatSeqRange(record.rawStartSeq, record.rawEndSeq)}`;
}

function formatArchiveBlockContextPrefix(record: Omit<ArchiveBlockContextTextInput, 'summary'>): string {
  return `[CTX-BLOCK L${record.level} B#${record.id} ${formatArchiveBlockRawRange(record)}${formatArchiveBlockTimeRange(record)}]`;
}

export function formatArchiveBlockContextText(record: ArchiveBlockContextTextInput): string {
  return `${formatArchiveBlockContextPrefix(record)} ${record.summary}`;
}

export function buildContextBlockMessageMeta(record: ArchiveBlockRecord): ContextBlockMessageMeta {
  return {
    id: record.id,
    level: record.level,
    rawStartSeq: record.rawStartSeq,
    rawEndSeq: record.rawEndSeq,
    sourceKind: record.sourceKind,
    sourceStart: record.sourceStart,
    sourceEnd: record.sourceEnd,
    ...(Array.isArray(record.sourceBlockIds) && record.sourceBlockIds.length > 0 ? { sourceBlockIds: [...record.sourceBlockIds] } : {}),
    ...(typeof record.rawStartTimestamp === 'number' ? { rawStartTimestamp: record.rawStartTimestamp } : {}),
    ...(typeof record.rawEndTimestamp === 'number' ? { rawEndTimestamp: record.rawEndTimestamp } : {}),
    ...(typeof record.createdAt === 'number' ? { createdAt: record.createdAt } : {}),
    ...(typeof record.sourceSessionId === 'string' ? { sourceSessionId: record.sourceSessionId } : {}),
    ...(record.inherited !== undefined ? { inherited: record.inherited } : {}),
  };
}

export function renderBlockMessage(record: ArchiveBlockRecord): Message {
  return {
    role: 'model',
    parts: [{
      text: formatArchiveBlockContextText(record),
    }],
    __meta: {
      timestamp: record.createdAt,
      contextBlock: buildContextBlockMessageMeta(record),
    },
  };
}
