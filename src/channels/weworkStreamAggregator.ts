import crypto from 'crypto';
import type { ChannelTurnProgress, ChannelTurnToolStatus } from '../types';

export type WeWorkStreamDelivery = {
  mode: 'webhook' | 'websocket';
  responseUrl?: string;
  reqId?: string;
};

export type WeWorkStreamAppendOptions = {
  finish?: boolean;
  replaceLast?: boolean;
  label?: string;
};

export type WeWorkStreamSnapshot = {
  conversationId: string;
  streamId: string;
  content: string;
  finish: boolean;
  delivery: WeWorkStreamDelivery;
  updatedAt: number;
};

type WeWorkStreamTextBlock = {
  type: 'text';
  text: string;
};

type WeWorkStreamToolEntry = {
  id: string;
  name: string;
  status: ChannelTurnToolStatus;
};

type WeWorkStreamToolGroupBlock = {
  type: 'toolGroup';
  tools: WeWorkStreamToolEntry[];
  thinking: boolean;
};

type WeWorkStreamBlock = WeWorkStreamTextBlock | WeWorkStreamToolGroupBlock;

type WeWorkStreamState = WeWorkStreamSnapshot & {
  blocks: WeWorkStreamBlock[];
};

export type WeWorkStreamAggregatorOptions = {
  maxContentBytes?: number;
  ttlMs?: number;
};

const DEFAULT_EMPTY_FINAL_CONTENT = '处理完成。';
const THINKING_LABEL = '🤔 thinking';
export const WEWORK_STREAM_CONTENT_BYTE_LIMIT = 20480;
// WeWork stream.content limit is documented as 20480 bytes. Keep a little room
// for the truncation marker so UTF-8 byte length remains below the platform cap.
export const DEFAULT_WEWORK_STREAM_MAX_CONTENT_BYTES = 20000;
export const DEFAULT_WEWORK_STREAM_TTL_MS = 15 * 60 * 1000;

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || utf8ByteLength(value) <= maxBytes) {
    return value;
  }

  const suffix = '\n\n…[内容过长，已截断]';
  const suffixBytes = utf8ByteLength(suffix);
  const budget = Math.max(0, maxBytes - suffixBytes);
  let used = 0;
  let output = '';

  for (const char of value) {
    const bytes = utf8ByteLength(char);
    if (used + bytes > budget) {
      break;
    }
    output += char;
    used += bytes;
  }

  return output + suffix;
}

function makeStreamId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return `fw_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  }
  return `fw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatTextBlock(text: string, label?: string): string {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return '';
  }
  const normalizedLabel = typeof label === 'string' ? label.trim() : '';
  return normalizedLabel ? `**${normalizedLabel}**\n${trimmed}` : trimmed;
}

function formatToolStatusIcon(status: ChannelTurnToolStatus): string {
  if (status === 'success') return '☑️';
  if (status === 'error') return '❌';
  return '⌛️';
}

function formatToolGroup(block: WeWorkStreamToolGroupBlock): string {
  const items = block.tools.map(tool => `${formatToolStatusIcon(tool.status)} ${tool.name || 'tool'}`);
  if (block.thinking) {
    items.push(THINKING_LABEL);
  }
  return items.length > 0 ? `> ${items.join(' | ')}` : '';
}

export class WeWorkStreamAggregator {
  private readonly maxContentBytes: number;
  private readonly ttlMs: number;
  private readonly byConversation = new Map<string, WeWorkStreamState>();
  private readonly byStreamId = new Map<string, WeWorkStreamState>();

  constructor(options: WeWorkStreamAggregatorOptions = {}) {
    const requestedMaxBytes = options.maxContentBytes || DEFAULT_WEWORK_STREAM_MAX_CONTENT_BYTES;
    this.maxContentBytes = Math.min(Math.max(1, requestedMaxBytes), WEWORK_STREAM_CONTENT_BYTE_LIMIT);
    this.ttlMs = Math.max(1, options.ttlMs || DEFAULT_WEWORK_STREAM_TTL_MS);
  }

  begin(conversationId: string, delivery: WeWorkStreamDelivery, streamId: string = makeStreamId()): WeWorkStreamSnapshot {
    this.cleanupExpired();
    const normalizedConversationId = String(conversationId || '').trim();
    if (!normalizedConversationId) {
      throw new Error('conversationId is required to begin a WeWork stream');
    }

    const now = Date.now();
    const state: WeWorkStreamState = {
      conversationId: normalizedConversationId,
      streamId,
      content: '',
      finish: false,
      delivery,
      updatedAt: now,
      blocks: [{ type: 'toolGroup', tools: [], thinking: true }],
    };
    state.content = this.renderContent(state);
    this.byConversation.set(normalizedConversationId, state);
    this.byStreamId.set(streamId, state);
    return this.toSnapshot(state);
  }

