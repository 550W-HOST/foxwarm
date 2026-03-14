import { estimateMessageTokens } from './tokenCount';
import { Message, ToolDefinition } from './types';
import { formatMessagePreviewText } from './utils/messageFormat';

export const COMPACT_PLAN_TOOL_NAME = 'submit_compact_plan';
const DEFAULT_BLOCK_TOKEN_TARGET = 1200;
const DEFAULT_BLOCK_MESSAGE_LIMIT = 12;
const DEFAULT_PREVIEW_MESSAGE_LIMIT = 3;
const DEFAULT_PREVIEW_CHAR_LIMIT = 160;

export interface CompactCandidateBlock {
  id: string;
  startSeq?: number;
  endSeq?: number;
  messageCount: number;
  estimatedTokens: number;
  preview: string;
  tags: string[];
  messages: Message[];
}

export interface CompactPlan {
  summary: string;
  keepBlockIds: string[];
  summarizeBlockIds: string[];
  dropBlockIds: string[];
}

export const COMPACT_PLAN_TOOL_DEFINITION: ToolDefinition = {
  name: COMPACT_PLAN_TOOL_NAME,
  description: 'Submit the compaction plan for older candidate blocks. Every candidate block must appear exactly once in keepBlockIds, summarizeBlockIds, or dropBlockIds. Also provide the replacement working summary that future turns should read after compaction.',
  parameters: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: 'Concise working summary for future turns. Cover all summarizeBlockIds, plus any critical context needed to understand the retained recent messages.'
      },
      keepBlockIds: {
        type: 'array',
        description: 'Older block ids to keep verbatim in working history. Use sparingly for exact instructions, unresolved tasks, or details that should remain word-for-word.',
        items: { type: 'string' }
      },
      summarizeBlockIds: {
        type: 'array',
        description: 'Older block ids that may leave working history after their important content is captured in summary.',
        items: { type: 'string' }
      },
      dropBlockIds: {
        type: 'array',
        description: 'Older block ids that can disappear from working history entirely. Archive still keeps them, so use this only for low-value or obsolete details.',
        items: { type: 'string' }
      }
    },
    required: ['summary', 'keepBlockIds', 'summarizeBlockIds', 'dropBlockIds']
  }
};

function collectBlockTags(messages: Message[]): string[] {
  const tags = new Set<string>();

  for (const message of messages) {
    tags.add(message.role);
    if (message.parts?.some(part => typeof part.system === 'string')) {
      tags.add('system');
    }
    if (message.parts?.some(part => part.functionCall)) {
      tags.add('tool-call');
    }
    if (message.parts?.some(part => part.functionResponse)) {
      tags.add('tool-result');
    }
    if (message.parts?.some(part => part.inlineData || part.inlineDataRef)) {
      tags.add('inline-data');
    }
  }

  return Array.from(tags);
}

function getSeqRange(messages: Message[]): { startSeq?: number; endSeq?: number } {
  const seqs = messages
    .map(message => message.__meta?.seq)
    .filter((seq): seq is number => typeof seq === 'number' && seq > 0);

  if (seqs.length === 0) {
    return {};
  }

  return {
    startSeq: seqs[0],
    endSeq: seqs[seqs.length - 1],
  };
}

function buildBlockPreview(messages: Message[]): string {
  const previewLines = messages.slice(0, DEFAULT_PREVIEW_MESSAGE_LIMIT).map(message => {
    const seqLabel = typeof message.__meta?.seq === 'number' ? `#${message.__meta.seq} ` : '';
    const preview = formatMessagePreviewText(message, DEFAULT_PREVIEW_CHAR_LIMIT, {
      skipEphemeralSystem: true,
      skipRagMemorySnippets: true,
    }).trim();
    return `${seqLabel}${preview || '[empty message]'}`;
  });

  if (messages.length > DEFAULT_PREVIEW_MESSAGE_LIMIT) {
    const tailSeq = messages[messages.length - 1]?.__meta?.seq;
    previewLines.push(`... ${messages.length - DEFAULT_PREVIEW_MESSAGE_LIMIT} more message(s)${typeof tailSeq === 'number' ? ` through #${tailSeq}` : ''}`);
  }

  return previewLines.join('\n');
}

function buildCandidateId(index: number, startSeq?: number, endSeq?: number): string {
  if (typeof startSeq === 'number' && typeof endSeq === 'number') {
    return `block_${String(index + 1).padStart(2, '0')}_seq_${startSeq}_${endSeq}`;
  }

  return `block_${String(index + 1).padStart(2, '0')}`;
}

function shouldFlushBlock(currentMessages: Message[], currentTokens: number, nextMessage?: Message): boolean {
  if (currentMessages.length === 0) {
    return false;
  }

  const reachedSizeLimit = currentTokens >= DEFAULT_BLOCK_TOKEN_TARGET || currentMessages.length >= DEFAULT_BLOCK_MESSAGE_LIMIT;
  if (!reachedSizeLimit) {
    return false;
  }

  if (!nextMessage) {
    return true;
  }

  const currentLast = currentMessages[currentMessages.length - 1];
  if (currentLast.role === 'tool' || nextMessage.role === 'tool') {
    return false;
  }

  return true;
}

export function buildCompactCandidateBlocks(messages: Message[]): CompactCandidateBlock[] {
  const blocks: CompactCandidateBlock[] = [];
  let currentMessages: Message[] = [];
  let currentTokens = 0;

  const flush = () => {
    if (currentMessages.length === 0) {
      return;
    }

    const { startSeq, endSeq } = getSeqRange(currentMessages);
    blocks.push({
      id: buildCandidateId(blocks.length, startSeq, endSeq),
      startSeq,
      endSeq,
      messageCount: currentMessages.length,
      estimatedTokens: currentTokens,
      preview: buildBlockPreview(currentMessages),
      tags: collectBlockTags(currentMessages),
      messages: currentMessages,
    });

    currentMessages = [];
    currentTokens = 0;
  };

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    currentMessages.push(message);
    currentTokens += estimateMessageTokens(message);

    if (shouldFlushBlock(currentMessages, currentTokens, messages[index + 1])) {
      flush();
    }
  }

  flush();
  return blocks;
}

