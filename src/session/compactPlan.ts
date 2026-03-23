import { ToolDefinition } from '../types';

export const COMPACT_PLAN_TOOL_NAME = 'submit_compact_plan';
const DEFAULT_PREVIEW_CHAR_LIMIT = 80;

export type CompactCandidateItem =
  | {
      kind: 'message';
      key: string;
      startSeq: number;
      endSeq: number;
      preview: string;
    }
  | {
      kind: 'block';
      key: string;
      id: number;
      level: number;
      rawStartSeq: number;
      rawEndSeq: number;
      preview: string;
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

function trimPreview(text: string, limit: number = DEFAULT_PREVIEW_CHAR_LIMIT): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 1)}…`;
}

export function buildMessageCandidateItem(startSeq: number, endSeq: number, preview: string): CompactCandidateItem {
  return {
    kind: 'message',
    key: startSeq === endSeq ? `M#${startSeq}` : `M#${startSeq}-#${endSeq}`,
    startSeq,
    endSeq,
    preview: trimPreview(preview),
  };
}

export function buildBlockCandidateItem(id: number, level: number, rawStartSeq: number, rawEndSeq: number, summary: string): CompactCandidateItem {
  return {
    kind: 'block',
    key: `B#${id}`,
    id,
    level,
    rawStartSeq,
    rawEndSeq,
    preview: trimPreview(summary),
  };
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
    `Recent messages ${forcedKeptCount > 0 ? `(${forcedKeptCount} rendered item(s), ${formatSeqRange(forcedKeptStartSeq, forcedKeptEndSeq)})` : '(none)'} are already force-kept verbatim by the system. Do not replace them.`,
    `Review the older candidate items below and respond by calling ${COMPACT_PLAN_TOOL_NAME}. Do not answer with plain text only.`,
    'Rules:',
    '- Pass the plan via createBlocksJson as a JSON array string.',
    '- createBlocksJson may include one or more new blocks.',
    '- A block must summarize a continuous range of same-kind candidate items only.',
    '- Level 1 blocks summarize raw messages (sourceKind=message).',
    '- Higher-level blocks summarize existing blocks from the immediately lower level (sourceKind=block and level = child level + 1).',
    '- Items not covered by createBlocks stay verbatim in working history.',
    '- Do not overlap source ranges across createBlocks.',
    '- Keep each summary compact and factual.',
    '',
    ...(guidance ? ['Additional requester guidance:', guidance, ''] : []),
    'Older compaction candidates:',
  ];

  for (const item of candidateItems) {
    if (item.kind === 'message') {
      lines.push(`- ${item.key} ${item.preview || '[empty message]'}`);
      continue;
    }

    lines.push(`- ${item.key} L${item.level} raw${formatSeqRange(item.rawStartSeq, item.rawEndSeq)} ${item.preview || '[empty block]'}`);
  }

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

export function buildCompactPlanValidationFeedback(error: CompactPlanValidationError, attemptsRemaining: number): string {
  return [
    'COMPACT PLAN INVALID.',
    error.message,
    `Attempts remaining after this feedback: ${attemptsRemaining}.`,
    `Fix only the layered-context plan and call ${COMPACT_PLAN_TOOL_NAME} again. Do not switch back to normal conversation and do not call any other tool.`,
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
