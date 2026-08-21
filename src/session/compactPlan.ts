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
      segmentId?: number;
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
      segmentId?: number;
    };

export interface PreservedMessageCandidateItem {
  seq: number;
  key: string;
  preservedFromBlockId?: number;
  preview: string;
}

export interface LayeredCreateBlockPlan {
  level: number;
  sourceKind: 'message' | 'block';
  sourceStart: number;
  sourceEnd: number;
  summary: string;
  memoryFacts?: ExtractedMemoryFact[];
}

export type MemoryFactKind = 'decision' | 'preference' | 'fact' | 'convention' | 'environment';
export type MemoryFactAttribution = 'user' | 'assistant' | 'both';

export interface ExtractedMemoryFact {
  kind: MemoryFactKind;
  text: string;
  context?: string;
  attributedTo?: MemoryFactAttribution;
}

export interface CompactPlan {
  createBlocks: Array<LayeredCreateBlockPlan & { candidateRange: [number, number] }>;
  preserveMessages?: number[];
  removePreservedMessages?: number[];
}

export interface CompactPlanValidationDetails {
  createBlockErrors: string[];
}

export interface MessageCompactionPolicy {
  thresholdTokens: number;
  totalCandidateTokens: number;
  eligibleTokens: number;
  requestedMinTokens: number;
  feasibleMaxTokens: number;
  effectiveMinTokens: number;
  skippedReason?: string;
}

export interface BlockCompactionPolicy {
  sourceLevel: number;
  totalBlockCount: number;
  totalTokens: number;
  forcedKeepNewestCount: number;
  candidateBlockCount: number;
  requestedMinBlocks: number;
  feasibleMaxBlocks: number;
  effectiveMinBlocks: number;
  skippedReason?: string;
}

export interface CompactPlanValidationOptions {
  removablePreservedMessages?: PreservedMessageCandidateItem[];
  messagePolicy?: MessageCompactionPolicy;
  blockPolicies?: BlockCompactionPolicy[];
}

export interface BlockCompactionWindow {
  forcedKeepNewestCount: number;
  candidateBlockCount: number;
  requestedMinBlocks: number;
}

export function clampCompactFraction(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

export function calculateBlockCompactionWindow(options: {
  totalBlockCount: number;
  totalTokens: number;
  minTokens: number;
  forceTokens: number;
  candidateFraction: number;
  forceCompactFraction: number;
}): BlockCompactionWindow {
  const totalBlockCount = Math.max(0, Math.floor(options.totalBlockCount));
  if (totalBlockCount === 0 || options.totalTokens < options.minTokens) {
    return {
      forcedKeepNewestCount: totalBlockCount,
      candidateBlockCount: 0,
      requestedMinBlocks: 0,
    };
  }

  const candidateFraction = clampCompactFraction(options.candidateFraction, 0.4);
  const forceCompactFraction = clampCompactFraction(options.forceCompactFraction, 0.2);
  // floor makes the candidate window strict: everything outside the oldest
  // fraction is force-kept, including conservative rounding for small levels.
  const candidateBlockCount = Math.floor(totalBlockCount * candidateFraction);
  return {
    forcedKeepNewestCount: totalBlockCount - candidateBlockCount,
    candidateBlockCount,
    requestedMinBlocks: options.totalTokens >= options.forceTokens
      ? Math.ceil(totalBlockCount * forceCompactFraction)
      : 0,
  };
}

export class CompactPlanValidationError extends Error {
  details: CompactPlanValidationDetails;

  constructor(details: CompactPlanValidationDetails) {
    super(buildCompactPlanValidationSummary(details));
    this.name = 'CompactPlanValidationError';
    this.details = details;
  }
}

const COMPACT_REPLACEMENT_BLOCK_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    level: { type: 'integer', minimum: 1, description: 'Created block level. Use 1 for message sources, or one level above block sources.' },
    sourceKind: { type: 'string', enum: ['message', 'block'], description: 'Whether the source range contains raw messages or existing summary blocks.' },
    sourceStart: { type: 'integer', minimum: 1, description: 'First source message seq or block id shown in the compact prompt.' },
    sourceEnd: { type: 'integer', minimum: 1, description: 'Last source message seq or block id shown in the compact prompt, following history order.' },
    summary: { type: 'string', description: 'Non-empty continuation-oriented summary of only this source range.' },
    memoryFacts: {
      type: 'array',
      description: 'Optional durable facts tied only to this source range. Malformed facts are skipped best-effort.',
      items: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['decision', 'preference', 'fact', 'convention', 'environment'] },
          text: { type: 'string' },
          context: { type: 'string' },
          attributedTo: { type: 'string', enum: ['user', 'assistant', 'both'] },
        },
        required: ['kind', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['level', 'sourceKind', 'sourceStart', 'sourceEnd', 'summary'],
  additionalProperties: false,
};

