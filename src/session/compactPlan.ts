import { ToolDefinition } from '../types';
import { estimateTokenCount } from '../tokenCount';
import { truncateUnicodeSafeWithEllipsis } from '../utils/unicode';

export const COMPACT_PLAN_TOOL_NAME = 'submit_compact_plan';
export const COMPACT_FLOW_MAX_ROUNDS = 15;
export const DEFAULT_PREVIEW_CHAR_LIMIT = 80;
export const COMPACT_LEVEL_TOKEN_THRESHOLD = 2000;
const EDGE_PREVIEW_CHAR_LIMIT = 300;
export type CompactCandidateItem =
  | {
      kind: 'message';
      key: string;
      startSeq: number;
      endSeq: number;
      preview: string;
      estimatedTokens: number;
    }
  | {
      kind: 'block';
      key: string;
      id: number;
      level: number;
      rawStartSeq: number;
      rawEndSeq: number;
      preview: string;
      estimatedTokens: number;
      allowSingleBlockCompact?: boolean;
    };

export interface LayeredCreateBlockPlan {
  level: number;
  sourceKind: 'message' | 'block';
  sourceStart: number;
  sourceEnd: number;
  summary: string;
}

export interface CompactPlan {
  createBlocks: LayeredCreateBlockPlan[];
}

export interface CompactPlanValidationDetails {
  createBlockErrors: string[];
}

export class CompactPlanValidationError extends Error {
  details: CompactPlanValidationDetails;

  constructor(details: CompactPlanValidationDetails) {
    super(buildCompactPlanValidationSummary(details));
    this.name = 'CompactPlanValidationError';
    this.details = details;
  }
}

export const COMPACT_PLAN_TOOL_DEFINITION: ToolDefinition = {
  name: COMPACT_PLAN_TOOL_NAME,
  defaultInject: true, // Keep compact/normal tool schemas stable for prompt-cache/KV-cache hits.
  description: 'Submit layered-context block creation plan for older context items. Create one or more continuous same-level summary blocks; unmentioned older items stay verbatim in working history.',
  parameters: {
    type: 'object',
    properties: {
      createBlocksJson: {
        type: 'string',
        description: 'JSON array string for createBlocks. Each item should be an object like {"level":1,"sourceKind":"message","sourceStart":10,"sourceEnd":12,"summary":"..."}.',
      },
    },
    required: ['createBlocksJson'],
  },
};

export function formatSeqRange(startSeq?: number, endSeq?: number): string {
  if (typeof startSeq === 'number' && typeof endSeq === 'number') {
    return startSeq === endSeq ? `#${startSeq}` : `#${startSeq}-#${endSeq}`;
  }
  if (typeof startSeq === 'number') return `#${startSeq}-?`;
  if (typeof endSeq === 'number') return `?-#${endSeq}`;
  return '(seq unavailable)';
}

export function trimPreview(text: string, limit: number = DEFAULT_PREVIEW_CHAR_LIMIT): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  return truncateUnicodeSafeWithEllipsis(normalized, limit, '…');
}

export function buildMessageCandidateItem(startSeq: number, endSeq: number, preview: string, estimatedTokens: number = estimateTokenCount(preview)): CompactCandidateItem {
  return {
    kind: 'message',
    key: startSeq === endSeq ? `M#${startSeq}` : `M#${startSeq}-#${endSeq}`,
    startSeq,
    endSeq,
    preview,
    estimatedTokens,
  };
}

export function buildBlockCandidateItem(
  id: number,
  level: number,
  rawStartSeq: number,
  rawEndSeq: number,
  summary: string,
  estimatedTokens: number = estimateTokenCount(summary),
  allowSingleBlockCompact: boolean = false,
): CompactCandidateItem {
  return {
    kind: 'block',
    key: `B#${id}`,
    id,
    level,
    rawStartSeq,
    rawEndSeq,
    preview: summary,
    estimatedTokens,
    allowSingleBlockCompact,
  };
}

interface CandidateSegment {
  targetLevel: number;
  sourceKind: 'message' | 'block';
  sourceLevel?: number;
  items: CompactCandidateItem[];
}

export function getCandidateTargetLevel(item: CompactCandidateItem): number {
  return item.kind === 'message' ? 1 : item.level + 1;
}