export function formatSeqRange(startSeq?: number, endSeq?: number): string {
  if (typeof startSeq === 'number' && typeof endSeq === 'number') {
    return startSeq === endSeq ? `#${startSeq}` : `#${startSeq}-#${endSeq}`;
  }
  if (typeof startSeq === 'number') {
    return `#${startSeq}-?`;
  }
  if (typeof endSeq === 'number') {
    return `?-#${endSeq}`;
  }
  return '(seq unavailable)';
}

export function buildCompactPromptText(options: {
  forcedKeptCount: number;
  forcedKeptStartSeq?: number;
  forcedKeptEndSeq?: number;
  candidateBlocks: CompactCandidateBlock[];
}): string {
  const { forcedKeptCount, forcedKeptStartSeq, forcedKeptEndSeq, candidateBlocks } = options;
  const lines: string[] = [
    'COMPACTION STARTED: stop any previous task and focus only on compaction.',
    `Recent messages ${forcedKeptCount > 0 ? `(${forcedKeptCount} message(s), ${formatSeqRange(forcedKeptStartSeq, forcedKeptEndSeq)})` : '(none)'} are already force-kept verbatim by the system. Do not spend block selections on them.`,
    `Review the older candidate blocks below and respond by calling ${COMPACT_PLAN_TOOL_NAME}. Do not answer with plain text only.`,
    'Rules:',
    '- Every candidate block id must appear exactly once in keepBlockIds, summarizeBlockIds, or dropBlockIds.',
    '- Use keepBlockIds only for older content that must stay verbatim in working history.',
    '- Use summarizeBlockIds for older content whose important information should survive only through the summary.',
    '- Use dropBlockIds only for low-value older content that can leave working history. Archive still keeps everything.',
    '- The summary should be concise but sufficient for future turns to continue work safely.',
    '',
    'Older compact candidates:',
  ];

  for (const block of candidateBlocks) {
    lines.push([
      `- ${block.id}`,
      `  seqRange: ${formatSeqRange(block.startSeq, block.endSeq)}`,
      `  messageCount: ${block.messageCount}`,
      `  estimatedTokens: ${block.estimatedTokens}`,
      `  tags: ${block.tags.join(', ') || '(none)'}`,
      '  preview:',
      ...block.preview.split('\n').map(line => `    ${line}`),
    ].join('\n'));
  }

  return lines.join('\n');
}

function normalizeStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of block ids.`);
  }

  return value.map((item, index) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`${fieldName}[${index}] must be a non-empty string.`);
    }
    return item.trim();
  });
}

export function validateCompactPlanArgs(rawArgs: Record<string, any>, candidateBlocks: CompactCandidateBlock[]): CompactPlan {
  const summary = typeof rawArgs?.summary === 'string' ? rawArgs.summary.trim() : '';
  if (!summary) {
    throw new Error('Compaction plan summary is empty.');
  }
  if (summary.startsWith('Error:')) {
    throw new Error(`Compaction plan summary failed: ${summary}`);
  }

  const keepBlockIds = normalizeStringArray(rawArgs?.keepBlockIds, 'keepBlockIds');
  const summarizeBlockIds = normalizeStringArray(rawArgs?.summarizeBlockIds, 'summarizeBlockIds');
  const dropBlockIds = normalizeStringArray(rawArgs?.dropBlockIds, 'dropBlockIds');

  const knownIds = new Set(candidateBlocks.map(block => block.id));
  const seenIds = new Set<string>();

  for (const blockId of [...keepBlockIds, ...summarizeBlockIds, ...dropBlockIds]) {
    if (!knownIds.has(blockId)) {
      throw new Error(`Compaction plan referenced unknown block id: ${blockId}`);
    }
    if (seenIds.has(blockId)) {
      throw new Error(`Compaction plan assigned the same block more than once: ${blockId}`);
    }
    seenIds.add(blockId);
  }

  if (seenIds.size !== candidateBlocks.length) {
    const missing = candidateBlocks
      .map(block => block.id)
      .filter(blockId => !seenIds.has(blockId));
    throw new Error(`Compaction plan did not classify every block. Missing: ${missing.join(', ')}`);
  }

  return {
    summary,
    keepBlockIds,
    summarizeBlockIds,
    dropBlockIds,
  };
}

export function describeBlockRanges(blocks: CompactCandidateBlock[], blockIds: string[]): string {
  if (blockIds.length === 0) {
    return 'none';
  }

  const blockMap = new Map(blocks.map(block => [block.id, block]));
  return blockIds
    .map(blockId => {
      const block = blockMap.get(blockId);
      if (!block) {
        return blockId;
      }
      return `${blockId} (${formatSeqRange(block.startSeq, block.endSeq)})`;
    })
    .join(', ');
}