export const COMPACT_PLAN_TOOL_DEFINITION: ToolDefinition = {
  name: COMPACT_PLAN_TOOL_NAME,
  defaultInject: true, // Keep compact/normal tool schemas stable for prompt-cache/KV-cache hits.
  description: 'Submit layered-context block creation/removal plan for older context items. Create continuous same-level summary blocks, optionally preserve a few covered raw messages verbatim, or remove previously preserved raw messages from working history. Unmentioned older items stay verbatim.',
  parameters: {
    type: 'object',
    properties: {
      replaceAsBlocks: {
        description: 'Summary blocks that replace continuous candidate ranges. Prefer the direct array; a JSON-encoded array string is also accepted. Use [] or "[]" when only removePreservedMessages performs work.',
        oneOf: [
          { type: 'array', items: COMPACT_REPLACEMENT_BLOCK_ITEM_SCHEMA },
          { type: 'string', description: 'Fallback JSON string encoding an array whose items follow the same replacement-block schema.' },
        ],
      },
      preserveMessages: {
        type: 'array',
        items: { type: 'number' },
        description: 'Optional small list of raw message seq numbers to keep verbatim even though they are covered by a created message-source summary block. Preserved messages are extracted after the covering block in working history.',
      },
      removePreservedMessages: {
        type: 'array',
        items: { type: 'number' },
        description: 'Optional list of previously preserved raw message seq numbers to remove from active history. This never deletes archive records or summary blocks, and can only target messages listed as preserved in the compact prompt.',
      },
    },
    required: ['replaceAsBlocks'],
  },
};

const MEMORY_FACT_KINDS = new Set<MemoryFactKind>(['decision', 'preference', 'fact', 'convention', 'environment']);
const MEMORY_FACT_ATTRIBUTIONS = new Set<MemoryFactAttribution>(['user', 'assistant', 'both']);
const MAX_MEMORY_FACTS_PER_PLAN = 20;
const MAX_MEMORY_FACT_TEXT_CHARS = 900;
const MAX_MEMORY_FACT_CONTEXT_CHARS = 500;

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}

function trimCompactFactText(text: string, limit: number): string {
  const normalized = normalizeWhitespace(text);
  return normalized.length <= limit ? normalized : truncateUnicodeSafeWithEllipsis(normalized, limit, '…');
}

function normalizePositiveIntegerArray(rawArgs: Record<string, any>, key: 'preserveMessages' | 'removePreservedMessages', details: CompactPlanValidationDetails): number[] {
  const rawValue = rawArgs[key];
  if (rawValue === undefined) {
    return [];
  }

  if (!Array.isArray(rawValue)) {
    details.createBlockErrors.push(`${key} must be an array of positive integer message seq numbers.`);
    return [];
  }

  const result: number[] = [];
  const seen = new Set<number>();
  rawValue.forEach((value, index) => {
    if (!Number.isInteger(value) || value < 1) {
      details.createBlockErrors.push(`${key}[${index}] must be a positive integer message seq number.`);
      return;
    }
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  });

  return result;
}