export function selectCompactCandidateTargetLevels(items: CompactCandidateItem[]): Set<number> {
  const groups = new Map<number, CompactCandidateItem[]>();

  for (const item of items) {
    const targetLevel = getCandidateTargetLevel(item);
    const current = groups.get(targetLevel) || [];
    current.push(item);
    groups.set(targetLevel, current);
  }

  const allowedLevels = new Set<number>();
  for (const [targetLevel, groupItems] of groups.entries()) {
    const totalEstimatedTokens = groupItems.reduce((sum, item) => sum + Math.max(0, item.estimatedTokens || 0), 0);

    if (totalEstimatedTokens <= COMPACT_LEVEL_TOKEN_THRESHOLD) {
      continue;
    }

    if (targetLevel > 1 && groupItems.length < 2) {
      const onlyItem = groupItems[0];
      if (!onlyItem || onlyItem.kind !== 'block' || onlyItem.allowSingleBlockCompact !== true) {
        continue;
      }
    }

    allowedLevels.add(targetLevel);
  }

  return allowedLevels;
}

export function filterCompactCandidateItemsByLevel(items: CompactCandidateItem[]): CompactCandidateItem[] {
  const allowedLevels = selectCompactCandidateTargetLevels(items);
  return items.filter(item => allowedLevels.has(getCandidateTargetLevel(item)));
}

function canAppendToCandidateSegment(segment: CandidateSegment, item: CompactCandidateItem): boolean {
  const targetLevel = getCandidateTargetLevel(item);
  if (segment.targetLevel !== targetLevel || segment.sourceKind !== item.kind) {
    return false;
  }

  const previous = segment.items[segment.items.length - 1];
  if (!previous) {
    return true;
  }

  if (item.kind === 'message') {
    return previous.kind === 'message';
  }

  return previous.kind === 'block'
    && item.level === segment.sourceLevel
    && item.id === previous.id + 1;
}

function buildCandidateSegments(items: CompactCandidateItem[]): CandidateSegment[] {
  const segments: CandidateSegment[] = [];
  let currentSegment: CandidateSegment | null = null;

  for (const item of items) {
    const targetLevel = getCandidateTargetLevel(item);
    if (!currentSegment || !canAppendToCandidateSegment(currentSegment, item)) {
      currentSegment = {
        targetLevel,
        sourceKind: item.kind,
        sourceLevel: item.kind === 'block' ? item.level : undefined,
        items: [],
      };
      segments.push(currentSegment);
    }
    currentSegment.items.push(item);
  }

  return segments;
}

function formatCandidateSegmentHeader(segment: CandidateSegment, index: number): string {
  const first = segment.items[0];
  const last = segment.items[segment.items.length - 1];

  if (!first || !last) {
    return `Segment ${index}: empty candidate segment.`;
  }

  if (segment.sourceKind === 'message') {
    const firstMessage = first as Extract<CompactCandidateItem, { kind: 'message' }>;
    const lastMessage = last as Extract<CompactCandidateItem, { kind: 'message' }>;
    return `Segment ${index}: raw message candidates -> L1 block(s). Legal ranges must stay within ${firstMessage.key}..${lastMessage.key} (sourceKind=message, level=1, sourceStart/sourceEnd at listed M# boundaries).`;
  }

  const firstBlock = first as Extract<CompactCandidateItem, { kind: 'block' }>;
  const lastBlock = last as Extract<CompactCandidateItem, { kind: 'block' }>;
  const sourceRange = firstBlock.id === lastBlock.id ? `B#${firstBlock.id}` : `B#${firstBlock.id}-B#${lastBlock.id}`;
  const base = `Segment ${index}: L${firstBlock.level} block candidates -> L${segment.targetLevel} block(s). Legal ranges must stay within contiguous ${sourceRange} (sourceKind=block, level=${segment.targetLevel}, sourceStart/sourceEnd at listed B# boundaries); do not cross segment boundaries or gaps.`;

  if (segment.items.length === 1) {
    return firstBlock.allowSingleBlockCompact
      ? `${base} This is a stranded single-block segment, so sourceStart=sourceEnd=${firstBlock.id} is allowed only if lifting this block preserves useful detail; leaving it uncompressed is also fine.`
      : `${base} This segment has only one block, so normally leave it uncompressed rather than creating an invalid single-block plan.`;
  }

  return base;
}

