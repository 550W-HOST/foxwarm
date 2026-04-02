import { ToolDefinition } from '../types';

export const COMPACT_PLAN_TOOL_NAME = 'submit_compact_plan';
export const COMPACT_FLOW_MAX_ROUNDS = 10;
const DEFAULT_PREVIEW_CHAR_LIMIT = 80;
const COMPACT_FLOW_MEMORY_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'read_memory',
    description: 'Read a file from the current agent memory/ directory while compacting. Use this to check durable memory before deciding whether to update it.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Relative file path inside the current agent memory/ directory.' },
        startLine: { type: 'number', description: 'Starting line number (1-indexed, optional)' },
        endLine: { type: 'number', description: 'Ending line number (1-indexed, inclusive, optional)' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'write_memory',
    description: 'Create a new file under the current agent memory/ directory while compacting. Use only for durable memory worth preserving beyond this session.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Relative file path inside the current agent memory/ directory.' },
        content: { type: 'string', description: 'File contents to create.' },
      },
      required: ['filePath', 'content'],
    },
  },
  {
    name: 'edit_memory',
    description: 'Edit an existing file under the current agent memory/ directory while compacting. Use this only to preserve durable workflow/project/user facts.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Relative file path inside the current agent memory/ directory.' },
        oldText: { type: 'string', description: 'The exact text to find' },
        newText: { type: 'string', description: 'The text to replace it with' },
      },
      required: ['filePath', 'oldText', 'newText'],
    },
  },
  {
    name: 'delete_memory',
    description: 'Delete a memory file while compacting if it is clearly obsolete durable memory.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'Relative file path inside the current agent memory/ directory.' },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'apply_patch_memory',
    description: 'Apply an apply_patch-style patch only within the current agent memory/ directory while compacting. Use memory-relative paths in patch headers.',
    parameters: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'The apply_patch command text to execute against files under the current agent memory/ directory.' },
      },
      required: ['input'],
    },
  },
  {
    name: 'get_archived_messages',
    description: 'Inspect archived raw messages while compacting if you need details from compacted history.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
        startSeq: { type: 'number', description: 'Optional inclusive starting seq number' },
        endSeq: { type: 'number', description: 'Optional inclusive ending seq number' },
        previewLength: { type: 'number', description: 'Maximum preview length per archived message (default: 1000)' },
      },
    },
  },
  {
    name: 'get_archived_blocks',
    description: 'Inspect archived layered-context blocks while compacting if you need earlier block summaries.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
        startId: { type: 'number', description: 'Optional inclusive starting block id' },
        endId: { type: 'number', description: 'Optional inclusive ending block id' },
        previewLength: { type: 'number', description: 'Maximum preview length per block summary (default: 1000)' },
      },
    },
  },
  {
    name: 'get_context_archive',
    description: 'Unified archived-context inspection helper. Use this during compaction when you are not sure whether you need raw messages, layered blocks, or both.',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
        startSeq: { type: 'number', description: 'Optional inclusive starting raw message seq' },
        endSeq: { type: 'number', description: 'Optional inclusive ending raw message seq' },
        startId: { type: 'number', description: 'Optional inclusive starting block id' },
        endId: { type: 'number', description: 'Optional inclusive ending block id' },
        includeMessages: { type: 'boolean', description: 'Include archived raw messages (default: auto)' },
        includeBlocks: { type: 'boolean', description: 'Include archived layered blocks (default: auto)' },
        previewLength: { type: 'number', description: 'Maximum preview length per returned item (default: 1000)' },
      },
    },
  },
];

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

export function buildCompactFlowToolDefinitions(): ToolDefinition[] {
  return [
    ...COMPACT_FLOW_MEMORY_TOOL_DEFINITIONS,
    COMPACT_PLAN_TOOL_DEFINITION,
  ];
}

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
    `Review the older candidate items below and finish by calling ${COMPACT_PLAN_TOOL_NAME}. Do not answer with plain text only.`,
    'Rules:',
    '- Pass the plan via createBlocksJson as a JSON array string.',
    '- createBlocksJson may include one or more new blocks.',
    '- A block must summarize a continuous range of same-kind candidate items only.',
    '- Level 1 blocks summarize raw messages (sourceKind=message).',
    '- Higher-level blocks summarize existing blocks from the immediately lower level (sourceKind=block and level = child level + 1).',
    '- Items not covered by createBlocks stay verbatim in working history.',
    '- Do not overlap source ranges across createBlocks.',
    '- Keep each summary compact, factual, and continuation-oriented.',
    '- Preserve decisions, rationale that still matters, constraints, active tasks, blockers, unresolved questions, and concrete identifiers (paths, commits, branches, nodes, URLs, session IDs, config names).',
    '- Prefer current state plus what remains over conversational narration.',
    '- Mention when an earlier plan or decision was superseded by a later one if that matters for future work.',
    '- Drop filler, repetition, resolved low-value process chatter, and tool-internal mechanics unless they matter to continue safely.',
    `- You have at most ${COMPACT_FLOW_MAX_ROUNDS} total rounds in this dedicated compaction phase (including helper-tool rounds and plan-fix retries), so inspect efficiently and finish with ${COMPACT_PLAN_TOOL_NAME}.`,
    '- If durable project/user/workflow facts should outlive this session, you may use read_memory/write_memory/edit_memory/delete_memory/apply_patch_memory before submitting the final plan.',
    '- If you need more detail from compacted history, use get_context_archive, get_archived_messages, or get_archived_blocks.',
    `- You may use only these helper tools during compaction: read_memory, write_memory, edit_memory, delete_memory, apply_patch_memory, get_context_archive, get_archived_messages, get_archived_blocks, and ${COMPACT_PLAN_TOOL_NAME}.`,
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
    `Fix only the layered-context plan and call ${COMPACT_PLAN_TOOL_NAME} again. During compaction you may only use read_memory, write_memory, edit_memory, delete_memory, apply_patch_memory, get_context_archive, get_archived_messages, and get_archived_blocks if you truly need them.`,
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