export function normalizeMemoryFacts(rawValue: unknown, options: { seenTexts?: Set<string>; maxFacts?: number } = {}): ExtractedMemoryFact[] {
  if (!Array.isArray(rawValue)) return [];

  const facts: ExtractedMemoryFact[] = [];
  const seenTexts = options.seenTexts || new Set<string>();
  const maxFacts = options.maxFacts ?? MAX_MEMORY_FACTS_PER_PLAN;
  for (const rawFact of rawValue) {
    if (facts.length >= maxFacts) break;
    if (!rawFact || typeof rawFact !== 'object') continue;
    const entry = rawFact as Record<string, any>;
    const kind = String(entry.kind || '').trim() as MemoryFactKind;
    if (!MEMORY_FACT_KINDS.has(kind)) continue;
    const text = typeof entry.text === 'string' ? trimCompactFactText(entry.text, MAX_MEMORY_FACT_TEXT_CHARS) : '';
    if (!text) continue;
    const dedupeKey = text.toLowerCase();
    if (seenTexts.has(dedupeKey)) continue;
    seenTexts.add(dedupeKey);
    const context = typeof entry.context === 'string' ? trimCompactFactText(entry.context, MAX_MEMORY_FACT_CONTEXT_CHARS) : undefined;
    const rawAttribution = entry.attributedTo ?? entry.attributed_to;
    const attributedTo = MEMORY_FACT_ATTRIBUTIONS.has(String(rawAttribution || '').trim() as MemoryFactAttribution)
      ? String(rawAttribution).trim() as MemoryFactAttribution : undefined;
    facts.push({ kind, text, ...(context ? { context } : {}), ...(attributedTo ? { attributedTo } : {}) });
  }
  return facts;
}

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