export function buildCompactPromptText(options: {
  forcedKeptCount: number;
  forcedKeptStartSeq?: number;
  forcedKeptEndSeq?: number;
  candidateItems: CompactCandidateItem[];
  guidance?: string;
}): string {
  const { forcedKeptCount, forcedKeptStartSeq, forcedKeptEndSeq, candidateItems, guidance } = options;
  const lines: string[] = [
    'COMPACTION STARTED: stop any previous task and focus only on layered-context compaction.',
    `Recent messages ${forcedKeptCount > 0 ? `(${forcedKeptCount} rendered item(s), ${formatSeqRange(forcedKeptStartSeq, forcedKeptEndSeq)})` : '(none)'} are already force-kept verbatim by the system. No need to summarize/replace them.`,
  ];

  // Group candidates by legal compression boundaries instead of only by target level.
  // In particular, block ranges must not cross a different source level or a non-contiguous block-id gap.
  const segments = buildCandidateSegments(candidateItems);

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    const segment = segments[segmentIndex];
    lines.push(formatCandidateSegmentHeader(segment, segmentIndex + 1));

    const count = segment.items.length;
    for (let i = 0; i < count; i++) {
      const item = segment.items[i];
      const isEdge = i < 2 || i >= count - 2;
      const limit = isEdge ? EDGE_PREVIEW_CHAR_LIMIT : DEFAULT_PREVIEW_CHAR_LIMIT;

      if (item.kind === 'message') {
        const preview = trimPreview(item.preview, limit) || '[empty message]';
        lines.push(`- ${item.key} ${preview}`);
      } else {
        const preview = trimPreview(item.preview, limit) || '[empty block]';
        lines.push(`- ${item.key} L${item.level} raw${formatSeqRange(item.rawStartSeq, item.rawEndSeq)} ${preview}`);
      }
    }
  }

  lines.push(
    `Review the older candidate items above and finish by calling ${COMPACT_PLAN_TOOL_NAME}. Do not answer with plain text only.`,
    'Rules:',
    '- Pass the plan via createBlocksJson as a JSON array string.',
    '- Raw messages are summarized by L1 blocks, L1 blocks are summarized by L2 blocks, and so on.',
    '- Items covered by createBlocksJson will be replaced by the summary. Other items stay verbatim.',
    '- Block compression is optional. Prefer compressing only older/resolved/repetitive block segments; keep recent, detail-rich, decision-heavy, or still-active blocks verbatim by omitting them from createBlocksJson.',
    '- If a block/message still seems useful, you can leave it uncompressed by simply omitting it from createBlocksJson.',
    '- Treat each Segment header as a hard boundary: createBlocksJson ranges must stay inside one listed segment and must not cross gaps, different block levels, or different source kinds.',
    '- A single block may be summarized only when it is a stranded island immediately surrounded on both sides by higher-level blocks; otherwise block sources must span at least two blocks.',
    '- Blocks must have same kind and same level of source; do not combine low-level and high-level blocks in one createBlocks entry.',
    '- Blocks must not overlap source ranges across createBlocks.',
    '- Blocks must not separate seq/id range inside a candidate (can not separate a tool call and its response).',
    '- Keep each summary compact, factual, and continuation-oriented.',
    '- Each block summary must be source-range-bound: summarize only the specified seq/id range it covers, including any user/inter-agent inputs, process, findings, and TODOs inside that range; do not borrow facts, later outcomes, or completions from force-kept items or any other outside range.',
    '- For example, if force-kept later context completed a task but the block source range only contains the unfinished earlier work, the summary must describe the task as unfinished/TODO rather than completed, so the compacted timeline stays correct.',
    '- Preserve decisions, rationale that still matters, constraints, active tasks, blockers, unresolved questions, and concrete identifiers (paths, commits, branches, nodes, URLs, session IDs, config names).',
    '- Mention when an earlier plan or decision was superseded by a later one if that matters for future work.',
    `- You have at most ${COMPACT_FLOW_MAX_ROUNDS} total rounds in this dedicated compaction phase (including helper-tool rounds and plan-fix retries), so inspect efficiently and finish with ${COMPACT_PLAN_TOOL_NAME}.`,
    '- If durable project/user/workflow/rule facts should outlive this session, you may use edit_memory/apply_patch_memory before submitting the final plan.',
    `- You may use only these helper tools during compaction: read_memory, write_memory, edit_memory, delete_memory, apply_patch_memory, and call ${COMPACT_PLAN_TOOL_NAME} to finish the compaction.`,
    '',
    ...(guidance ? ['Additional guidance from compaction requester:', guidance, ''] : []),
  );

  return lines.join('\n');
}