  append(conversationId: string, text: string, options: WeWorkStreamAppendOptions = {}): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byConversation.get(String(conversationId || '').trim());
    return this.appendToState(state, text, options);
  }

  appendByStreamId(streamId: string, text: string, options: WeWorkStreamAppendOptions = {}): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byStreamId.get(String(streamId || '').trim());
    return this.appendToState(state, text, options);
  }

  applyProgressByStreamId(streamId: string, progress: ChannelTurnProgress): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byStreamId.get(String(streamId || '').trim());
    if (!state || state.finish) {
      return undefined;
    }

    this.applyProgressToState(state, progress);
    state.content = this.renderContent(state);
    state.updatedAt = Date.now();
    return this.toSnapshot(state);
  }

  private appendToState(state: WeWorkStreamState | undefined, text: string, options: WeWorkStreamAppendOptions = {}): WeWorkStreamSnapshot | undefined {
    if (!state) {
      return undefined;
    }
    if (state.finish) {
      return undefined;
    }

    const section = formatTextBlock(text, options.label);
    if (section) {
      this.clearThinking(state);
      if (options.replaceLast) {
        const lastTextBlock = [...state.blocks].reverse().find(block => block.type === 'text') as WeWorkStreamTextBlock | undefined;
        if (lastTextBlock) {
          lastTextBlock.text = section;
        } else {
          state.blocks.push({ type: 'text', text: section });
        }
      } else {
        state.blocks.push({ type: 'text', text: section });
      }
    }

    if (options.finish) {
      this.clearThinking(state);
      state.finish = true;
    }

    state.content = this.renderContent(state);
    state.updatedAt = Date.now();
    return this.toSnapshot(state);
  }

  finish(conversationId: string): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byConversation.get(String(conversationId || '').trim());
    return this.finishState(state);
  }

  finishByStreamId(streamId: string): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byStreamId.get(String(streamId || '').trim());
    return this.finishState(state);
  }

  private finishState(state: WeWorkStreamState | undefined): WeWorkStreamSnapshot | undefined {
    if (!state) {
      return undefined;
    }
    this.clearThinking(state);
    state.finish = true;
    state.content = this.renderContent(state);
    state.updatedAt = Date.now();
    return this.toSnapshot(state);
  }

  getByConversation(conversationId: string): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byConversation.get(String(conversationId || '').trim());
    return state ? this.toSnapshot(state) : undefined;
  }

  getByStreamId(streamId: string): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byStreamId.get(String(streamId || '').trim());
    return state ? this.toSnapshot(state) : undefined;
  }

  hasActive(conversationId: string): boolean {
    this.cleanupExpired();
    const state = this.byConversation.get(String(conversationId || '').trim());
    return !!state && !state.finish;
  }

  cleanupExpired(now: number = Date.now()): number {
    let removed = 0;
    for (const [streamId, state] of Array.from(this.byStreamId.entries())) {
      if (now - state.updatedAt <= this.ttlMs) {
        continue;
      }
      this.byStreamId.delete(streamId);
      if (this.byConversation.get(state.conversationId) === state) {
        this.byConversation.delete(state.conversationId);
      }
      removed++;
    }
    return removed;
  }

  private getCurrentToolGroup(state: WeWorkStreamState, create: boolean): WeWorkStreamToolGroupBlock | undefined {
    const lastBlock = state.blocks[state.blocks.length - 1];
    if (lastBlock?.type === 'toolGroup') {
      return lastBlock;
    }
    if (!create) {
      return undefined;
    }
    const block: WeWorkStreamToolGroupBlock = { type: 'toolGroup', tools: [], thinking: false };
    state.blocks.push(block);
    return block;
  }

  private clearThinking(state: WeWorkStreamState): void {
    state.blocks = state.blocks.filter(block => {
      if (block.type !== 'toolGroup') {
        return true;
      }
      block.thinking = false;
      return block.tools.length > 0;
    });
  }

  private findTool(state: WeWorkStreamState, id: string): WeWorkStreamToolEntry | undefined {
    for (const block of state.blocks) {
      if (block.type !== 'toolGroup') continue;
      const tool = block.tools.find(entry => entry.id === id);
      if (tool) return tool;
    }
    return undefined;
  }

  private applyProgressToState(state: WeWorkStreamState, progress: ChannelTurnProgress): void {
    if (progress.type === 'llm-start') {
      const group = this.getCurrentToolGroup(state, true);
      if (group) {
        group.thinking = true;
      }
      return;
    }

    if (progress.type === 'tool-calls-start') {
      this.clearThinking(state);
      const text = typeof progress.text === 'string' ? formatTextBlock(progress.text) : '';
      if (text) {
        state.blocks.push({ type: 'text', text });
      }
      const group = this.getCurrentToolGroup(state, true);
      if (!group) return;
      for (const call of progress.calls || []) {
        if (!call.id) continue;
        const existing = this.findTool(state, call.id);
        if (existing) {
          existing.name = call.name || existing.name;
          existing.status = 'running';
          continue;
        }
        group.tools.push({ id: call.id, name: call.name || 'tool', status: 'running' });
      }
      return;
    }

    if (progress.type === 'tool-calls-finish') {
      const group = this.getCurrentToolGroup(state, true);
      for (const result of progress.results || []) {
        if (!result.id) continue;
        const existing = this.findTool(state, result.id);
        if (existing) {
          existing.name = result.name || existing.name;
          existing.status = result.status;
          continue;
        }
        group?.tools.push({ id: result.id, name: result.name || 'tool', status: result.status });
      }
    }
  }

  private renderContent(state: WeWorkStreamState): string {
    const raw = state.blocks
      .map(block => block.type === 'text' ? block.text : formatToolGroup(block))
      .filter(Boolean)
      .join('\n\n');
    return truncateUtf8(raw || (state.finish ? DEFAULT_EMPTY_FINAL_CONTENT : `> ${THINKING_LABEL}`), this.maxContentBytes);
  }

  private toSnapshot(state: WeWorkStreamState): WeWorkStreamSnapshot {
    return {
      conversationId: state.conversationId,
      streamId: state.streamId,
      content: state.content,
      finish: state.finish,
      delivery: { ...state.delivery },
      updatedAt: state.updatedAt,
    };
  }
}

export function buildWeWorkStreamResponse(snapshot: WeWorkStreamSnapshot): any {
  return {
    msgtype: 'stream',
    stream: {
      id: snapshot.streamId,
      finish: snapshot.finish,
      content: snapshot.content,
    },
  };
}