export function buildMessageCandidateItem(startSeq: number, endSeq: number, preview: string, estimatedTokens: number = estimateTokenCount(preview), segmentId?: number): CompactCandidateItem {
  return {
    kind: 'message',
    key: startSeq === endSeq ? `M#${startSeq}` : `M#${startSeq}-#${endSeq}`,
    startSeq,
    endSeq,
    preview,
    estimatedTokens,
    ...(typeof segmentId === 'number' ? { segmentId } : {}),
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
  segmentId?: number,
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
    ...(typeof segmentId === 'number' ? { segmentId } : {}),
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

function canAppendToCandidateSegment(segment: CandidateSegment, item: CompactCandidateItem): boolean {
  const targetLevel = getCandidateTargetLevel(item);
  if (segment.targetLevel !== targetLevel || segment.sourceKind !== item.kind) {
    return false;
  }

  const previous = segment.items[segment.items.length - 1];
  if (!previous) {
    return true;
  }

  if ((previous.segmentId ?? 0) !== (item.segmentId ?? 0)) {
    return false;
  }

  if (item.kind === 'message') {
    return previous.kind === 'message';
  }

  return previous.kind === 'block'
    && item.level === segment.sourceLevel;
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
  const sourceRange = firstBlock.id === lastBlock.id ? `B#${firstBlock.id}` : `B#${firstBlock.id}..B#${lastBlock.id}`;
  const base = `Segment ${index}: history-contiguous L${firstBlock.level} block candidates -> L${segment.targetLevel} block(s). Legal ranges must stay within this segment (${sourceRange}; sourceKind=block, level=${segment.targetLevel}, sourceStart/sourceEnd at listed B# boundaries). Block ids inside a segment may skip numbers or be out of numeric order; a range covers the listed candidates between its endpoints, not every numeric id in between.`;

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
  preservedMessages?: PreservedMessageCandidateItem[];
  messagePolicy?: MessageCompactionPolicy;
  blockPolicies?: BlockCompactionPolicy[];
  guidance?: string;
}): string {
  const {
    forcedKeptCount,
    forcedKeptStartSeq,
    forcedKeptEndSeq,
    candidateItems,
    preservedMessages = [],
    messagePolicy,
    blockPolicies = [],
    guidance,
  } = options;
  const lines: string[] = [
    'COMPACTION STARTED: stop any previous task and focus only on layered-context compaction.',
    'Goal: Replace older context with compact, continuation-oriented summaries so the main model can keep working without re-reading the original messages. Summaries must preserve decisions, active tasks, blockers, and concrete next actions.',
    `Recent messages ${forcedKeptCount > 0 ? `(${forcedKeptCount} rendered item(s), ${formatSeqRange(forcedKeptStartSeq, forcedKeptEndSeq)})` : '(none)'} are already force-kept verbatim by the system. No need to summarize/replace them.`,
  ];

  lines.push('Hard compaction limits for this run:');
  if (messagePolicy) {
    if (messagePolicy.effectiveMinTokens > 0) {
      lines.push(`- Raw messages: ~${messagePolicy.eligibleTokens} eligible estimated tokens; message-source replaceAsBlocks entries must actually replace at least ~${messagePolicy.effectiveMinTokens} estimated tokens. Raw messages listed in preserveMessages stay verbatim and do not count toward this minimum.`);
    } else {
      lines.push(`- Raw messages: no mandatory message compaction this run (${messagePolicy.skippedReason || 'no eligible raw message candidates'}).`);
    }
  }
  for (const policy of blockPolicies) {
    const base = `- Source L${policy.sourceLevel} blocks: ${policy.totalBlockCount} block(s), ~${policy.totalTokens} tokens; newest ${policy.forcedKeepNewestCount} are force-kept and are not candidates; oldest ${policy.candidateBlockCount} may be listed.`;
    if (policy.effectiveMinBlocks > 0) {
      lines.push(`${base} Valid multi-block operations must compact at least ${policy.effectiveMinBlocks} source L${policy.sourceLevel} block(s) in total.`);
    } else if (policy.requestedMinBlocks > 0) {
      lines.push(`${base} Requested minimum ${policy.requestedMinBlocks} was reduced to 0 because no legal multi-block range is feasible${policy.skippedReason ? ` (${policy.skippedReason})` : ''}; stranded single-block lifts do not count as effective compression.`);
    } else {
      lines.push(`${base}${policy.skippedReason ? ` ${policy.skippedReason}.` : ''}`);
    }
  }
  lines.push('Hard minima may be satisfied across multiple legal Segments, but every individual replaceAsBlocks range must remain inside one Segment.', '');

  // Group candidates by legal compression boundaries instead of only by target level.
  // In particular, block ranges must not cross a different source level/source kind.
  const segments = buildCandidateSegments(candidateItems);

  if (segments.length === 0) {
    lines.push('No normal summary-block candidate segments are available in this compaction slice.');
  }

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

  if (preservedMessages.length > 0) {
    lines.push(
      'Previously preserved raw messages already covered by summary blocks:',
      'These are still verbatim in working history for exact wording. If the summary block is now sufficient, remove them with removePreservedMessages: number[]. Do not summarize them again just to remove them.',
    );
    for (const item of preservedMessages) {
      const preview = trimPreview(item.preview, EDGE_PREVIEW_CHAR_LIMIT) || '[empty message]';
      const source = typeof item.preservedFromBlockId === 'number'
        ? ` preserved from B#${item.preservedFromBlockId}`
        : ' preserved from a prior summary block';
      lines.push(`- ${item.key}${source}: ${preview}`);
    }
  }

  lines.push(
    `Review the older candidate items above and finish by calling ${COMPACT_PLAN_TOOL_NAME}. Do not answer with plain text only.`,
    'Rules:',
    '- Pass summary-block creations via replaceAsBlocks. Prefer a direct array of objects; a JSON string encoding that same array is also accepted as a fallback. Use replaceAsBlocks: [] or replaceAsBlocks: "[]" if you only need to remove previously preserved raw messages.',
    '- Each replaceAsBlocks entry may include memoryFacts: an array of durable facts tied to exactly that source range. Invalid/omitted facts are ignored and never affect block creation; do not repeat them manually in summary prose.',
    '- Raw messages are summarized by L1 blocks, L1 blocks are summarized by L2 blocks, and so on.',
    '- Items covered by replaceAsBlocks will be replaced by the summary. Other items stay verbatim unless listed in removePreservedMessages.',
    '- Use preserveMessages for a small number of raw message seqs that must remain verbatim even though they are covered by a newly created message-source block. The system will extract them after the covering block in working history.',
    '- Use removePreservedMessages only for messages listed in the "Previously preserved raw messages" section. This removes the raw message from active history only; it does not delete archive records or existing summary blocks.',
    '- Block compression is optional after satisfying the hard minima above. Prefer compressing only older/resolved/repetitive block segments; keep recent, detail-rich, decision-heavy, or still-active blocks verbatim by omitting them from replaceAsBlocks.',
    '- Subject to the hard minima above, if a block/message still seems useful, you can leave it uncompressed by simply omitting it from replaceAsBlocks.',
    '',
    'Block range rules (must be followed to produce a valid plan):',
    '- Treat each Segment header as a hard boundary: replaceAsBlocks ranges must stay inside one listed segment and must not cross different block levels or different source kinds. Block ids may be non-consecutive or decreasing; use only listed B# endpoints in history order.',
    '- A single block may be summarized only when it is a stranded island immediately surrounded on both sides by higher-level blocks; otherwise block sources must span at least two blocks.',
    '- Blocks must have same kind and same level of source; do not combine low-level and high-level blocks in one replaceAsBlocks entry.',
    '- Blocks must not overlap source ranges across replaceAsBlocks entries.',
    '- Blocks must not separate seq/id range inside a candidate (can not separate a tool call and its response).',
    '',
    'Summary writing guidance:',
    '- Keep each summary compact, factual, and continuation-oriented. A future model reading only this summary should be able to continue the task without re-reading the original messages.',
    '- Each block summary must be source-range-bound: summarize only the specified seq/id range it covers, including any user/inter-agent inputs, process, findings, and TODOs inside that range; do not borrow facts, later outcomes, or completions from force-kept items or any other outside range.',
    '- For example, if force-kept later context completed a task but the block source range only contains the unfinished earlier work, the summary must describe the task as unfinished/TODO rather than completed, so the compacted timeline stays correct.',
    '- Preserve decisions, rationale that still matters, constraints, active tasks, blockers, unresolved questions, and concrete identifiers (paths, commits, branches, nodes, URLs, session IDs, config names).',
    '- Preserve the original task/goal as stated by the requester (user, parent session, another agent, etc.). Quote or closely paraphrase the original wording when the exact meaning matters.',
    '- If the task contains requirements, terms, or context that are not yet fully understood at the time of the range, do not over-interpret them. Preserve the original phrasing or note it as "not yet resolved" so a later model can interpret it correctly when more context is available.',
    '- Mention when an earlier plan or decision was superseded by a later one if that matters for future work.',
    '',
    'A good summary often looks like one of these shapes (use as a style guide, not a rigid template):',
    '- Completed range: "Investigated X. Found Y. User decided Z. No further action needed."',
    '- Active range: "Leading hypothesis is Y. Already verified A and B; still need to verify C. Next: run D and check E."',
    '- Blocked range: "Tried X but failed because Y. Blocked on user input / external dependency Z. Next: wait for Z or try workaround W."',
    '- Validation range: "Tested X. Result supports/contradicts earlier B#N conclusion that Y. Next: Z."',
    '- Informational range: "User shared X. Key identifiers: Y, Z. No decision yet."',
    '',
    'Memory facts:',
    '- Put durable facts only in the memoryFacts array of their matching replaceAsBlocks entry: explicit user decisions, preferences, project conventions, technical discoveries, environment/deploy constraints, or stable identifiers. Do not include trivial chat, tool mechanics, transient progress, or stale TODOs.',
    '- Each memory fact must be self-contained and understandable outside this conversation. Keep the original conversation language when practical. Use kind decision/preference/fact/convention/environment and attributedTo user/assistant/both when clear.',
    '',
    `You have at most ${COMPACT_FLOW_MAX_ROUNDS} total rounds in this dedicated compaction phase (including invalid-tool and plan-fix retries), so inspect efficiently and finish with ${COMPACT_PLAN_TOOL_NAME}.`,
    `Do not read or write agent memory during compaction. If durable project/user/workflow/rule facts should outlive this session, attach them to the matching replaceAsBlocks entry's memoryFacts and then call ${COMPACT_PLAN_TOOL_NAME}.`,
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

function normalizeReplacementBlocks(rawArgs: Record<string, any>, details: CompactPlanValidationDetails): LayeredCreateBlockPlan[] {
  const seenMemoryFactTexts = new Set<string>();
  let remainingMemoryFacts = MAX_MEMORY_FACTS_PER_PLAN;
  if (Object.prototype.hasOwnProperty.call(rawArgs, 'createBlocksJson')) {
    details.createBlockErrors.push('createBlocksJson is obsolete; use replaceAsBlocks with a direct array or JSON-encoded array string.');
  }
  if (Object.prototype.hasOwnProperty.call(rawArgs, 'createBlocks')) {
    details.createBlockErrors.push('createBlocks is obsolete; use replaceAsBlocks with a direct array or JSON-encoded array string.');
  }
  if (!Object.prototype.hasOwnProperty.call(rawArgs, 'replaceAsBlocks')) {
    details.createBlockErrors.push('replaceAsBlocks is required and must be an array or a non-empty JSON string encoding an array.');
    return [];
  }
  let rawReplacementBlocks: unknown = rawArgs.replaceAsBlocks;
  if (typeof rawReplacementBlocks === 'string') {
    if (!rawReplacementBlocks.trim()) {
      details.createBlockErrors.push('replaceAsBlocks JSON string must be non-empty and encode an array.');
      return [];
    }
    try {
      rawReplacementBlocks = JSON.parse(rawReplacementBlocks);
    } catch (error: any) {
      details.createBlockErrors.push(`replaceAsBlocks must be valid JSON when passed as a string: ${error.message}`);
      return [];
    }
    if (!Array.isArray(rawReplacementBlocks)) {
      details.createBlockErrors.push('replaceAsBlocks JSON string must decode to an array.');
      return [];
    }
  } else if (!Array.isArray(rawReplacementBlocks)) {
    details.createBlockErrors.push('replaceAsBlocks must be a direct array or a JSON string encoding an array.');
    return [];
  }

  return rawReplacementBlocks.flatMap((entry: unknown, index: number) => {
    if (!entry || typeof entry !== 'object') {
      details.createBlockErrors.push(`replaceAsBlocks[${index}] must be an object.`);
      return [];
    }

    const level = Number((entry as any).level);
    const sourceKind = (entry as any).sourceKind;
    const sourceStart = Number((entry as any).sourceStart);
    const sourceEnd = Number((entry as any).sourceEnd);
    const summary = typeof (entry as any).summary === 'string' ? (entry as any).summary.trim() : '';

    if (!Number.isInteger(level) || level < 1) {
      details.createBlockErrors.push(`replaceAsBlocks[${index}].level must be an integer >= 1.`);
    }
    if (sourceKind !== 'message' && sourceKind !== 'block') {
      details.createBlockErrors.push(`replaceAsBlocks[${index}].sourceKind must be \"message\" or \"block\".`);
    }
    if (!Number.isInteger(sourceStart) || sourceStart < 1) {
      details.createBlockErrors.push(`replaceAsBlocks[${index}].sourceStart must be a positive integer.`);
    }
    if (!Number.isInteger(sourceEnd) || sourceEnd < 1) {
      details.createBlockErrors.push(`replaceAsBlocks[${index}].sourceEnd must be a positive integer.`);
    }
    if (sourceKind !== 'block' && Number.isInteger(sourceStart) && Number.isInteger(sourceEnd) && sourceStart > sourceEnd) {
      details.createBlockErrors.push(`replaceAsBlocks[${index}] has sourceStart > sourceEnd.`);
    }
    if (!summary) {
      details.createBlockErrors.push(`replaceAsBlocks[${index}].summary must be a non-empty string.`);
    }
    if (sourceKind === 'message' && Number.isInteger(level) && level !== 1) {
      details.createBlockErrors.push(`replaceAsBlocks[${index}] uses sourceKind=message so level must be 1.`);
    }
    if (sourceKind === 'block' && Number.isInteger(level) && level < 2) {
      details.createBlockErrors.push(`replaceAsBlocks[${index}] uses sourceKind=block so level must be >= 2.`);
    }
    const memoryFacts = normalizeMemoryFacts((entry as any).memoryFacts, {
      seenTexts: seenMemoryFactTexts,
      maxFacts: remainingMemoryFacts,
    });
    remainingMemoryFacts -= memoryFacts.length;
    return [{ level, sourceKind, sourceStart, sourceEnd, summary, ...(memoryFacts.length > 0 ? { memoryFacts } : {}) } as LayeredCreateBlockPlan];
  });
}

function findMessageRange(candidateItems: CompactCandidateItem[], sourceStart: number, sourceEnd: number): [number, number] | null {
  const startIndex = candidateItems.findIndex(item => item.kind === 'message' && item.startSeq === sourceStart);
  if (startIndex < 0) return null;

  const startSegmentId = candidateItems[startIndex].segmentId ?? 0;

  let endIndex = startIndex - 1;
  for (let index = startIndex; index < candidateItems.length; index += 1) {
    const item = candidateItems[index];
    if (item.kind !== 'message' || (item.segmentId ?? 0) !== startSegmentId) {
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

  const startSegmentId = candidateItems[startIndex].segmentId ?? 0;

  let endIndex = startIndex - 1;
  for (let index = startIndex; index < candidateItems.length; index += 1) {
    const item = candidateItems[index];
    if (item.kind !== 'block' || item.level !== childLevel || (item.segmentId ?? 0) !== startSegmentId) {
      break;
    }
    endIndex = index;
    if (item.id === sourceEnd) {
      return [startIndex, endIndex];
    }
  }

  return null;
}

function getMessageCandidateCoveringSeq(candidateItems: CompactCandidateItem[], seq: number): Extract<CompactCandidateItem, { kind: 'message' }> | undefined {
  return candidateItems.find((item): item is Extract<CompactCandidateItem, { kind: 'message' }> => (
    item.kind === 'message' && item.startSeq <= seq && item.endSeq >= seq
  ));
}

function isSeqCoveredByCreatedMessageBlock(createBlocks: LayeredCreateBlockPlan[], seq: number): boolean {
  return createBlocks.some(block => block.sourceKind === 'message' && block.sourceStart <= seq && block.sourceEnd >= seq);
}

function validateNormalizedCompactPlan(
  rawArgs: Record<string, any>,
  candidateItems: CompactCandidateItem[],
  options: CompactPlanValidationOptions = {},
): { details: CompactPlanValidationDetails; plan?: CompactPlan } {
  const details: CompactPlanValidationDetails = {
    createBlockErrors: [],
  };

  const createBlocks = normalizeReplacementBlocks(rawArgs, details);
  const preserveMessages = normalizePositiveIntegerArray(rawArgs, 'preserveMessages', details);
  const removePreservedMessages = normalizePositiveIntegerArray(rawArgs, 'removePreservedMessages', details);
  if (details.createBlockErrors.length > 0) {
    return { details };
  }

  if (createBlocks.length === 0 && removePreservedMessages.length === 0) {
    details.createBlockErrors.push('replaceAsBlocks must contain at least one block unless removePreservedMessages removes previously preserved raw messages.');
    return { details };
  }

  const removeSet = new Set(removePreservedMessages);
  for (const seq of preserveMessages) {
    if (removeSet.has(seq)) {
      details.createBlockErrors.push(`msg#${seq} cannot appear in both preserveMessages and removePreservedMessages.`);
    }
    const coveringCandidate = getMessageCandidateCoveringSeq(candidateItems, seq);
    if (!coveringCandidate) {
      details.createBlockErrors.push(`preserveMessages contains msg#${seq}, but that raw message is not present in the current compact message candidates.`);
      continue;
    }
    if (coveringCandidate.startSeq !== coveringCandidate.endSeq) {
      details.createBlockErrors.push(`preserveMessages contains msg#${seq}, but it is inside atomic candidate ${coveringCandidate.key}; do not preserve only part of a grouped tool call/response candidate.`);
    }
    if (!isSeqCoveredByCreatedMessageBlock(createBlocks, seq)) {
      details.createBlockErrors.push(`preserveMessages contains msg#${seq}, but that message is not covered by any created message-source block. If you want it to stay verbatim outside compaction, leave it out of the compacted range instead.`);
    }
  }

  if (removePreservedMessages.length > 0) {
    const removableSeqs = new Set((options.removablePreservedMessages || []).map(item => item.seq));
    for (const seq of removePreservedMessages) {
      if (!removableSeqs.has(seq)) {
        details.createBlockErrors.push(`removePreservedMessages contains msg#${seq}, but that message is not listed as a previously preserved raw message in the current compact candidates.`);
      }
    }
  }

  if (details.createBlockErrors.length > 0) {
    return { details };
  }

  const usedIndices = new Set<number>();
  const coveredMessageIndices = new Set<number>();
  const coveredBlockIndicesByLevel = new Map<number, Set<number>>();
  const resolvedCreateBlocks: CompactPlan['createBlocks'] = [];
  createBlocks.forEach((block, index) => {
    const range = block.sourceKind === 'message'
      ? findMessageRange(candidateItems, block.sourceStart, block.sourceEnd)
      : findBlockRange(candidateItems, block.level, block.sourceStart, block.sourceEnd);

    if (!range) {
      if (block.sourceKind === 'block' && block.sourceStart === block.sourceEnd) {
        details.createBlockErrors.push(`replaceAsBlocks[${index}] uses a single block source, which is allowed only for a stranded block immediately surrounded by higher-level blocks.`);
        return;
      }

      const unitLabel = block.sourceKind === 'message' ? 'seq' : 'block id';
      const continuityLabel = block.sourceKind === 'message' ? 'message' : 'active candidate block';
      details.createBlockErrors.push(`replaceAsBlocks[${index}] does not match a continuous ${continuityLabel} range in current older context for ${unitLabel} ${block.sourceStart}-${block.sourceEnd}.`);
      return;
    }

    for (let candidateIndex = range[0]; candidateIndex <= range[1]; candidateIndex += 1) {
      if (usedIndices.has(candidateIndex)) {
        details.createBlockErrors.push(`replaceAsBlocks[${index}] overlaps another replaceAsBlocks range at candidate ${candidateItems[candidateIndex].key}.`);
        return;
      }
    }

    for (let candidateIndex = range[0]; candidateIndex <= range[1]; candidateIndex += 1) {
      usedIndices.add(candidateIndex);
    }

    if (block.sourceKind === 'message') {
      for (let candidateIndex = range[0]; candidateIndex <= range[1]; candidateIndex += 1) {
        coveredMessageIndices.add(candidateIndex);
      }
    } else if (range[1] > range[0]) {
      // A stranded single-block lift changes level but does not reduce the
      // number of active context items, so it never satisfies a compression quota.
      const sourceLevel = block.level - 1;
      const covered = coveredBlockIndicesByLevel.get(sourceLevel) || new Set<number>();
      for (let candidateIndex = range[0]; candidateIndex <= range[1]; candidateIndex += 1) {
        covered.add(candidateIndex);
      }
      coveredBlockIndicesByLevel.set(sourceLevel, covered);
    }
    resolvedCreateBlocks.push({ ...block, candidateRange: range });
  });

  if (details.createBlockErrors.length > 0) {
    return { details };
  }

  const preservedMessageIndices = new Set<number>();
  for (const seq of preserveMessages) {
    const index = candidateItems.findIndex(item => item.kind === 'message' && item.startSeq <= seq && item.endSeq >= seq);
    if (index >= 0) preservedMessageIndices.add(index);
  }

  if (options.messagePolicy && options.messagePolicy.effectiveMinTokens > 0) {
    let coveredTokens = 0;
    for (const candidateIndex of coveredMessageIndices) {
      if (preservedMessageIndices.has(candidateIndex)) continue;
      const item = candidateItems[candidateIndex];
      if (item?.kind === 'message') {
        coveredTokens += Math.max(0, item.estimatedTokens || 0);
      }
    }
    if (coveredTokens < options.messagePolicy.effectiveMinTokens) {
      const deficit = options.messagePolicy.effectiveMinTokens - coveredTokens;
      details.createBlockErrors.push(`Raw-message hard quota requires message-source replaceAsBlocks entries to actually replace at least ~${options.messagePolicy.effectiveMinTokens} eligible estimated tokens, but this plan replaces only ~${coveredTokens} after excluding preserveMessages (deficit ~${deficit}).`);
    }
  }

  for (const policy of options.blockPolicies || []) {
    if (policy.effectiveMinBlocks <= 0) continue;
    const covered = coveredBlockIndicesByLevel.get(policy.sourceLevel)?.size || 0;
    if (covered < policy.effectiveMinBlocks) {
      const deficit = policy.effectiveMinBlocks - covered;
      details.createBlockErrors.push(`Source L${policy.sourceLevel} block hard quota requires valid multi-block operations to compact at least ${policy.effectiveMinBlocks} candidate block(s), but this plan compacts only ${covered}; stranded single-block lifts do not count (deficit ${deficit}).`);
    }
  }

  if (details.createBlockErrors.length > 0) {
    return { details };
  }
  return {
    details,
    plan: { createBlocks: resolvedCreateBlocks, preserveMessages, removePreservedMessages },
  };
}

export function validateCompactPlanArgs(rawArgs: Record<string, any>, candidateItems: CompactCandidateItem[], options: CompactPlanValidationOptions = {}): CompactPlan {
  const result = validateNormalizedCompactPlan(rawArgs, candidateItems, options);
  if (!result.plan) throw new CompactPlanValidationError(result.details);
  return result.plan;
}

export function buildCompactPlanValidationFeedback(error: CompactPlanValidationError): string {
  return [
    'COMPACT PLAN INVALID.',
    error.message,
    'Use only ranges shown in one Segment header; do not cross segment boundaries, different block levels, or different source kinds. Block ids may be non-consecutive or decreasing; use only listed B# endpoints in history order.',
    'Use preserveMessages only for raw messages covered by a newly created message-source block; use removePreservedMessages only for messages listed as previously preserved in the prompt.',
    `Fix only the layered-context plan and call ${COMPACT_PLAN_TOOL_NAME} again. Do not read or write agent memory during compaction; attach durable facts to the matching replaceAsBlocks entry's memoryFacts instead.`,
  ].join(' ');
}