function buildCompactPlanValidationSummary(details: CompactPlanValidationDetails): string {
  if (!details.createBlockErrors.length) {
    return 'Compaction plan validation failed.';
  }
  return details.createBlockErrors.join(' ');
}

function normalizeCreateBlocks(rawArgs: Record<string, any>, details: CompactPlanValidationDetails): LayeredCreateBlockPlan[] {
  let rawCreateBlocks = rawArgs.createBlocks;

  if (typeof rawArgs.createBlocksJson === 'string' && rawArgs.createBlocksJson.trim()) {
    try {
      rawCreateBlocks = JSON.parse(rawArgs.createBlocksJson);
    } catch (e: any) {
      details.createBlockErrors.push(`createBlocksJson must be valid JSON: ${e.message}`);
      return [];
    }
  }

  if (!Array.isArray(rawCreateBlocks)) {
    details.createBlockErrors.push('createBlocksJson must decode to an array (legacy createBlocks array is still accepted internally).');
    return [];
  }

  return rawCreateBlocks.flatMap((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      details.createBlockErrors.push(`createBlocks[${index}] must be an object.`);
      return [];
    }

    const level = Number((entry as any).level);
    const sourceKind = (entry as any).sourceKind;
    const sourceStart = Number((entry as any).sourceStart);
    const sourceEnd = Number((entry as any).sourceEnd);
    const summary = typeof (entry as any).summary === 'string' ? (entry as any).summary.trim() : '';

    if (!Number.isInteger(level) || level < 1) {
      details.createBlockErrors.push(`createBlocks[${index}].level must be an integer >= 1.`);
    }
    if (sourceKind !== 'message' && sourceKind !== 'block') {
      details.createBlockErrors.push(`createBlocks[${index}].sourceKind must be \"message\" or \"block\".`);
    }
    if (!Number.isInteger(sourceStart) || sourceStart < 1) {
      details.createBlockErrors.push(`createBlocks[${index}].sourceStart must be a positive integer.`);
    }
    if (!Number.isInteger(sourceEnd) || sourceEnd < 1) {
      details.createBlockErrors.push(`createBlocks[${index}].sourceEnd must be a positive integer.`);
    }
    if (Number.isInteger(sourceStart) && Number.isInteger(sourceEnd) && sourceStart > sourceEnd) {
      details.createBlockErrors.push(`createBlocks[${index}] has sourceStart > sourceEnd.`);
    }
    if (!summary) {
      details.createBlockErrors.push(`createBlocks[${index}].summary must be a non-empty string.`);
    }
    if (sourceKind === 'message' && Number.isInteger(level) && level !== 1) {
      details.createBlockErrors.push(`createBlocks[${index}] uses sourceKind=message so level must be 1.`);
    }
    if (sourceKind === 'block' && Number.isInteger(level) && level < 2) {
      details.createBlockErrors.push(`createBlocks[${index}] uses sourceKind=block so level must be >= 2.`);
    }
    return [{ level, sourceKind, sourceStart, sourceEnd, summary } as LayeredCreateBlockPlan];
  });
}

function findMessageRange(candidateItems: CompactCandidateItem[], sourceStart: number, sourceEnd: number): [number, number] | null {
  const startIndex = candidateItems.findIndex(item => item.kind === 'message' && item.startSeq === sourceStart);
  if (startIndex < 0) return null;

  let endIndex = startIndex - 1;
  for (let index = startIndex; index < candidateItems.length; index += 1) {
    const item = candidateItems[index];
    if (item.kind !== 'message') {
      break;
    }
    endIndex = index;
    if (item.endSeq === sourceEnd) {
      return [startIndex, endIndex];
    }
  }

  return null;
}

function findBlockRange(candidateItems: CompactCandidateItem[], level: number, sourceStart: number, sourceEnd: number): [number, number] | null {
  if (sourceStart === sourceEnd) {
    const childLevel = level - 1;
    const singleIndex = candidateItems.findIndex(item => item.kind === 'block' && item.id === sourceStart && item.level === childLevel);
    if (singleIndex < 0) {
      return null;
    }
    const singleItem = candidateItems[singleIndex];
    if (singleItem.kind !== 'block' || singleItem.allowSingleBlockCompact !== true) {
      return null;
    }
    return [singleIndex, singleIndex];
  }

  const childLevel = level - 1;
  const startIndex = candidateItems.findIndex(item => item.kind === 'block' && item.id === sourceStart && item.level === childLevel);
  if (startIndex < 0) return null;

  let expectedId = sourceStart;
  let endIndex = startIndex - 1;
  for (let index = startIndex; index < candidateItems.length; index += 1) {
    const item = candidateItems[index];
    if (item.kind !== 'block' || item.level !== childLevel || item.id !== expectedId) {
      break;
    }
    endIndex = index;
    if (expectedId === sourceEnd) {
      return [startIndex, endIndex];
    }
    expectedId += 1;
  }

  return null;
}

function getCompactPlanValidationDetails(rawArgs: Record<string, any>, candidateItems: CompactCandidateItem[]): CompactPlanValidationDetails {
  const details: CompactPlanValidationDetails = {
    createBlockErrors: [],
  };

  const createBlocks = normalizeCreateBlocks(rawArgs, details);
  if (details.createBlockErrors.length > 0) {
    return details;
  }

  if (createBlocks.length === 0) {
    details.createBlockErrors.push('createBlocks must contain at least one block.');
    return details;
  }

  const usedIndices = new Set<number>();
  createBlocks.forEach((block, index) => {
    const range = block.sourceKind === 'message'
      ? findMessageRange(candidateItems, block.sourceStart, block.sourceEnd)
      : findBlockRange(candidateItems, block.level, block.sourceStart, block.sourceEnd);

    if (!range) {
      if (block.sourceKind === 'block' && block.sourceStart === block.sourceEnd) {
        details.createBlockErrors.push(`createBlocks[${index}] uses a single block source, which is allowed only for a stranded block immediately surrounded by higher-level blocks.`);
        return;
      }

      const unitLabel = block.sourceKind === 'message' ? 'seq' : 'block id';
      details.createBlockErrors.push(`createBlocks[${index}] does not match a continuous ${block.sourceKind} range in current older context for ${unitLabel} ${block.sourceStart}-${block.sourceEnd}.`);
      return;
    }

    for (let candidateIndex = range[0]; candidateIndex <= range[1]; candidateIndex += 1) {
      if (usedIndices.has(candidateIndex)) {
        details.createBlockErrors.push(`createBlocks[${index}] overlaps another createBlocks range at candidate ${candidateItems[candidateIndex].key}.`);
        return;
      }
    }

    for (let candidateIndex = range[0]; candidateIndex <= range[1]; candidateIndex += 1) {
      usedIndices.add(candidateIndex);
    }
  });

  return details;
}

export function validateCompactPlanArgs(rawArgs: Record<string, any>, candidateItems: CompactCandidateItem[]): CompactPlan {
  const details = getCompactPlanValidationDetails(rawArgs, candidateItems);
  if (details.createBlockErrors.length > 0) {
    throw new CompactPlanValidationError(details);
  }

  return {
    createBlocks: normalizeCreateBlocks(rawArgs, { createBlockErrors: [] }),
  };
}

export function buildCompactPlanValidationFeedback(error: CompactPlanValidationError): string {
  return [
    'COMPACT PLAN INVALID.',
    error.message,
    'Use only ranges shown in one Segment header; do not cross segment boundaries, block-id gaps, different block levels, or different source kinds.',
    `Fix only the layered-context plan and call ${COMPACT_PLAN_TOOL_NAME} again. During compaction you may only use read_memory, write_memory, edit_memory, delete_memory, and apply_patch_memory if needed.`,
  ].join(' ');
}

export function describeCreatedRanges(plan: CompactPlan): string {
  if (plan.createBlocks.length === 0) {
    return 'none';
  }

  return plan.createBlocks.map(block => (
    `${block.sourceKind === 'message' ? 'L1' : `L${block.level}`} ${block.sourceKind} ${block.sourceStart}-${block.sourceEnd}`
  )).join(', ');
}
